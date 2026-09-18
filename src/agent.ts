// エージェントループ。コーディングエージェントの本体はここ。
//
//   ユーザー入力 → 頭脳に投げる → ツール呼び出しが含まれていたら実行 →
//   結果を会話に戻す → また頭脳に投げる → ツールを呼ばなくなったら終了
//
// 驚くほど単純だが、Claude Code もこの形をしている。
// 賢さの差はモデルと、ここに足されるツール・コンテキスト管理から来る。

import { formatToolCall, parseToolCalls } from "./protocol.ts";
import { createTextPreview } from "./streaming.ts";
import { evidenceText, unknownCitations, unsupportedNumbers } from "./evidence.ts";
import { compareEvidence, type Comparison, type SourceDocument } from "./comparison.ts";
import { focusEvidence, locationEvidence, rankSources, searchExcerpts } from "./retrieval.ts";
import { walkEntries } from "./tools/walk.ts";
import { show } from "./tools/paths.ts";
import type { AgentEnv, AgentEvent, AgentMode, Message, Provider, Tool, ToolCall, ToolContext } from "./types.ts";

/** 同一のツール呼び出しがこの回数に達したら、行き詰まりとみなして打ち切る */
const REPEAT_LIMIT = 3;

/**
 * 作業ルートの中身を変えうるツール。これが成功した後は、同じ read_file や npm test を
 * もう一度呼んでも結果が違いうるので、繰り返しの数え直しをする。
 * 実測: 「読む → 直す → 読み直す」の3回目の read_file を行き詰まりと誤判定し、
 * 編集後の確認に入ったところで打ち切っていた。
 */
const MUTATING_TOOLS = new Set(["edit_file", "replace_lines", "write_file", "edit_json", "run_shell"]);

function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw.trim());
    url.hash = "";
    return url.href;
  } catch {
    return raw.trim();
  }
}

/**
 * 調べものの途中の web_fetch を、実行する前に確かめる。問題がなければ undefined。
 * 断るときは失敗として打ち切らず、次にどうすべきかを頭脳に返す。
 *
 * 実測: 3B は公式ページの本文（答えが507文字目にあった）を受け取った後、答えずに
 *   ・同じページを取り直し続けて行き詰まった（3回中3回）
 *   ・検索結果のURLの番号だけ変えた、実在しないURLを取りに行って404になった（6回中6回）
 */
function checkResearchFetch(call: ToolCall, known: string[], fetched: Set<string>): string | undefined {
  if (call.name !== "web_fetch" || typeof call.args.url !== "string") return undefined;
  const url = normalizeUrl(call.args.url);
  if (fetched.has(url)) {
    return "このページは取得済みです。本文はすでに渡してあります。取り直さず、その本文から答えてください。";
  }
  const allowed = [...new Set(known.map(normalizeUrl))];
  if (allowed.includes(url)) return undefined;
  return [
    "そのURLは検索結果にも依頼文にもありません。URLを推測して作らないでください。",
    allowed.length > 0 ? `取得できるのは次のURLだけです:\n${allowed.slice(0, 5).join("\n")}` : "",
    fetched.size > 0 ? "すでに取得した本文で答えられるなら、そこから答えてください。" : "",
  ].filter((line) => line !== "").join("\n");
}

export type RunContext = { knowledge?: string; research?: boolean; allowWeb?: boolean; readSource?: boolean; additionalSearches?: string[]; topic?: { subjects: string[] }; comparison?: Comparison; focus?: string[] };

export type AgentOptions = {
  provider: Provider;
  tools: Tool[];
  ctx: ToolContext;
  /** 1回の指示で頭脳に問い合わせる上限。暴走と課金事故の歯止め */
  maxSteps?: number;
  /** 会話履歴の上限（文字数）。超えたら古いものから落とす */
  contextBudget?: number;
  mode?: AgentMode;
};

export class Agent {
  provider: Provider;
  ctx: ToolContext;
  messages: Message[] = [];

  private tools: Map<string, Tool>;
  private maxSteps: number;
  private contextBudgetOverride: number | undefined;
  private outline: string | null = null;
  private currentMode: AgentMode;
  private lastReadPath: string | undefined;

