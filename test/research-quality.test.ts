import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../src/agent.ts";
import { Assistant } from "../src/assistant.ts";
import { LearningStore } from "../src/learning.ts";
import { researchRoute } from "../src/routing.ts";
import { evidenceText, unknownCitations, unsupportedNumbers } from "../src/evidence.ts";
import type { AgentEvent, Provider, Tool } from "../src/types.ts";
import { temporaryDirectory } from "./helpers.ts";

const output = (events: AgentEvent[]) => events.filter((e): e is Extract<AgentEvent, { type: "assistant" }> => e.type === "assistant").map((e) => e.text).join("\n");
const first = "https://example.com/first";
const second = "https://example.com/second";

test("routing: 大阪など語尾を省いた地名も検索し、比較の基準は確認する", () => {
  for (const name of ["大阪", "札幌", "福岡", "ベルリン"]) {
    const route = researchRoute(`${name}ってどこですか？`, "chat");
    assert.match(String(route.firstCall?.args.query), new RegExp(name));
    assert.equal(route.readSource, true);
  }
  const compare = researchRoute("秋田と岩手ってどっちが大きいですか？", "chat");
  assert.equal(compare.firstCall, undefined);
  assert.match(compare.clarification!, /面積と人口/);
  assert.deepEqual(compare.topic?.subjects, ["秋田県", "岩手県"]);
  const area = researchRoute("面積はどうですか？", "chat", compare.topic);
  assert.match(String(area.firstCall?.args.query), /秋田県 面積/);
  assert.deepEqual(area.additionalSearches, ["岩手県 面積 公式"]);
  assert.match(area.resolvedQuestion!, /秋田県と岩手県/);
  const next = researchRoute("山梨と長野の面積を比べてください", "chat");
  assert.match(String(next.firstCall?.args.query), /山梨県 面積/);
  assert.deepEqual(next.additionalSearches, ["長野県 面積 公式"]);
});

test("routing: 私的な話・コード・検索しない指示を、地名の続きと取り違えない", () => {
  const topic = { subjects: ["秋田県", "岩手県"] };
  for (const input of ["私の住所はどこですか？", "私の面積の計算を見て", "関数はどこですか？", "これはどこ？", "検索しないで面積を教えて"]) {
    assert.equal(researchRoute(input, "code", topic).firstCall, undefined, input);
  }
  assert.match(researchRoute("面積は？", "chat").clarification!, /何の面積/);
  assert.equal(researchRoute("もう少し詳しく", "chat", topic).firstCall, undefined);
  assert.equal(researchRoute("人口の意味は？", "chat", topic).firstCall, undefined);
  assert.equal(researchRoute("象とネズミってどっちが大きい？", "chat").clarification, undefined);
});

test("evidence: 桁・単位・漢数字を照合し、URLや日時を根拠にしない", () => {
  assert.deepEqual(unsupportedNumbers("人口は2,700万人、面積は4万8,739平方キロメートルです。", ["人口は270万人。面積は4,873.9km²。"]), ["2,700万人", "4万8,739平方キロメートル"]);
  assert.deepEqual(unsupportedNumbers("人口は十二万人、面積は１万２，３４５．６平方キロメートルです。", ["人口: 120000人。面積: 12,345.6km²。"]), []);
  assert.deepEqual(unsupportedNumbers("予算は1億2,300万4,500円。", ["予算123004500円"]), []);
  assert.deepEqual(unsupportedNumbers("面積15,275km²", ["長さ15,275km"]), ["15,275km2"]);
  assert.deepEqual(unsupportedNumbers("高度2.21m", ["高度−2.21m"]), ["2.21m"]);
  assert.deepEqual(unsupportedNumbers("1. 面積は1,000km²。[出典](https://example.com/9999)", ["面積:1000km2"]), []);
  const body = evidenceText("web_search", "検索語: 2700万人\n取得日時: 2026-09-17\n1. 総人口2700万人？\nURL: https://example.com/2700\n抜粋: 数値は未掲載です。");
  assert.deepEqual(unsupportedNumbers("2700万人", [body]), ["2700万人"]);
  assert.equal(evidenceText("web_fetch", "取得日時: 2026\nhttps://example.com/999\n[Webページの参考資料]\n本文"), "\n本文");
  assert.deepEqual(unknownCitations("[ページ](https://example.com/first#main)", [first]), []);
  assert.deepEqual(unknownCitations("[ページ](https://example.com/fake)", [first]), ["https://example.com/fake"]);
});

function tools(log: string[]): Tool[] {
  return [
    { name: "web_search", description: "test", params: [], run: async (args) => {
      const query = String(args.query); log.push(query);
      return `URL: ${query.includes("岩手") ? second : first}\n抜粋: 概要のページです。`;
    } },
    { name: "web_fetch", description: "test", params: [], run: async (args) => `${args.url}\n[Webページの参考資料]\n${args.url === second ? "岩手県の面積は15,275.04平方キロメートル。" : "秋田県の面積は11,637平方キロメートル。大阪の所在地: 近畿地方。"}` },
  ];
}

