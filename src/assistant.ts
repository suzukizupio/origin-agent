import { Agent } from "./agent.ts";
import { LearningStore, memoryKey } from "./learning.ts";
import { isReplyRewrite, researchRoute, type ResearchRoute, type ResearchTopic } from "./routing.ts";
import type { AgentEvent, AgentMode } from "./types.ts";

type Turn = { question: string; answer: string; provider: string; mode: AgentMode };

function introducedName(input: string): string | undefined {
  return input.match(/(?:^|[。！!\s])(?:私|わたし|僕)の名前は[「『]?([^。！？\n「」『』]{1,40}?)[」』]?(?:です|だよ)(?:[。！!\s]|$)/)?.[1]?.trim();
}

function nameQuestion(input: string): boolean {
  return /^(?:(?:私|わたし|僕|自分)の)?(?:名前|呼び名|呼び方)(?:は|を|って)?.*(?:何|なに|覚えて|教えて|わかる|分かる)/.test(input.trim());
}

function naturalMemory(input: string): { key: string; value: string } | undefined {
  if (!/(?:覚えて(?:おいて)?|記憶して|保存して)/.test(input) || /(?:覚えない|覚えなくて|覚えなくても|保存しない|記憶しない)/.test(input)) return;
  const name = input.match(/(?:私|わたし|僕)(?:のこと)?(?:は|を)[「『]?([^。！？\n「」『』]{1,40}?)[」』]?と呼んで/)?.[1]?.trim()
    ?? introducedName(input);
  if (name) return { key: "呼び方", value: name };
  const style = input.match(/^(短く答えて|簡潔に答えて|詳しく答えて|やさしく説明して)[。！!\s]/)?.[1];
  if (style) return { key: "話し方", value: style };
  return;
}

/** CLIと実機テストが共用する、記憶・検索判断・フィードバックの入口。 */
export class Assistant {
  readonly agent: Agent;
  readonly store: LearningStore;
  private sessionName: string | undefined;
  private lastTurn: Turn | undefined;
  private canRewrite = false;
  private researchTopic: ResearchTopic | undefined;

  constructor(agent: Agent, store: LearningStore) { this.agent = agent; this.store = store; }

  reset(): void {
    this.agent.reset();
    this.sessionName = undefined;
    this.lastTurn = undefined;
    this.canRewrite = false;
    this.researchTopic = undefined;
  }