  constructor(opts: AgentOptions) {
    this.provider = opts.provider;
    this.ctx = opts.ctx;
    this.tools = new Map(opts.tools.map((t) => [t.name, t]));
    this.maxSteps = opts.maxSteps ?? 12;
    this.contextBudgetOverride = opts.contextBudget;
    this.currentMode = opts.mode ?? "code";
  }

  /** 頭脳は実行中に差し替えられるので、都度その頭脳の申告を読む */
  private get contextBudget(): number {
    return this.contextBudgetOverride ?? this.provider.contextBudget ?? 60_000;
  }

  get toolList(): Tool[] {
    return [...this.tools.values()].filter((tool) =>
      this.currentMode === "code" || tool.name === "web_search" || tool.name === "web_fetch",
    );
  }

  get mode(): AgentMode {
    return this.currentMode;
  }

  setMode(mode: AgentMode): void {
    this.currentMode = mode;
    this.reset();
  }

  reset(): void {
    this.messages = [];
    this.outline = null;
    this.lastReadPath = undefined;
  }

  /**
   * 作業ルートの見取り図。最初の一手でパスを推測して外すのを防ぐ。
   * 1回の run 内では変わらない前提で使い回す。
   */
  private async buildEnv(): Promise<AgentEnv> {
    if (this.mode === "chat") return { root: "", outline: "", mode: "chat" };
    if (this.outline === null) {
      const entries: string[] = [];
      // 深さ2だと src/providers/ までしか見えず、その中のファイル名が伝わらない。
      // 頭脳が最初の一手で当てられるかは、ここの深さで決まる。
      for await (const entry of walkEntries(this.ctx.root, { maxDepth: 3, limit: 120 })) {
        entries.push(entry.isDir ? `${show(this.ctx, entry.abs)}/` : show(this.ctx, entry.abs));
      }
      this.outline = entries.sort().join("\n") || "(ファイルなし)";
    }
    return { root: this.ctx.root, outline: this.outline, mode: this.mode };
  }

  async run(
    input: string,
    emit: (e: AgentEvent) => void,
    firstCall?: Pick<ToolCall, "name" | "args">,
    context: RunContext = {},
  ): Promise<void> {
    this.messages.push({ role: "user", content: input });
    this.outline = null;
    let research = context.research === true || firstCall?.name.startsWith("web_") === true;
    const env = { ...await this.buildEnv(), knowledge: context.knowledge, research };
    const availableTools = this.toolList.filter((tool) => context.allowWeb !== false || !tool.name.startsWith("web_"));
    // 専用の道具は対象が分かったときに渡す。使わないJSONの説明があるだけでも、
    // 小さいモデルは通常のコードをJSON風に引用してしまうことがあった。
    const namedFiles = env.outline.split("\n").filter((path) => path && !path.endsWith("/")
      && (input.includes(path) || input.includes(path.split("/").at(-1)!)));
    let jsonRelevant = /\.json\b/i.test(input)
      || (namedFiles.length === 0 && /\.json$/i.test(this.lastReadPath ?? ""));
    const sources = new Set<string>();
    // 調べものの途中で取得してよいのは、検索結果か依頼文に出てきたURLだけ。
    // 3B は検索結果にあるURLの番号だけ変えて、実在しないURLを作って取りに行った（6回中6回）。
    const inputUrls = [...input.matchAll(/https?:\/\/[^\s「」<>]+/g)].map((match) => match[0].replace(/[。！？、)）]+$/, ""));
    const fetched = new Set<string>();
    const pendingCalls: Pick<ToolCall, "name" | "args">[] = firstCall ? [firstCall] : [];
    pendingCalls.push(...(context.additionalSearches ?? []).slice(0, 1).map((query) => ({ name: "web_search", args: { query, limit: 5 } })));
    let sourceReads = 0;
    const evidence: string[] = [];
    const researchMessages: Message[] = [];
    const documents: SourceDocument[] = [];
    const excerpts: SourceDocument[] = [];
    let revising = false;
    const finishResearchFailure = () => {
      const links = [...fetched].length ? [...fetched] : [...sources];
      const answer = `取得した資料から、質問への答えを十分に確認できませんでした。数値や結論を推測せず、未確認としてお伝えします。${links.length ? `\n\n確認した参照先:\n${links.slice(0, 3).join("\n")}` : ""}`;
      this.messages.push({ role: "assistant", content: answer });
      emit({ type: "assistant", text: answer });
      emit({ type: "done", reason: "answered" });
    };