test("assistant: 画像の3往復で、比較対象を引き継ぎ両方を検索する。リセットと話題変更後は引き継がない", async (t) => {
  const dir = await temporaryDirectory(t);
  const log: string[] = [];
  let calls = 0;
  const provider: Provider = { name: "test", complete: async (messages) => {
    calls++;
    if (messages.filter((m) => m.role === "user").at(-1)?.content.includes("面積")) {
      assert.ok(messages.some((m) => m.role === "tool" && m.content.includes("岩手県の面積")));
      assert.ok(messages.some((m) => m.role === "tool" && m.content.includes("秋田県の面積")));
      return "岩手県の方が広いです。秋田県は11,637平方キロメートル、岩手県は15,275.04平方キロメートルです。";
    }
    return "大阪は近畿地方にあります。";
  } };
  const assistant = new Assistant(new Agent({ provider, tools: tools(log), mode: "chat", ctx: { root: dir, confirm: async () => true } }), new LearningStore(dir));
  const ask = async (input: string) => { const events: AgentEvent[] = []; await assistant.run(input, (e) => events.push(e)); return events; };
  await ask("大阪ってどこですか？");
  assert.match(output(await ask("秋田と岩手ってどっちが大きいですか？")), /面積と人口/);
  assert.equal(calls, 1, "条件確認にモデルは不要");
  assert.match(output(await ask("面積はどうですか？")), /岩手県の方が広い/);
  assert.deepEqual(log, ["大阪 何地方 位置 公式", "秋田県 面積 公式", "岩手県 面積 公式"]);
  assert.equal(calls, 1, "数値が明確な比較にはモデルの生成も不要");
  assistant.reset();
  assert.match(output(await ask("面積は？")), /何の面積/);
  await ask("秋田と岩手ってどっちが大きい？");
  await ask("こんにちは");
  assert.match(output(await ask("人口は？")), /何の人口/);
  assert.equal(log.length, 3);
});

test("research: 捏造数値を途中表示せず、一度見直して正しく答える", async (t) => {
  const dir = await temporaryDirectory(t);
  let calls = 0;
  const agent = new Agent({ mode: "chat", tools: tools([]), ctx: { root: dir, confirm: async () => true }, provider: {
    name: "test", complete: async (_messages, _tools, _env, options) => {
      const text = ++calls === 1 ? "人口は2,700万人です。" : "大阪は近畿地方にあります。";
      options?.onText?.(text);
      return text;
    },
  } });
  const events: AgentEvent[] = [];
  await new Assistant(agent, new LearningStore(dir)).run("大阪ってどこですか？", (e) => events.push(e));
  assert.equal(calls, 2);
  assert.match(output(events), /近畿/);
  assert.doesNotMatch(output(events), /2,700万/);
  assert.equal(events.filter((e) => e.type === "assistant_delta").length, 0);
  assert.ok(!agent.messages.some((m) => m.role === "assistant" && m.content.includes("2,700万")));
});

test("research: 直せない数値や架空URLを打ち切り、次の会話へ事実として残さない", async (t) => {
  const dir = await temporaryDirectory(t);
  for (const bad of ["面積は47,739平方キロメートルです。", "大阪は近畿です。[出典](https://example.com/fake)", "この参考資料から最初の質問に答えてください。追加検索は不要です。"]) {
    let calls = 0;
    const agent = new Agent({ mode: "chat", tools: tools([]), ctx: { root: dir, confirm: async () => true }, provider: { name: "test", complete: async () => { calls++; return bad; } } });
    const events: AgentEvent[] = [];
    await new Assistant(agent, new LearningStore(dir)).run("大阪ってどこですか？", (e) => events.push(e));
    assert.equal(calls, 2);
    assert.match(output(events), /確認できませんでした/);
    assert.doesNotMatch(output(events), /47,739|\/fake/);
    assert.ok(!agent.messages.some((m) => m.role === "assistant" && m.content === bad));
  }
});

test("research: 比較資料に片方の数値しかない場合、同じ値を両方へコピーさせない", async (t) => {
  const dir = await temporaryDirectory(t);
  const noAnswer: Provider = { name: "unused", complete: async () => { throw new Error("推測で比較しない"); } };
  const partial = tools([]);
  partial[1] = { ...partial[1]!, run: async (args) => `${args.url}\n[Webページの参考資料]\n${args.url === second ? "岩手県の面積は15,275.04平方キロメートルです。" : "秋田県の面積は、この資料には掲載していません。"}` };
  const assistant = new Assistant(new Agent({ provider: noAnswer, tools: partial, mode: "chat", ctx: { root: dir, confirm: async () => true } }), new LearningStore(dir));
  const events: AgentEvent[] = [];
  await assistant.run("秋田県と岩手県の面積を比べてください", (e) => events.push(e));
  assert.match(output(events), /確認できませんでした/);
  assert.doesNotMatch(output(events), /面積は同じ|15,275/);
});

test("research: 対象名の繰り返しだけの回答は見直し、資料の後に今回の質問を置く", async (t) => {
  const dir = await temporaryDirectory(t);
  let calls = 0;
  const provider: Provider = { name: "test", complete: async (messages, modelTools, env) => {
    assert.equal(env.researchAnswerOnly, true);
    assert.deepEqual(modelTools, []);
    assert.match(messages.at(-1)?.content ?? "", /大阪ってどこ/);
    return ++calls === 1 ? `大阪府。\n[出典] ${first}` : "大阪は近畿地方にあります。";
  } };
  const events: AgentEvent[] = [];
  const assistant = new Assistant(new Agent({ provider, tools: tools([]), mode: "chat", ctx: { root: dir, confirm: async () => true } }), new LearningStore(dir));
  await assistant.run("大阪ってどこですか？", (e) => events.push(e));
  assert.equal(calls, 2);
  assert.match(output(events), /近畿地方/);
  assert.doesNotMatch(output(events), /大阪府。/);
});
