// 実際のローカルモデルとネット検索で、小さな到達点を確かめる。
// モデルの重みは更新しない。定量的な能力評価の前段階となる動作確認。
import assert from "node:assert/strict";
import { Agent } from "../src/agent.ts";
import { allTools } from "../src/tools/index.ts";
import { resolveProvider } from "../src/providers/index.ts";
import type { AgentEvent } from "../src/types.ts";

const provider = await resolveProvider("auto", process.argv[2]);
if (provider.name === "rule") throw new Error("Ollama のモデルを起動してから実行してください。");
console.log(`頭脳: ${provider.name}`);
const agent = new Agent({
  provider, tools: allTools, mode: "chat", maxSteps: 5,
  // このスクリプトは既知の検索語・公開ページを使う。ファイル操作は許可しない。
  ctx: { root: process.cwd(), confirm: async () => true },
});

async function ask(input: string, firstCall?: { name: string; args: Record<string, unknown> }) {
  console.log(`\n> ${input}`);
  const events: AgentEvent[] = [];
  await agent.run(input, (event) => {
    events.push(event);
    if (event.type === "assistant") console.log(event.text);
    if (event.type === "tool_start") console.log(`  ツール: ${event.name}`);
    if (event.type === "tool_end") console.log(`  結果: ${event.ok ? "取得" : "エラー"} ${event.result.slice(0, 120)}`);
  }, firstCall);
  assert.ok(events.some((event) => event.type === "done" && event.reason === "answered"), "回答まで到達すること");
  return events;
}

await ask("こんにちは。私の名前はハルです。これから一緒にAIを育てたいです。短く挨拶してください。");
const memory = await ask("私の名前は何でしたか？");
assert.ok(memory.some((event) => event.type === "assistant" && /ハル/.test(event.text)), "同じ会話で伝えた名前を回答できること");
assert.ok(memory.every((event) => event.type !== "tool_start"), "名前の確認にツールは不要");
console.log("✓ 会話と、会話中に伝えた名前の確認");

agent.reset();
const research = await ask("TypeScriptがどんな言語か、ネットで調べて日本語で短く教えて。参照元のURLも付けて。", {
  name: "web_search", args: { query: "TypeScript 公式 とは" },
});
assert.ok(research.some((event) => event.type === "tool_end" && event.name === "web_search" && event.ok), "検索が成功すること");
const answer = research.filter((event): event is Extract<AgentEvent, { type: "assistant" }> => event.type === "assistant").at(-1)?.text ?? "";
assert.match(answer, /[ぁ-んァ-ヶ]/, "日本語の回答であること");
assert.match(answer, /https?:\/\//, "参照元を含むこと");
const sourceUrls = research.filter((event): event is Extract<AgentEvent, { type: "tool_end" }> => event.type === "tool_end" && event.ok).map((event) => event.result).join("\n");
for (const match of answer.matchAll(/https?:\/\/[^\s)\]<>「」]+/g)) {
  assert.ok(sourceUrls.includes(match[0]), `取得結果にあるURLを参照すること: ${match[0]}`);
}
console.log("✓ ネット検索、日本語の回答、取得した参照元の提示");
console.log("\n小さな到達点を確認できました。回答内容の正確さや自然さは、表示された会話でも確認してください。");
