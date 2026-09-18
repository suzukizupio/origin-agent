import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { Agent } from "../src/agent.ts";
import { Assistant } from "../src/assistant.ts";
import { LearningStore } from "../src/learning.ts";
import { researchRoute } from "../src/routing.ts";
import { formatToolCall } from "../src/protocol.ts";
import type { AgentEvent, Provider, Tool } from "../src/types.ts";
import { temporaryDirectory } from "./helpers.ts";

const unused: Provider = { name: "unused", complete: async () => { throw new Error("モデルは使わない"); } };
function session(directory: string, provider = unused, tools: Tool[] = []) {
  return new Assistant(new Agent({ provider, tools, mode: "chat", ctx: { root: directory, confirm: async () => true } }), new LearningStore(directory));
}
async function ask(assistant: Assistant, input: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  await assistant.run(input, (e) => events.push(e));
  return events;
}
const output = (events: AgentEvent[]) => events.filter((e): e is Extract<AgentEvent, { type: "assistant" }> => e.type === "assistant").map((e) => e.text).join("\n");

test("assistant: 名前が未登録なら捏造せず、自然な指示で保存・再起動・削除できる", async (t) => {
  const directory = await temporaryDirectory(t);
  const first = session(directory);
  assert.match(output(await ask(first, "私の名前は何ですか？")), /分かりません/);
  await ask(first, "私のことはハルと呼んで。覚えておいて。");
  const next = session(directory);
  assert.match(output(await ask(next, "私の名前は何でしたか？")), /ハル/);
  await ask(next, "/remember 名前 ソラ");
  assert.match(output(await ask(next, "私の名前は何ですか？")), /ソラ/);
  await ask(next, "名前を忘れて");
  assert.match(output(await ask(session(directory), "私の名前は何ですか？")), /分かりません/);
});

test("assistant: 普通の自己紹介は会話中だけ参照し、勝手に永続保存しない", async (t) => {
  const directory = await temporaryDirectory(t);
  const first = session(directory, { name: "test", complete: async () => "こんにちは" });
  await ask(first, "私の名前はハルです。");
  assert.match(output(await ask(first, "私の名前は何でしたか？")), /ハル/);
  assert.equal((await new LearningStore(directory).read()).memories.length, 0);
  assert.match(output(await ask(session(directory), "私の名前は何ですか？")), /分かりません/);
});

test("assistant: 保存した好みと、直前の回答に付けた感想を次の関連質問へ渡す", async (t) => {
  const directory = await temporaryDirectory(t);
  let context = "";
  const assistant = session(directory, { name: "test", complete: async (_messages, _tools, env) => { context = env.knowledge ?? ""; return "TypeScriptの説明"; } });
  await ask(assistant, "/remember 話し方 短く答えて");
  await ask(assistant, "TypeScriptとは");
  assert.match(context, /短く答えて/);
  await ask(assistant, "/feedback bad 具体例を一つ添えてほしい");
  assistant.reset();
  const events = await ask(assistant, "TypeScriptを説明して");
  assert.match(context, /具体例/);
  assert.ok(events.some((e) => e.type === "notice" && /感想 1 件/.test(e.message)));
  const feedback = (await new LearningStore(directory).read()).feedback[0]!;
  assert.equal(feedback.question, "TypeScriptとは");
  assert.equal(feedback.answer, "TypeScriptの説明");
});

test("research: 時刻表や地名の普通の質問でも、モデルより先に検索する", async (t) => {
  const directory = await temporaryDirectory(t);
  const order: string[] = [];
  const search: Tool = { name: "web_search", description: "test", params: [], run: async (args) => { order.push("search"); assert.match(String(args.query), /みらい平駅/); return "URL: https://example.com/station\n平日と休日、方面で時刻表が分かれます。"; } };
  const assistant = session(directory, { name: "test", complete: async (_messages, _tools, env) => { assert.equal(env.research, true); order.push("answer"); return "どちら方面の時刻表ですか？"; } }, [search]);
  const events = await ask(assistant, "みらい平駅の時刻表を教えてください。");
  assert.deepEqual(order, ["search", "answer"]);
  assert.match(output(events), /https:\/\/example.com\/station/);
  assert.equal(researchRoute("つくばみらい市ってどこですか？", "chat").firstCall?.name, "web_search");
  assert.equal(researchRoute("松本市は何県ですか？", "chat").firstCall?.name, "web_search");
});

test("research: 検索の失敗を、モデルの推測で埋めない", async (t) => {
  const directory = await temporaryDirectory(t);
  const search: Tool = { name: "web_search", description: "test", params: [], run: async () => { throw new Error("接続失敗"); } };
  assert.match(output(await ask(session(directory, unused, [search]), "今日の東京の天気を教えて")), /調べられませんでした/);
});

test("research: 拒否された検索を再実行しない", async (t) => {
  const directory = await temporaryDirectory(t);
  let calls = 0;
  const search: Tool = { name: "web_search", description: "test", params: [], run: async (_args, ctx) => { calls++; await ctx.confirm("検索しますか"); return "ユーザーが検索を拒否しました。"; } };
  const assistant = session(directory, unused, [search]);
  assistant.agent.ctx.confirm = async () => false;
  assert.match(output(await ask(assistant, "今日の天気を教えて")), /拒否/);
  assert.equal(calls, 1);
});

test("research: オフライン指定ではモデルが検索を要求しても実行しない", async (t) => {
  const directory = await temporaryDirectory(t);
  let calls = 0;
  const search: Tool = { name: "web_search", description: "test", params: [], run: async () => { calls++; return "結果"; } };
  const provider: Provider = { name: "test", complete: async (messages) => messages.at(-1)?.role === "tool" ? "検索せず回答します" : formatToolCall("web_search", { query: "天気" }) };
  await ask(session(directory, provider, [search]), "検索しないで、天気の仕組みを教えて");
  assert.equal(calls, 0);
  assert.equal(researchRoute("時刻表を表示するコードを書いて", "code").firstCall, undefined);
  assert.equal(researchRoute("天気とは何ですか？", "chat").firstCall, undefined);
  assert.equal(researchRoute("こんにちは", "chat").firstCall, undefined);
});

test("CLI: 別プロセスで記憶を再利用し、削除後は忘れる", async (t) => {
  const directory = await temporaryDirectory(t);
  const run = (input: string) => {
    const result = spawnSync(process.execPath, [resolve("src/cli.ts"), "--provider", "rule", "--data-dir", directory], { input, encoding: "utf8", timeout: 10_000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  assert.match(run("/remember 呼び方 ハル\n/exit\n"), /保存しました/);
  assert.match(run("私の名前は何ですか？\n/forget 呼び方\n/exit\n"), /ハルさん/);
  assert.match(run("私の名前は何ですか？\n/exit\n"), /分かりません/);
});
