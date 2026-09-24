import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../src/agent.ts";
import { Assistant } from "../src/assistant.ts";
import { LearningStore } from "../src/learning.ts";
import { unsupportedCompanyClaims } from "../src/evidence.ts";
import { researchRoute } from "../src/routing.ts";
import type { AgentEvent, Provider, Tool } from "../src/types.ts";
import { temporaryDirectory } from "./helpers.ts";

const company = "青空住宅株式会社";
const url = "https://example.com/about";
const description = `${company}は、住宅設備、住宅機器等の販売及び設置工事を行っています。`;
const correct = `${company}は住宅設備・住宅機器の販売と設置工事を行う会社です。[出典](${url})`;

function web(queries: string[]): Tool[] {
  return [
    { name: "web_search", description: "test", params: [], run: async (args) => {
      queries.push(String(args.query));
      return `1. ${company} | 会社概要\nURL: ${url}\n抜粋: 主な事業内容を掲載しています。`;
    } },
    { name: "web_fetch", description: "test", params: [], run: async () =>
      `会社概要\n${url}\n[Webページの参考資料]\n${description}` },
  ];
}

async function ask(assistant: Assistant, input: string): Promise<string> {
  const events: AgentEvent[] = [];
  await assistant.run(input, (event) => events.push(event));
  return events.filter((event): event is Extract<AgentEvent, { type: "assistant" }> => event.type === "assistant")
    .map((event) => event.text).join("\n");
}

test("会社名は検索するが、勤務先という個人情報は検索語に含めない", async (t) => {
  const dir = await temporaryDirectory(t);
  const queries: string[] = [];
  let calls = 0;
  const provider: Provider = { name: "scripted", complete: async (_messages, tools, env) => {
    calls++;
    assert.equal(env.researchAnswerOnly, true);
    assert.deepEqual(tools, []);
    return correct;
  } };
  const assistant = new Assistant(new Agent({ provider, tools: web(queries), mode: "chat", ctx: { root: dir, confirm: async () => true } }), new LearningStore(dir));
  const answer = await ask(assistant, `${company}とはどんな会社ですか？私が勤めている会社です。`);
  assert.deepEqual(queries, [`${company} 事業内容 公式`]);
  assert.equal(calls, 1);
  assert.match(answer, /住宅設備/);
  assert.doesNotMatch(answer, /食品/);
});

test("会社概要に事業内容が明記されていれば、モデルの推測なしで答える", async (t) => {
  const dir = await temporaryDirectory(t);
  const tools = web([]);
  tools[1] = { ...tools[1]!, run: async () =>
    `${url}\n[Webページの参考資料]\n会社名\n${company}\n主な事業内容\n1. 住宅設備、住宅機器等の販売及び設置工事の請負\n2. 建築資材等の販売及び設置工事の請負\n資本金\n1億円` };
  const provider: Provider = { name: "unused", complete: async () => { throw new Error("会社概要を直接読める場合はモデル不要"); } };
  const assistant = new Assistant(new Agent({ provider, tools, mode: "chat", ctx: { root: dir, confirm: async () => true } }), new LearningStore(dir));
  const answer = await ask(assistant, `${company}はどんな会社ですか？`);
  assert.match(answer, /住宅設備.*建築資材/);
  assert.match(answer, /\[出典\]\(https:\/\/example.com\/about\)/);
});

test("会社概要が一行に整形されても、番号付き事業項目を拾う", async (t) => {
  const dir = await temporaryDirectory(t);
  const tools = web([]);
  tools[1] = { ...tools[1]!, run: async () =>
    `${url}\n[Webページの参考資料]\n会社名 ${company} 主な事業内容 1. 住宅設備の販売と設置工事 2. 建築資材の販売と施工 資本金 1億円` };
  const provider: Provider = { name: "unused", complete: async () => { throw new Error("番号付きの事業項目を読めるはず"); } };
  const assistant = new Assistant(new Agent({ provider, tools, mode: "chat", ctx: { root: dir, confirm: async () => true } }), new LearningStore(dir));
  assert.match(await ask(assistant, `${company}はどんな会社ですか？`), /住宅設備.*建築資材/);
});