  async run(input: string, emit: (event: AgentEvent) => void): Promise<void> {
    const line = input.trim();
    // コマンドの応答や失敗を挟んだ後に、古い回答を「直前」と取り違えない。
    const previous = this.canRewrite ? this.lastTurn : undefined;
    this.canRewrite = false;
    const say = (text: string) => { emit({ type: "assistant", text }); emit({ type: "done", reason: "answered" }); };
    const remember = line.match(/^\/remember\s+(\S+)\s+([\s\S]+)$/);
    const natural = naturalMemory(line);
    if (remember || natural) {
      const entry = await this.store.remember(remember?.[1] ?? natural!.key, remember?.[2] ?? natural!.value);
      this.reset();
      say(`「${entry.key}」を「${entry.value}」で保存しました。次回起動時も参照します。`);
      return;
    }
    if (/^\/remember(?:\s|$)/.test(line)) { say("使い方: /remember 呼び方 ハル\n同じ項目を指定すると内容を更新します。"); return; }
    if (line === "/memory" || /^(覚えていることを教えて|記憶を見せて)[。！!？?]*$/.test(line)) {
      const { memories } = await this.store.read();
      say(memories.length ? memories.map((m) => `- ${m.key}: ${m.value}`).join("\n") : "保存した記憶はまだありません。");
      return;
    }
    const forget = line.match(/^\/forget\s+(.+)$/) ?? line.match(/^(呼び方|名前|呼び名|話し方|目標)(?:を|は)忘れて[。！!]*$/);
    if (forget) {
      const key = memoryKey(forget[1]!);
      const removed = await this.store.forget(key);
      this.reset();
      say(removed ? `「${key}」を削除しました。会話と、その内容を含む感想もリセットしました。` : `「${key}」の保存はありません。会話はリセットしました。`);
      return;
    }
    if (line === "/forget") { say("使い方: /forget 呼び方"); return; }
    if (line === "/feedback list") {
      const { feedback } = await this.store.read();
      say(feedback.length ? feedback.slice(-10).map((f) => `${f.id}\n  ${f.rating}: ${f.note || "よかった"}\n  質問: ${f.question}`).join("\n\n") : "感想はまだありません。");
      return;
    }
    const removeFeedback = line.match(/^\/feedback delete\s+(\S+)$/);
    if (removeFeedback) {
      const removed = await this.store.deleteFeedback(removeFeedback[1]!);
      this.reset();
      say(removed ? "感想を削除しました。会話もリセットしました。" : "そのIDの感想はありません。");
      return;
    }
    const feedback = line.match(/^\/feedback\s+(good|bad)(?:\s+([\s\S]+))?$/);
    if (feedback) {
      if (!this.lastTurn) { say("まだ記録する回答がありません。会話や調べものの回答後に感想を付けてください。"); return; }
      const entry = await this.store.addFeedback({ ...this.lastTurn, rating: feedback[1] as "good" | "bad", note: feedback[2] ?? "" });
      say(`感想を保存しました。関連する質問のときに参照します。\nID: ${entry.id}`);
      return;
    }
    if (/^\/feedback(?:\s|$)/.test(line)) {
      say("使い方: /feedback good 分かりやすかった\n/feedback bad もっと短く答えてほしい\n/feedback list\n/feedback delete <ID>");
      return;
    }
    if (line.startsWith("/") && !/^\/search(?:\s|$)/.test(line)) { say("不明なコマンドです。/help で一覧を確認できます。"); return; }

    // 呼び方は、ユーザー発言か保存した記憶からのみ答える。
    if (nameQuestion(line)) {
      this.researchTopic = undefined;
      const saved = (await this.store.read()).memories.find((m) => m.key === "呼び方");
      const name = this.sessionName ?? saved?.value;
      const answer = name ? `${name}さんとお呼びします。` : "今はお名前が分かりません。呼んでほしい名前を教えてください。";
      // モデルを通さない回答も、次の「それ」などが参照できるよう会話に残す。
      this.agent.messages.push({ role: "user", content: line }, { role: "assistant", content: answer });
      this.lastTurn = { question: line, answer, provider: this.agent.provider.name, mode: this.agent.mode };
      this.canRewrite = true;
      say(answer);
      return;
    }
    const name = introducedName(line);
    if (name) this.sessionName = name;
    const query = line.startsWith("/search") ? line.slice(7).trim() : undefined;
    if (query === "") { say("例: /search みらい平駅 公式 時刻表"); return; }
    const question = query === undefined ? line : `ネットで調べて、日本語で短く答えてください: ${query}`;
    const rewriting = query === undefined && this.agent.mode === "chat" && isReplyRewrite(line);
    const target = previous?.mode === this.agent.mode && previous.provider === this.agent.provider.name
      ? previous : undefined;
    const route: ResearchRoute = rewriting ? {
      allowWeb: false, research: false, topic: this.researchTopic,
      ...(!target ? { clarification: "言い換える直前の回答がありません。短くしたい文章を送ってください。" } : {}),
    } : query === undefined ? researchRoute(line, this.agent.mode, this.researchTopic) : {
      allowWeb: true, research: true, firstCall: { name: "web_search", args: { query } },
    };
    this.researchTopic = route.topic;
    if (route.clarification) {
      // モデルの推測を挟まず条件を確かめる。続きの質問に備え会話にも残す。
      this.agent.messages.push({ role: "user", content: line }, { role: "assistant", content: route.clarification });
      this.lastTurn = undefined;
      say(route.clarification);
      return;
    }
    // 書き換え元に保存済みの別条件や過去の誤答を混ぜない。今回の形式指定を優先する。
    const knowledge = rewriting ? { text: "", feedbackCount: 0 } : await this.store.context(question, this.agent.mode);
    if (rewriting) emit({ type: "notice", message: "直前の回答をもとに言い換えます。新しい検索は行いません。" });
    if (knowledge.feedbackCount) emit({ type: "notice", message: `関連する感想 ${knowledge.feedbackCount} 件を参照します。` });
    if (route.firstCall && query === undefined) emit({ type: "notice", message: "確かな情報を確認するため、ネットで調べます。" });
    let answer = "";
    let answered = false;
    this.lastTurn = undefined;
    await this.agent.run(route.resolvedQuestion ?? question, (event) => {
      if (event.type === "assistant") answer = event.text;
      if (event.type === "done") answered = event.reason === "answered";
      emit(event);
    }, route.firstCall, { ...route, knowledge: knowledge.text, rewriteSource: rewriting ? target?.answer : undefined });
    if (answered && answer) {
      this.lastTurn = { question, answer, provider: this.agent.provider.name, mode: this.agent.mode };
      this.canRewrite = true;
    }
  }
}
