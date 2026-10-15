// Claude（Anthropic API）を頭脳として使う。認証情報（ANTHROPIC_API_KEY など）が必要で、利用量に応じて課金される。
//
// Provider の差込口は「<tool> ブロック入りのテキストを返す」形のまま変えない。中では Claude の
// ネイティブなツール呼び出しを使い、返ってきた tool_use を <tool> ブロックに書き直して Agent へ渡す。
// Agent・ツール・採点は、ローカルモデルと同じものをそのまま使い回せる。
//
// 会話履歴は Agent が Message[]（テキスト）で持っているので、毎回 API の形へ組み直す。
// ただし Claude 自身が返した手番は、思考ブロックやツール呼び出しの ID を含む元の形のまま送り返す。
// 前の手番の考えを引き継げ、プロンプトキャッシュも効くから。

import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt, formatToolCall, parseToolCalls } from "../protocol.ts";
import { ProviderTimeoutError } from "../types.ts";
import type { AgentEnv, CompletionOptions, Message, Provider, Tool } from "../types.ts";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentParam = Anthropic.Beta.BetaContentBlockParam;
type ResponseBlock = Anthropic.Beta.BetaContentBlock;
type ResponseMessage = Anthropic.Beta.BetaMessage;
export type ClaudeRequest = Parameters<Anthropic["beta"]["messages"]["stream"]>[0];

export const CLAUDE_MODEL = "claude-opus-5-5";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];

/** 思考とツール引数の両方がこの中に収まる。長いファイルを書く手番でも切れにくい大きさ。 */
const MAX_TOKENS = 64_000;

/**
 * Agent が履歴を書き換えた（回答に出典を足した、言い直しを求めて回答を外した等）後の思考ブロックは、
 * API の検査で「別の会話のもの」と判定される。400 で止めずに、その思考ブロックだけ捨てさせる。
 */
const THINKING_BETA = "thinking-binding-controls-2026-08-01";
/** 安全分類器が断った依頼を、Anthropic が推奨する別モデルで自動的にやり直す。 */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
/** fallbacks: "default" を付けられるモデル。対応していないモデルに付けると要求ごと拒否される。 */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-fable-5", "claude-sonnet-5-5"]);

/** 保存しておく Claude の手番の数。長い作業でもメモリを使い続けないための上限。 */
const REPLAY_LIMIT = 200;

/** SDK のストリームのうち、ここで使う部分だけ。テストでは偽物に差し替える。 */
export type ClaudeStream = {
  onText: (listener: (text: string) => void) => void;
  finalMessage: () => Promise<ResponseMessage>;
};
export type ClaudeTransport = (request: ClaudeRequest) => ClaudeStream;

function sdkTransport(): ClaudeTransport {
  let client: Anthropic | undefined;
  return (request) => {
    // 認証情報は ANTHROPIC_API_KEY・ANTHROPIC_AUTH_TOKEN・`ant auth login` のプロファイルの順に SDK が探す。
    client ??= new Anthropic();
    const stream = client.beta.messages.stream(request);
    return {
      onText: (listener) => { stream.on("text", (delta) => listener(delta)); },
      finalMessage: () => stream.finalMessage(),
    };
  };
}

/** auto の選択で Claude を使うか。環境変数で明示された認証情報があるときだけ。 */
export function hasClaudeCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim());
}

function effortSetting(value: string | undefined): Effort | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  if ((EFFORTS as readonly string[]).includes(value.trim())) return value.trim() as Effort;
  throw new Error(`ORIGIN_CLAUDE_EFFORT は ${EFFORTS.join(" / ")} のどれかを指定してください（指定値: ${value}）。`);
}

/**
 * Tool の引数定義を JSON Schema にする。json 型は値の種類を問わない。
 *
 * eager_input_streaming は付けない。付けると API が引数の JSON を検査しなくなり、
 * 引用符の崩れた引数が「途中で終わった文字列」として通ってしまう。ファイルを書き換えるツールでは危ない。
 * ツールの引数を画面に流して見せることもしないので、付けても速さの得はほぼない。
 */
