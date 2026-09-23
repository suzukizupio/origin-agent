// ローカルLLM を頭脳として使う。ollama serve が動いている必要がある。
//
// このファイルの存在理由は「ollama が使えること」ではなく、
// Provider 型が rule プロバイダ専用になっていないことの証明。
// 自作モデルを繋ぐときも、書くのはこれと同じ形の 40 行で済む。

import { buildSystemPrompt } from "../protocol.ts";
import { ProviderTimeoutError } from "../types.ts";
import type { AgentEnv, CompletionOptions, CompletionStats, Provider, Tool, Message } from "../types.ts";

type OllamaChatResponse = {
  message?: { content?: string };
  error?: string;
  done?: boolean;
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
};

/** UTF-8やJSONが通信の途中で分割されても、1行ずつ復元する。 */
async function readStream(response: Response, accept: (data: OllamaChatResponse) => void): Promise<void> {
  if (!response.body) throw new Error("Ollama の応答本文がありません。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let completed = false;
  const line = (text: string) => {
    if (!text.trim()) return;
    let data: OllamaChatResponse;
    try { data = JSON.parse(text) as OllamaChatResponse; }
    catch { throw new Error("Ollama のストリームに不正なJSONが含まれています。"); }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Ollama の応答形式が不正です。");
    accept(data);
    completed = data.done === true;
  };
  try {
    while (!completed) {
      const { value, done } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (pending.length > 1_000_000) throw new Error("Ollama の応答行が長すぎます。");
      let newline: number;
      while (!completed && (newline = pending.indexOf("\n")) >= 0) {
        line(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
      if (done) {
        if (!completed && pending.trim()) line(pending);
        break;
      }
    }
    if (!completed) throw new Error("Ollama の応答が途中で途切れました。未完了の回答は履歴に保存していません。");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export const DEFAULT_MODEL = "qwen2.5-coder:3b";

export function ollamaHost(): string {
  return (process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
}

/** 自動選択ではダウンロード済みのモデルだけを使う。 */
export async function installedModels(): Promise<string[]> {
  const response = await fetch(`${ollamaHost()}/api/tags`, { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
  const data = await response.json() as { models?: Array<{ name?: unknown }> };
  return (data.models ?? []).flatMap((model) => typeof model.name === "string" ? [model.name] : []);
}

/**
 * 1回の応答を待つ上限。7B 以上を GPU なしで動かすと、長いシステムプロンプトの読み込みだけで
 * 2 分近くかかることがある。固定値だと、モデルの能力ではなく待ち時間の上限で失敗してしまい、
 * 採点で「大きいモデルほど悪い」という誤った結論になる。
 */
function requestTimeoutMs(explicit: number | undefined, answerOnly: boolean): number {
  if (explicit !== undefined) return explicit;
  const fromEnv = Number(process.env.ORIGIN_OLLAMA_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : answerOnly ? 60_000 : 120_000;
}

export function createOllamaProvider(
  opts: { model?: string; host?: string; numCtx?: number; timeoutMs?: number } = {},
): Provider {
  const model = opts.model ?? DEFAULT_MODEL;
  const host = (opts.host ?? ollamaHost()).replace(/\/+$/, "");

  // ollama の既定の文脈は 4096 トークンと狭く、超えた分は黙って捨てられる。
  // ファイルを読ませる用途では足りないので明示的に広げる。
  const numCtx = opts.numCtx ?? 8192;

  return {
    name: `ollama:${model}`,
    // 8192 トークン。日本語とコードが混ざる前提で、安全側に 1 トークン ≒ 2 文字と見る。
    // システムプロンプトとモデルの出力ぶんを引いて、会話に回せるのはこの程度。
    contextBudget: numCtx * 2 - 4_000,
    async complete(messages: Message[], tools: Tool[], env: AgentEnv, callbacks: CompletionOptions = {}) {
      const started = performance.now();
      const timeoutMs = requestTimeoutMs(opts.timeoutMs, env.researchAnswerOnly === true);
      const signal = AbortSignal.timeout(timeoutMs);
      const timeoutError = () => new ProviderTimeoutError(
        `Ollama の応答が ${Math.round(timeoutMs / 1000)} 秒以内に返りませんでした (${model})。` +
        "環境変数 ORIGIN_OLLAMA_TIMEOUT_MS（ミリ秒）で待ち時間を延ばせます。",
      );
      const body = {
        model,
        stream: callbacks.onText !== undefined,
        // repeat_penalty なしだと、行き詰まった小さいモデルが同じ段落を繰り返す
        options: { temperature: 0.2, num_ctx: numCtx,
          num_predict: env.researchAnswerOnly ? 256 : 1024, repeat_penalty: 1.15 },
        messages: [
          { role: "system", content: buildSystemPrompt(tools, env) },
          ...messages.map((m) =>
            // ollama の chat API に tool ロールを前提させない。
            // 小さいモデルほど素直な user メッセージの方が効く。
            // 「ユーザーの発言」として渡ると、小さいモデルは
            // ユーザーが作業していると誤解して手順を指示し返してくる。
            // あなたが呼んだツールの出力だ、と毎回明示する。
            m.role === "tool"
              ? {
                  role: "user",
                  content: env.researchAnswerOnly
                    ? `[参考資料]\n${m.content}`
                    : `[あなたが呼び出した ${m.toolName} の出力]\n${m.content}\n\nこの結果を踏まえ、必要ならツールを呼んで作業を続けてください。`,
                }
              : { role: m.role, content: m.content },
          ),
        ],
      };

      let res: Response;
      try {
        res = await fetch(`${host}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
      } catch (e) {
        // 待ち時間切れを「接続できない」と表示すると、インストールの問題だと誤解させる
        if ((e as Error).name === "TimeoutError") {
          throw timeoutError();
        }
        throw new Error(
          `Ollama に接続できません (${host})。` +
            `ollama をインストールし、'ollama serve' と 'ollama pull ${model}' を実行してください。\n` +
            `詳細: ${(e as Error).message}`,
        );
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as OllamaChatResponse;
        throw new Error(`Ollama エラー (${res.status}): ${data.error ?? res.statusText}`);
      }
      let raw = "";
      let firstTokenMs: number | undefined;
      let final: OllamaChatResponse = {};
      const accept = (data: OllamaChatResponse) => {
        if (data.error) throw new Error(`Ollama エラー: ${data.error}`);
        const text = data.message?.content;
        if (typeof text === "string" && text.length > 0) {
          firstTokenMs ??= performance.now() - started;
          raw += text;
          if (raw.length > 2_000_000) throw new Error("Ollama の回答が長すぎます。");
          callbacks.onText?.(text);
        }
        final = data;
      };
      try {
        if (res.headers.get("content-type")?.includes("ndjson")) await readStream(res, accept);
        else accept(await res.json() as OllamaChatResponse);
      } catch (error) {
        if (signal.aborted || (error as Error).name === "TimeoutError") throw timeoutError();
        throw error;
      }
      const content = raw.trim();
      if (!content) throw new Error("Ollama が空の回答を返しました。もう一度試してください。");
      const millis = (value: number | undefined) => value === undefined ? undefined : value / 1_000_000;
      const stats: CompletionStats = {
        elapsedMs: performance.now() - started, firstTokenMs,
        loadMs: millis(final.load_duration), promptMs: millis(final.prompt_eval_duration), generationMs: millis(final.eval_duration),
        promptTokens: final.prompt_eval_count, outputTokens: final.eval_count,
      };
      callbacks.onStats?.(stats);
      return content;
    },
  };
}