test("検索結果に公式の会社概要と企業紹介記事があれば、公式から待機なしで答える", async (t) => {
  const dir = await temporaryDirectory(t);
  const official = "https://www.yuasaquobis.co.jp/aboutus/";
  const fetched: string[] = [];
  const tools: Tool[] = [
    { name: "web_search", description: "test", params: [], run: async () =>
      `1. ユアサクオビス | 住空間をトータルコーディネートする\nURL: ${official}\n抜粋: 快適で安心な空間づくり\n2. ユアサクオビス株式会社ってどんな会社？事業内容、仕事内容\nURL: https://jobhabase.com/archives/246807\n抜粋: ユアサクオビス株式会社の事業内容` },
    { name: "web_fetch", description: "test", params: [], run: async (args) => {
      fetched.push(String(args.url));
      return `${official}\n[Webページの参考資料]\n会社名\nユアサクオビス株式会社\n主な事業内容\n1. 住宅設備、住宅機器等の販売及び設置工事の請負\n2. 建築資材、土木資材等の販売及び設置工事の請負\n資本金\n353百万円`;
    } },
  ];
  const provider: Provider = { name: "unused", complete: async () => { throw new Error("取得済みの会社概要から回答できるはず"); } };
  const assistant = new Assistant(new Agent({ provider, tools, mode: "chat", ctx: { root: dir, confirm: async () => { throw new Error("公開情報で確認は不要"); } } }), new LearningStore(dir));
  const answer = await ask(assistant, "ユアサクオビス株式会社とはどんな会社ですか？私が勤めています。");
  assert.deepEqual(fetched, [official]);
  assert.match(answer, /住宅設備.*建築資材/);
  assert.match(answer, /yuasaquobis\.co\.jp\/aboutus/);
});

test("資料にない食品業・商品を捏造した回答は表示せず、資料に沿って再回答する", async (t) => {
  const dir = await temporaryDirectory(t);
  let calls = 0;
  const provider: Provider = { name: "scripted", complete: async () => ++calls === 1
    ? `${company}は食品会社で、肉類や魚介類を加工販売しています。[出典](${url})` : correct };
  const agent = new Agent({ provider, tools: web([]), mode: "chat", ctx: { root: dir, confirm: async () => true } });
  const answer = await ask(new Assistant(agent, new LearningStore(dir)), `${company}とはどんな会社ですか？`);
  assert.equal(calls, 2);
  assert.match(answer, /住宅設備/);
  assert.doesNotMatch(answer, /食品|肉類|魚介類/);
  assert.ok(!agent.messages.some((message) => message.role === "assistant" && message.content.includes("食品会社")));
});

test("訂正を受けたら同じ会社を再調査し、以前の説明を根拠にしない", async (t) => {
  const dir = await temporaryDirectory(t);
  const queries: string[] = [];
  const provider: Provider = { name: "scripted", complete: async (messages) => {
    assert.ok(!messages.some((message) => message.role === "assistant" && message.content.includes("食品会社")));
    return correct;
  } };
  const assistant = new Assistant(new Agent({ provider, tools: web(queries), mode: "chat", ctx: { root: dir, confirm: async () => true } }), new LearningStore(dir));
  await ask(assistant, `${company}とはどんな会社ですか？私が勤めています。`);
  const answer = await ask(assistant, "食品会社ではありません。");
  assert.deepEqual(queries, [`${company} 事業内容 公式`, `${company} 事業内容 公式`]);
  assert.match(answer, /住宅設備/);
});

test("会社名のない私的な質問とオフライン指定では検索しない", () => {
  assert.equal(researchRoute("私の会社は何ですか？", "chat").firstCall, undefined);
  assert.equal(researchRoute(`${company}について検索しないで教えて`, "chat").firstCall, undefined);
  assert.deepEqual(researchRoute("株式会社はてなについて教えて", "chat").topic?.subjects, ["株式会社はてな"]);
  assert.equal(researchRoute(`${company}の社長は誰ですか？`, "chat").firstCall?.args.query, `${company} 社長 公式`);
});

test("会社説明の主要語を取得本文と照合する", () => {
  assert.deepEqual(unsupportedCompanyClaims(correct, [description], company), []);
  assert.ok(unsupportedCompanyClaims(`${company}は食品会社で肉類や魚介類を販売します。`, [description], company).includes("食品会社"));
});
