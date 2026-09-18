// v0.3の成長確認。ユーザーの記憶とは別の一時フォルダを使う。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { Agent } from "../src/agent.ts";
import { Assistant } from "../src/assistant.ts";
import { LearningStore } from "../src/learning.ts";
import { allTools } from "../src/tools/index.ts";
import { resolveProvider } from "../src/providers/index.ts";
import type { AgentEvent } from "../src/types.ts";

const provider = await resolveProvider("auto", process.argv[2]);
if (provider.name === "rule") throw new Error("Ollama のモデルを起動してから実行してください。");
const parent = resolve(tmpdir());
const directory = await mkdtemp(join(parent, "origin-agent-growth-"));
const create = () => new Assistant(new Agent({
  provider, tools: allTools, mode: "chat", maxSteps: 5,
  ctx: { root: directory, confirm: async () => true },
}), new LearningStore(directory));

async function ask(assistant: Assistant, input: string) {
  console.log(`\n> ${input}`);
  const events: AgentEvent[] = [];
  await assistant.run(input, (event) => {
    events.push(event);
    if (event.type === "assistant") console.log(event.text);
    if (event.type === "notice") console.log(`  ${event.message}`);
    if (event.type === "tool_start") console.log(`  ${event.name} ${JSON.stringify(event.args)}`);
    if (event.type === "tool_end" && !event.ok) console.log(`  ${event.result}`);
  });
  assert.ok(events.some((e) => e.type === "done" && e.reason === "answered"), "回答まで到達すること");
  const answer = events.filter((e): e is Extract<AgentEvent, { type: "assistant" }> => e.type === "assistant").at(-1)?.text ?? "";
  return { events, answer };
}

try {
  console.log(`頭脳: ${provider.name}`);
  let assistant = create();
  assert.match((await ask(assistant, "私の名前は何ですか？")).answer, /分かりません/);
  await ask(assistant, "私のことはハルと呼んで。覚えておいて。");
  assistant = create();
  assert.match((await ask(assistant, "私の名前は何でしたか？")).answer, /ハル/);
  await ask(assistant, "/forget 呼び方");
  assert.match((await ask(create(), "私の名前は何ですか？")).answer, /分かりません/);
  console.log("✓ 名前を捏造しない、保存、再起動相当の読み戻し、削除（プログラムで確認）");

  await ask(assistant, "/remember 話し方 短く、一つの例で説明してください");
  await ask(assistant, "JavaScriptの変数を初心者向けに説明して");
  await ask(assistant, "/feedback bad コード例は一つだけにしてほしい");
  assistant = create();
  const revised = await ask(assistant, "JavaScriptの変数を初心者向けに説明して");
  assert.ok(revised.events.some((e) => e.type === "notice" && /感想 1 件/.test(e.message)));
  console.log("✓ 保存した感想を、次の関連質問で参照（回答の質は表示内容で確認）");

  assistant.reset();
  const location = await ask(assistant, "つくばみらい市ってどこですか？");
  assert.ok(location.events.some((e) => e.type === "tool_end" && e.name === "web_search" && e.ok));
  assert.match(location.answer, /茨城/);
  assert.doesNotMatch(location.answer, /東北/);
  assert.match(location.answer, /https?:\/\//);
  console.log("✓ 普通の地名の質問から自動検索し、所在地と参照元を回答");

  assistant.reset();
  const timetable = await ask(assistant, "みらい平駅の時刻表を教えてください。");
  assert.ok(timetable.events.some((e) => e.type === "tool_end" && e.name === "web_search" && e.ok));
  assert.match(timetable.answer, /方面|平日|土日|休日/);
  assert.match(timetable.answer, /https?:\/\//);
  console.log("✓ 時刻表を自動検索し、方面・曜日の条件に言及");
  console.log("\n今回の成長確認は通過しました。回答の正確さや自然さは、他の質問でも継続して確かめてください。");
} finally {
  const rel = relative(parent, resolve(directory));
  if (isAbsolute(rel) || !rel.startsWith("origin-agent-growth-") || /[\\/]/.test(rel) || rel.includes("..")) {
    throw new Error("一時フォルダの範囲を確認できません。削除を中止します。");
  }
  await rm(directory, { recursive: true, force: true });
}