    // 行き詰まった頭脳は、同じ呼び出しを延々と繰り返す。
    // maxSteps だけでは何十秒も無駄に回るので、繰り返し自体を検出して止める。
    const repeats = new Map<string, number>();

    for (let step = 0; step < this.maxSteps; step++) {
      this.trimContext(emit);
      const tools = revising ? [] : availableTools.filter((tool) => tool.name !== "edit_json" || jsonRelevant);

      // /search はユーザーが明示した検索。小さいモデルのツール選択に頼らず実行する。
      const pendingCall = pendingCalls.shift();
      if (!pendingCall && context.topic?.subjects.length === 1 && context.focus?.includes("何地方")) {
        const fromPage = locationEvidence(context.topic.subjects[0]!, documents);
        const fromExcerpt = fromPage ? undefined : locationEvidence(context.topic.subjects[0]!, excerpts);
        const located = fromPage ?? (fromExcerpt ? `検索結果の抜粋では、${fromExcerpt}` : undefined);
        if (located) {
          this.messages.push({ role: "assistant", content: located });
          emit({ type: "assistant", text: located });
          emit({ type: "done", reason: "answered" });
          return;
        }
      }
      if (!pendingCall && context.comparison) {
        const compared = compareEvidence(context.comparison, documents);
        if (compared) {
          this.messages.push({ role: "assistant", content: compared });
          emit({ type: "assistant", text: compared });
          emit({ type: "done", reason: "answered" });
          return;
        }
        // 片方の値をもう片方へコピーしたり、時点の違う値で結論を作らない。
        // 今の読み取り器で対応付けを確かめられない比較は、未確認とする。
        finishResearchFailure();
        return;
      }
      const answerOnly = research && context.readSource === true && pendingCalls.length === 0 && evidence.some((text) => text.trim());
      // 今回の質問と資料に集中する。過去の推測や別の話題を答えの根拠にしない。
      const completionMessages: Message[] = answerOnly
        ? [...researchMessages, { role: "user", content: input }]
        : this.messages;
      const raw = pendingCall !== undefined
        ? formatToolCall(pendingCall.name, pendingCall.args)
        : await this.provider.complete(completionMessages, answerOnly ? [] : tools, { ...env, researchAnswerOnly: answerOnly }, {
          // 調べものは検査後に表示する。誤った数値を先に流してしまわない。
          onText: research ? () => {} : createTextPreview((text) => emit({ type: "assistant_delta", text })),
          onStats: (stats) => emit({ type: "model_stats", stats }),
        });
      this.messages.push({ role: "assistant", content: raw });

      const { calls, say } = parseToolCalls(raw);
      // ツールを呼ばなかった = 言いたいことは言い切った、とみなす
      if (calls.length === 0) {
        if (research) {
          const missing = unsupportedNumbers(say, evidence);
          const urls = unknownCitations(say, [...sources, ...fetched]);
          const withoutLinks = say.replace(/\[[^\]]*\]\(https?:\/\/[^\s)]+\)/g, "").replace(/https?:\/\/\S+/g, "")
            .replace(/\[(?:出典|参照元|参考資料)(?:\s*\d+)?\]/g, "").replace(/(?:参照元|出典)\s*[:：]/g, "");
          const nameOnly = withoutLinks.replace(/[\s。！!：:#*]/g, "").replace(/[都道府県市]$/, "");
          const incomplete = !!nameOnly && context.topic?.subjects.some((subject) => subject.replace(/[都道府県市]$/, "") === nameOnly);
          const instructionEcho = /この参考資料から最初の質問に|追加検索は不要です|今回調べる対象:|確認する項目:/.test(say);
          if (missing.length || urls.length || incomplete || instructionEcho) {
            this.messages.pop(); // 誤った回答を会話の事実として残さない。
            if (revising || step === this.maxSteps - 1) { finishResearchFailure(); return; }
            revising = true;
            emit({ type: "notice", message: "回答内容を資料と照らし合わせて見直しています。" });
            const correction: Message = { role: "tool", toolName: "answer_check", content: [
              "回答はまだ表示していません。取得資料だけから短く回答を作り直してください。追加ツールは不要です。",
              missing.length ? `資料にない数値: ${missing.join("、")}。資料と同じ値・単位を使い、推測や丸めた値を加えないでください。` : "",
              urls.length ? "参照元にないURLが含まれていました。取得したURLだけを使用してください。" : "",
              incomplete ? "対象名だけでは質問への説明になりません。質問で聞かれた場所や比較の根拠を、資料から具体的に答えてください。" : "",
              instructionEcho ? "回答の作り方の指示を繰り返していました。その指示文は回答に含めず、ユーザーの質問への答えだけを書いてください。" : "",
              "資料に答えがない場合は『確認できませんでした』と伝えてください。",
            ].filter(Boolean).join("\n") };
            this.messages.push(correction);
            researchMessages.push(correction);
            continue;
          }
        }
        const links = [...fetched].length ? [...fetched] : [...sources];
        const missingLinks = links.filter((url) => !say.includes(url));
        const needsSources = research && missingLinks.length > 0 && (missingLinks.length === links.length || (context.additionalSearches?.length ?? 0) > 0);
        const answer = needsSources ? `${say}\n\n参照元:\n${missingLinks.slice(0, 3).join("\n")}` : say;
        this.messages[this.messages.length - 1] = { role: "assistant", content: answer };
        if (answer) emit({ type: "assistant", text: answer });
        emit({ type: "done", reason: "answered" });
        return;
      }
      if (revising) { this.messages.pop(); finishResearchFailure(); return; }
      if (say !== "" && !research) emit({ type: "assistant", text: say });

      for (const call of calls) {
        const signature = `${call.name}:${JSON.stringify(call.args)}`;
        const count = (repeats.get(signature) ?? 0) + 1;
        repeats.set(signature, count);
        if (count >= REPEAT_LIMIT) {
          emit({
            type: "notice",
            message: `${call.name} を同じ引数で ${count} 回呼ぼうとしたので中断しました。頭脳が行き詰まっています。`,
          });
          emit({ type: "done", reason: "stuck" });
          return;
        }

        emit({ type: "tool_start", name: call.name, args: call.args });
        // 使えない web_ ツールを呼んだだけで調べものに切り替えない。切り替えると、
        // 「使えません」のエラーを調べものの失敗として扱い、作業ごと打ち切ってしまう。
        if (call.name.startsWith("web_") && tools.some((tool) => tool.name === call.name)) { research = true; env.research = true; }
        const refusal = research ? checkResearchFetch(call, [...sources, ...inputUrls], fetched) : undefined;
        const { text, ok } = refusal !== undefined ? { text: refusal, ok: false } : await this.invoke(call, tools);
        emit({ type: "tool_end", name: call.name, result: text, ok });
        this.messages.push({ role: "tool", toolName: call.name, content: text });
        if (ok && MUTATING_TOOLS.has(call.name)) repeats.clear();
        if (ok && (call.name === "read_file" || call.name === "edit_json") && typeof call.args.path === "string") {
          this.lastReadPath = call.args.path;
          jsonRelevant = /\.json$/i.test(call.args.path);
        }
        if (call.name.startsWith("web_")) {
          const focused = call.name === "web_fetch" && ok && context.focus?.length
            ? text.split("[Webページの参考資料]")[0] + "[Webページの参考資料]\n" + focusEvidence(evidenceText(call.name, text), context.focus)
            : text;
          researchMessages.push({ role: "tool", toolName: call.name, content: focused });
          if (ok) {
            evidence.push(evidenceText(call.name, focused));
            if (call.name === "web_search") excerpts.push(...searchExcerpts(text));
            if (call.name === "web_fetch" && typeof call.args.url === "string") documents.push({ url: call.args.url, text: evidenceText(call.name, text) });
            if (call.name === "web_fetch" && typeof call.args.url === "string") fetched.add(normalizeUrl(call.args.url));
            const header = call.name === "web_fetch" ? text.split("[Webページの参考資料]")[0] ?? "" : text;
            const found = [...header.matchAll(/^(?:URL: )?(https?:\/\/[^\s（）]+)/gm)].map((match) => match[1]!);
            for (const url of found) sources.add(url);
            if (context.readSource && sourceReads < 1 + Math.min(context.additionalSearches?.length ?? 0, 1) && call.name === "web_search" && tools.some((tool) => tool.name === "web_fetch")) {
              const ranked = rankSources(text, String(call.args.query ?? ""));
              const preferred = [...ranked, ...found.filter((url) => !/\.pdf(?:[?#]|$)/i.test(url))].find((url) => !fetched.has(normalizeUrl(url)));
              if (preferred) {
                pendingCalls.unshift({ name: "web_fetch", args: { url: preferred, max_chars: 6000 } });
                sourceReads++;
              }
            }
            if (research && call.name === "web_search" && found.length === 0 && fetched.size === 0) {
              const answer = "検索で参照できるページが見つかりませんでした。検索語を変えるか、URLを指定してください。";
              this.messages.push({ role: "assistant", content: answer });
              emit({ type: "assistant", text: answer });
              emit({ type: "done", reason: "answered" });
              return;
            }
          } else if (research && refusal === undefined && fetched.size === 0) {
            // 何も読めていないときだけ打ち切る。先に本文を読めていれば、後の取得の失敗で
            // その資料を捨てない（以前は、読めた公式ページがあっても404ひとつで全部捨てていた）。
            // 関門で断った呼び出しは失敗ではなく指示なので、ここでは打ち切らない。
            const answer = `今回は調べられませんでした。\n${text}\n取得できていない情報は、確認済みの情報として回答できません。`;
            this.messages.push({ role: "assistant", content: answer });
            emit({ type: "assistant", text: answer });
            emit({ type: "done", reason: "answered" });
            return;
          }
        }
      }
    }

    emit({ type: "done", reason: "max_steps" });
  }

  /** ツールを1つ実行する。失敗も文字列として頭脳に返し、やり直す機会を与える */
  private async invoke(call: ToolCall, tools: Tool[]): Promise<{ text: string; ok: boolean }> {
    if (call.error !== undefined) {
      return { text: `エラー: ${call.error}`, ok: false };
    }

    const tool = tools.find((candidate) => candidate.name === call.name);
    if (!tool) {
      const known = tools.map((candidate) => candidate.name).join(", ");
      return { text: `エラー: '${call.name}' は現在のモードでは使えません。使えるのは: ${known}`, ok: false };
    }

    const args = { ...call.args };
    for (const p of tool.params) {
      if (args[p.name] === undefined && p.fallback !== undefined) args[p.name] = p.fallback;
    }
    const missing = tool.params.filter((p) => p.required && args[p.name] === undefined);
    if (missing.length > 0) {
      return { text: `エラー: 引数が足りません: ${missing.map((p) => p.name).join(", ")}`, ok: false };
    }

    try {
      let denied = false;
      const text = await tool.run(args, { ...this.ctx, confirm: async (message) => {
        const accepted = await this.ctx.confirm(message);
        if (!accepted) denied = true;
        return accepted;
      } });
      return { text, ok: !denied };
    } catch (e) {
      return { text: `エラー: ${(e as Error).message}`, ok: false };
    }
  }

  /**
   * 素朴なコンテキスト管理。今は文字数で古い発話を捨てるだけ。
   * 本物のコーディングエージェントはここで要約・ファイル再読込・重要度判定をする。
   * 「賢くする」の主戦場その2。
   */
  private trimContext(emit: (e: AgentEvent) => void): void {
    const size = (): number => this.messages.reduce((n, m) => n + m.content.length, 0);
    let dropped = 0;
    // 古いターンをまとめて外し、直近の依頼を必ず残す。
    while (size() > this.contextBudget && this.messages.length > 4) {
      const nextTurn = this.messages.findIndex((message, index) => index > 0 && message.role === "user");
      if (nextTurn > 0) {
        this.messages.splice(0, nextTurn);
        dropped += nextTurn;
      } else {
        // 1つの依頼で資料が増えたときは、最初の依頼と直近の実行結果を優先する。
        const nextAssistant = this.messages.findIndex((message, index) => index > 1 && message.role === "assistant");
        if (nextAssistant < 0) break;
        this.messages.splice(1, nextAssistant - 1);
        dropped += nextAssistant - 1;
      }
    }
    if (dropped > 0) {
      emit({ type: "notice", message: `文脈が長くなったため、古い発話 ${dropped} 件を捨てました` });
    }
  }
}
