import { buildSystemPrompt } from "../protocol.ts";
import { ProviderTimeoutError } from "../types.ts";
import { conversationCalendar, conversationTimeZone } from "./conversation-clock.ts";
import type { AgentEnv, Message, Provider, Tool } from "../types.ts";

export type OriginMessage = { role: "system" | "user" | "assistant"; content: string };
export type OriginVariant = "baseline" | "candidate";

/** Both curated SFT and inference use this exact prompt representation. */
export function originMessages(messages: Message[], tools: Tool[], env: AgentEnv): OriginMessage[] {
  return [
    { role: "system", content: buildSystemPrompt(tools, env) },
    ...messages.map((message): OriginMessage => message.role === "tool"
      ? { role: "user", content: env.researchAnswerOnly
        ? `[参考資料]\n${message.content}`
        : `[あなたが呼び出した ${message.toolName} の出力]\n${message.content}\n\nこの結果を踏まえ、必要ならツールを呼んで作業を続けてください。` }
      : { role: message.role, content: message.content }),
  ];
}

export function originHost(host = process.env.ORIGIN_MODEL_HOST ?? "http://127.0.0.1:18080"): string {
  const url = new URL(host);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Origin Model の接続先はローカル HTTP サーバーのルート URL を指定してください。");
  }
  return url.origin;
}

export function createOriginProvider(opts: { variant?: string; host?: string; timeoutMs?: number; conversationOnly?: boolean; timeZone?: string; now?: () => Date } = {}): Provider {
  const variant = opts.variant ?? "candidate";
  if (variant !== "baseline" && variant !== "candidate") throw new Error("origin の --model は baseline または candidate です。");
  const host = originHost(opts.host);
  const timeZone = opts.conversationOnly ? conversationTimeZone(opts.timeZone) : "UTC";
  const timeout = opts.timeoutMs ?? Number(process.env.ORIGIN_MODEL_TIMEOUT_MS ?? 120_000);
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Origin Model の待ち時間は正のミリ秒で指定してください。");
  return {
    name: `origin:${variant}`,
    contextBudget: 4000,
    async complete(messages, tools, env, callbacks = {}) {
      if (opts.conversationOnly && (env.mode !== "chat" || tools.length > 0 || messages.some((message) => message.role === "tool"))) {
        throw new Error("会話専用の Origin Model にはユーザーとアシスタントの会話だけを渡してください。");
      }
      // A tool-free conversation must not advertise search, CLI commands or tool syntax.
      // Keep the coding/SFT representation unchanged.
      const requestMessages: OriginMessage[] = opts.conversationOnly ? [
        { role: "system", content: "You are Origin, a helpful assistant. Respond in natural Japanese, usually in 2-3 sentences. Answer the user directly. For greetings, return a brief friendly greeting. Never repeat the user's question or ask about their abilities. Your capabilities are writing, summarizing, explanations, and suggesting code fixes. You can only reply with text; you cannot browse the web, run code, or access files. Do not claim otherwise. Use conversation history to answer about the user. When a code edit fails, preserve existing changes, inspect the error and current code, propose a minimal fix, and check it with tests; do not blindly restore old versions. Admit uncertainty." },
        ...messages.map((message) => ({ role: message.role as "user" | "assistant", content: message.content })),
      ] : originMessages(messages, tools, env);
      if (opts.conversationOnly) {
        requestMessages[0]!.content += "\n\n" + conversationCalendar(opts.now?.() ?? new Date(), timeZone);
      }
      const started = performance.now();
      let response: Response;
      let raw: string;
      const signal = AbortSignal.timeout(timeout);
      try {
        response = await fetch(`${host}/v1/completions`, {
          method: "POST", redirect: "error", headers: { "content-type": "application/json" },
          body: JSON.stringify({ variant, messages: requestMessages }),
          signal,
        });
        raw = await response.text();
      } catch (error) {
        if (signal.aborted || (error as Error).name === "TimeoutError") throw new ProviderTimeoutError(`Origin Model の応答が ${Math.round(timeout / 1000)} 秒以内に返りませんでした。`);
        throw new Error(`Origin Model に接続できません (${host})。training/scripts/serve-model.py でローカルモデルを起動してください。`);
      }
      if (!response.ok) throw new Error(`Origin Model HTTP ${response.status}。サーバーのログとモデル設定を確認してください。`);
      if (raw.length > 1_000_000) throw new Error("Origin Model の応答が長すぎます。");
      let data: { text?: unknown; finish_reason?: unknown; variant?: unknown; prompt_tokens?: number; output_tokens?: number; elapsed_ms?: number };
      try { data = JSON.parse(raw) as typeof data; }
      catch { throw new Error("Origin Model の応答が JSON ではありません。"); }
      if (!data || data.variant !== variant || typeof data.text !== "string" || !data.text.trim()) throw new Error("Origin Model の応答形式・モデル種別が不正です。");
      if (data.finish_reason === "timeout") throw new ProviderTimeoutError("Origin Model が生成中に時間切れになりました。未完了の出力は採用していません。");
      if (data.finish_reason !== "eos") throw new Error("Origin Model が生成上限で終了しました。未完了の出力は採用していません。");
      callbacks.onText?.(data.text);
      callbacks.onStats?.({ elapsedMs: performance.now() - started, promptTokens: data.prompt_tokens, outputTokens: data.output_tokens, generationMs: data.elapsed_ms });
      return data.text;
    },
  };
}
