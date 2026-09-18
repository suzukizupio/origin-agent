// origin-agent のコア型。
// このファイルだけ読めば「頭脳」「ツール」「会話」の境界が分かるようにしてある。

export type Role = "user" | "assistant" | "tool";
export type AgentMode = "chat" | "code";

export type Message = {
  role: Role;
  content: string;
  /** role === "tool" のとき、どのツールの出力かを示す */
  toolName?: string;
};

export type ToolCall = {
  name: string;
  args: Record<string, unknown>;
  /** 元のテキスト。デバッグ用 */
  raw: string;
  /** 引数のパースに失敗したときの理由 */
  error?: string;
};

export type ToolContext = {
  /** ツールがファイルを触れる範囲のルート。ここより外には出さない */
  root: string;
  /** 破壊的な操作の前に呼ばれる。false なら実行しない */
  confirm: (message: string) => Promise<boolean>;
};

export type ToolParam = {
  name: string;
  type: "string" | "number" | "boolean" | "json";
  required: boolean;
  description: string;
};

export type Tool = {
  name: string;
  description: string;
  params: ToolParam[];
  /** 破壊的な操作か。true なら実行前に confirm を通す */
  destructive?: boolean;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
};

/**
 * 「頭脳」の差し替え口。ここが本プロジェクトで一番重要な一行。
 *
 * 会話履歴とツール定義を受け取り、アシスタントの生テキストを返すだけ。
 * ツール呼び出しは OpenAI 形式の function calling ではなく、
 * テキスト中の <tool> ブロックで表現する（protocol.ts を参照）。
 *
 * なぜそうするか:
 *   native tool calling を持たない小さなモデル、そして将来の自作モデルでも、
 *   「テキストを返す」能力さえあれば同じ差込口に嵌まるから。
 *   賢いAPIに合わせて設計すると、馬鹿なモデルが挿さらなくなる。
 */
/**
 * 頭脳に渡す作業環境。
 * これがないと、モデルは最初の一手でパスを推測して外す。
 * 小さいモデルほど「地図を持たせる」効果が大きい。
 */
export type AgentEnv = {
  root: string;
  mode?: AgentMode;
  /** 作業ルート直下の見取り図 */
  outline: string;
  knowledge?: string;
  research?: boolean;
  /** 検索手順が終わり、今回の資料から回答する段階。 */
  researchAnswerOnly?: boolean;
};

export type Provider = {
  name: string;
  /**
   * この頭脳が飲み込める会話の目安（文字数）。
   * 小さいモデルほど狭いので、エージェント側が履歴を切る基準に使う。
   * 省略時は Agent の既定値。
   */
  contextBudget?: number;
  complete: (messages: Message[], tools: Tool[], env: AgentEnv, options?: CompletionOptions) => Promise<string>;
};

export type CompletionStats = {
  elapsedMs: number;
  firstTokenMs?: number;
  loadMs?: number;
  promptMs?: number;
  generationMs?: number;
  promptTokens?: number;
  outputTokens?: number;
};

export type CompletionOptions = {
  /** 生の生成テキスト。ツール構文を含むので、直接画面には出さない。 */
  onText?: (text: string) => void;
  onStats?: (stats: CompletionStats) => void;
};

export type AgentEvent =
  | { type: "assistant"; text: string }
  | { type: "assistant_delta"; text: string }
  | { type: "model_stats"; stats: CompletionStats }
  | { type: "tool_start"; name: string; args: Record<string, unknown> }
  | { type: "tool_end"; name: string; result: string; ok: boolean }
  | { type: "notice"; message: string }
  | { type: "done"; reason: "answered" | "max_steps" | "stuck" };