export function claudeTool(tool: Tool): Anthropic.Beta.BetaTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: "object",
      properties: Object.fromEntries(tool.params.map((param) => [param.name, param.type === "json"
        ? { description: param.description }
        : { type: param.type, description: param.description }])),
      required: tool.params.filter((param) => param.required).map((param) => param.name),
    },
  };
}

/** 本文に書かれた <tool> を、Agent がツール呼び出しと読み違えないようにする（ゼロ幅スペースを挟む）。 */
function inert(text: string): string {
  return text.replace(/<(\/?)tool\b/gi, "<$1​tool");
}

function toolInput(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

/** 応答を Agent に渡すテキストにする。tool_use は <tool> ブロックに書き直す。 */
export function renderResponse(content: ResponseBlock[]): { text: string; toolCalls: number; switched: boolean } {
  // 回答の途中で別モデルへ切り替わった場合、切り替え前の tool_use は途中で断られたものなので実行しない。
  // 切り替え前の本文は、切り替え後のモデルが続きを書く前提になっているので残す。
  const boundary = content.map((block) => block.type).lastIndexOf("fallback");
  const parts: string[] = [];
  let toolCalls = 0;
  content.forEach((block, index) => {
    if (block.type === "text") parts.push(inert(block.text));
    else if (block.type === "tool_use" && index > boundary) {
      parts.push(formatToolCall(block.name, toolInput(block.input), { escapeMarkup: true }));
      toolCalls++;
    }
  });
  return { text: parts.join("\n\n").trim(), toolCalls, switched: boundary >= 0 };
}

type ConvertOptions = {
  /** Claude が返した手番の元の形。キーは Agent に返したテキスト。 */
  replays?: Map<string, ContentParam[]>;
  /** この要求でツールを渡すか。渡さない要求の履歴には tool_use を含められない。 */
  toolsDeclared: boolean;
  /** 調べものの回答段階。ツールの出力は参考資料として渡す。 */
  answerOnly?: boolean;
};

function assistantContent(text: string, index: number, replayable: boolean, options: ConvertOptions): ContentParam[] {
  const replay = replayable ? options.replays?.get(text) : undefined;
  if (replay && (options.toolsDeclared || !replay.some((block) => block.type === "tool_use"))) return replay;
  const { calls, say } = parseToolCalls(text);
  if (!options.toolsDeclared) {
    const described = calls.map((call) => `（${call.name} を呼び出しました: ${JSON.stringify(call.args).slice(0, 300)}）`);
    const body = [say, ...described].filter(Boolean).join("\n");
    return body ? [{ type: "text", text: body }] : [];
  }
  // Agent が自分で差し込んだ呼び出し（/search や失敗テストの再実行など）。ID は位置から決める。
  // 毎回同じ ID になるので、次の要求でも履歴の先頭部分が変わらずキャッシュが効く。
  return [
    ...(say ? [{ type: "text" as const, text: say }] : []),
    ...calls.map((call, n) => ({ type: "tool_use" as const, id: `origin_${index}_${n}`, name: call.name, input: call.args })),
  ];
}

/** Agent の会話履歴（テキスト）を API の messages にする。 */
export function claudeMessages(messages: Message[], options: ConvertOptions): MessageParam[] {
  const out: MessageParam[] = [];
  // 同じテキストの手番は何度も現れる（npm test を繰り返す等）。保存した元の形は最新の応答のものなので、
  // 最後に現れた手番にだけ使う。全部に使うとツール呼び出しの ID が重複し、API が要求を拒否する。
  const lastSeen = new Map<string, number>();
  messages.forEach((message, index) => { if (message.role === "assistant") lastSeen.set(message.content, index); });
  let open: Array<{ id: string; name: string }> = [];
  let results: ContentParam[] = [];
  let notes: ContentParam[] = [];
  const closeUserTurn = () => {
    // 実行されなかった呼び出し（同じ呼び出しの繰り返しで中断した等）にも結果を返す。返さないと API が拒否する。
    for (const call of open) {
      results.push({ type: "tool_result", tool_use_id: call.id, content: "このツール呼び出しは実行されませんでした。", is_error: true });
    }
    open = [];
    // tool_result は user メッセージの先頭に並べる決まり。ユーザーの発言や補足はその後ろに置く。
    if (results.length > 0 || notes.length > 0) out.push({ role: "user", content: [...results, ...notes] });
    results = [];
    notes = [];
  };

  messages.forEach((message, index) => {
    if (message.role === "user") {
      notes.push({ type: "text", text: message.content || "（空の発言）" });
      return;
    }
    if (message.role === "tool") {
      const at = open.findIndex((call) => call.name === message.toolName);
      if (at >= 0) {
        const [call] = open.splice(at, 1);
        results.push({ type: "tool_result", tool_use_id: call!.id, content: message.content || "（出力なし）" });
      } else {
        // 呼び出しと対にならない出力（Agent が足したテストの確認や、回答の見直しの指示）は補足の文として渡す。
        const label = options.answerOnly ? "[参考資料]" : `[${message.toolName ?? "tool"} の出力]`;
        notes.push({ type: "text", text: `${label}\n${message.content}` });
      }
      return;
    }
    const content = assistantContent(message.content, index, lastSeen.get(message.content) === index, options);
    if (content.length === 0) return;
    closeUserTurn();
    out.push({ role: "assistant", content });
    open = content.flatMap((block) => block.type === "tool_use" ? [{ id: block.id, name: block.name }] : []);
  });
  closeUserTurn();

  // 最初と最後は user でなければならない（Opus 5.5 は assistant の書き出しを指定する要求を受け付けない）。
  if (out[0]?.role !== "user") out.unshift({ role: "user", content: "（ここまでの会話の続きです）" });
  if (out.at(-1)?.role !== "user") out.push({ role: "user", content: "続けてください。" });
  return out;
}

function withoutThinking(messages: MessageParam[]): MessageParam[] {
  return messages
    .map((message) => typeof message.content === "string" ? message : {
      ...message,
      content: message.content.filter((block) => block.type !== "thinking" && block.type !== "redacted_thinking"),
    })
    .filter((message) => typeof message.content === "string" || message.content.length > 0);
}

function isThinkingRejection(error: unknown): boolean {
  return error instanceof Anthropic.BadRequestError && /thinking|signature/i.test(error.message);
}

/** SDK の例外を、何をすればよいか分かる日本語に直す。種類の細かいものから順に判定する。 */
function explain(error: unknown, model: string): Error {
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new ProviderTimeoutError(`Claude (${model}) の応答が時間内に返りませんでした。`);
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return new Error("Claude の認証に失敗しました。ANTHROPIC_API_KEY が正しいか確認してください。");
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return new Error(`この API キーでは ${model} を使えません。キーの権限か --model の指定を確認してください。`);
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new Error(`モデル ${model} が見つかりません。--model の指定を確認してください。`);
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new Error("Claude の利用上限（レート制限）に達しました。少し待ってから再試行してください。");
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new Error(`Claude に接続できません。ネットワークを確認してください。\n詳細: ${error.message}`);
  }
  if (error instanceof Anthropic.APIError) {
    return new Error(`Claude API エラー (${error.status ?? "通信"}): ${error.message}`);
  }
  if (error instanceof Anthropic.AnthropicError) {
    return new Error(
      `Claude を使えません: ${error.message}\n` +
      "ANTHROPIC_API_KEY を設定するか、`ant auth login` でログインしてください。",
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

export function createClaudeProvider(
  opts: { model?: string; effort?: Effort; transport?: ClaudeTransport } = {},
): Provider {
  const model = opts.model ?? CLAUDE_MODEL;
  const fixedEffort = opts.effort ?? effortSetting(process.env.ORIGIN_CLAUDE_EFFORT);
  const transport = opts.transport ?? sdkTransport();
  const fallbacks = FALLBACK_MODELS.has(model);
  const replays = new Map<string, ContentParam[]>();

  const remember = (text: string, content: ResponseBlock[]) => {
    replays.delete(text);
    replays.set(text, content as ContentParam[]);
    if (replays.size > REPLAY_LIMIT) replays.delete(replays.keys().next().value!);
  };

  return {
    name: `claude:${model}`,
    // 文脈は100万トークンあるが、毎回すべてを送るので料金は履歴の長さに比例する。日本語とコードで約40万文字。
    contextBudget: 400_000,
    // 「読む → 直す → テストする」を何周もできる長さ。暴走したときの課金の上限も兼ねる。
    maxSteps: 50,
    async complete(messages: Message[], tools: Tool[], env: AgentEnv, callbacks: CompletionOptions = {}) {
      const started = performance.now();
      const answerOnly = env.researchAnswerOnly === true;
      // コード作業は深く考える価値がある。会話・調べものの回答・言い換えは標準の深さで十分。
      const effort = fixedEffort ?? (env.mode === "code" && !answerOnly ? "high" : "medium");
      const request: ClaudeRequest = {
        model,
        max_tokens: MAX_TOKENS,
        system: buildSystemPrompt(tools, env, { nativeTools: true }),
        messages: claudeMessages(messages, { replays, toolsDeclared: tools.length > 0, answerOnly }),
        ...(tools.length > 0 ? { tools: tools.map(claudeTool) } : {}),
        thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
        output_config: { effort },
        // 履歴の先頭から最後のブロックまでをキャッシュする。ツールを使う手番ごとに前回までの分が安く読める。
        cache_control: { type: "ephemeral" },
        ...(fallbacks ? { fallbacks: "default" as const } : {}),
        betas: fallbacks ? [THINKING_BETA, FALLBACK_BETA] : [THINKING_BETA],
      };

      let firstTokenMs: number | undefined;
      const send = async (body: ClaudeRequest): Promise<ResponseMessage> => {
        const stream = transport(body);
        stream.onText((text) => {
          firstTokenMs ??= performance.now() - started;
          callbacks.onText?.(text);
        });
        return await stream.finalMessage();
      };

      let message: ResponseMessage;
      try {
        try {
          message = await send(request);
        } catch (error) {
          if (!isThinkingRejection(error)) throw error;
          // 送り返した思考ブロックを API が受け付けなかった。思考ブロックを外して一度だけやり直す。
          message = await send({ ...request, messages: withoutThinking(request.messages) });
        }
      } catch (error) {
        throw explain(error, model);
      }

      // 断られた応答の content は空か途中まで。途中のツール呼び出しを実行してはいけない。
      if (message.stop_reason === "refusal") {
        const category = message.stop_details?.category;
        throw new Error(`Claude がこの依頼への回答を断りました${category ? `（分類: ${category}）` : ""}。依頼の書き方を変えて試してください。`);
      }
      const { text, toolCalls, switched } = renderResponse(message.content);
      const cut = message.stop_reason === "max_tokens" || message.stop_reason === "model_context_window_exceeded";
      if (cut && toolCalls > 0) {
        // 引数が途中で切れても JSON としては読めてしまうことがある。中途半端な内容でファイルを書き換えない。
        throw new Error("Claude の出力が上限に達し、ツールの引数が途中で切れました。実行していません。依頼を小さく分けてください。");
      }
      if (!text) {
        throw new Error(cut
          ? "Claude の出力が上限に達し、回答を書く前に止まりました。依頼を小さく分けてください。"
          : "Claude が空の回答を返しました。もう一度試してください。");
      }
      const answer = cut ? `${text}\n\n（出力の上限に達したため、回答は途中で切れています）` : text;
      if (answer && !cut && !switched) remember(answer, message.content);

      const usage = message.usage;
      callbacks.onStats?.({
        elapsedMs: performance.now() - started,
        firstTokenMs,
        promptTokens: usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
        outputTokens: usage.output_tokens,
      });
      return answer;
    },
  };
}
