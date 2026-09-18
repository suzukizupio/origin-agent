// 同じ短い質問で「最初の表示」と「回答完了」を分けて測る。各質問は独立した会話。
import { writeFile } from "node:fs/promises";
import { resolveProvider } from "../src/providers/index.ts";
import { allTools } from "../src/tools/index.ts";
import { buildSystemPrompt } from "../src/protocol.ts";
import type { CompletionStats } from "../src/types.ts";

let model = "qwen2.5-coder:3b";
let repeat = 2;
let out: string | undefined;
let buffered = false;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--buffered") { buffered = true; continue; }
  if (!["--model", "--repeat", "--out"].includes(arg ?? "")) throw new Error(`不明なオプション: ${arg}`);
  const value = process.argv[++i];
  if (!value || value.startsWith("--")) throw new Error(`${arg} の値を指定してください。`);
  if (arg === "--model") model = value;
  else if (arg === "--repeat") repeat = Number(value);
  else out = value;
}
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10) throw new Error("--repeat は1〜10です。");
const provider = await resolveProvider("ollama", model);
const tools = allTools.filter((tool) => tool.name.startsWith("web_"));
const env = { root: "", outline: "", mode: "chat" as const };
const questions = [
  "こんにちは。ひとことで挨拶してください。",
  "JavaScriptの変数を、初心者向けに2文で説明してください。",
  "私の名前はハルです。短く挨拶してください。",
];
const startedAt = new Date().toISOString();
const results: Array<{ round: number; question: string; firstTextMs: number; elapsedMs: number; answer: string; stats?: CompletionStats }> = [];
console.log(`モデル: ${provider.name} / 指示: ${buildSystemPrompt(tools, env).length}文字`);
console.log("モデルの起動直後や、他の処理・キャッシュの状態で時間は変わります。回答も保存して内容を確認します。");
for (let round = 1; round <= repeat; round++) {
  for (const question of questions) {
    const started = performance.now();
    let firstTextMs: number | undefined;
    let stats: CompletionStats | undefined;
    const answer = await provider.complete([{ role: "user", content: question }], tools, env, {
      onText: buffered ? undefined : (text) => { if (text.trim()) firstTextMs ??= performance.now() - started; },
      onStats: (value) => { stats = value; },
    });
    const elapsedMs = performance.now() - started;
    firstTextMs ??= elapsedMs;
    results.push({ round, question, firstTextMs: Math.round(firstTextMs), elapsedMs: Math.round(elapsedMs), answer, stats });
    console.log(`#${round} 最初 ${(firstTextMs / 1000).toFixed(1)}秒 / 完了 ${(elapsedMs / 1000).toFixed(1)}秒: ${answer.replace(/\s+/g, " ").slice(0, 110)}`);
  }
}
const mean = (key: "firstTextMs" | "elapsedMs") => Math.round(results.reduce((sum, item) => sum + item[key], 0) / results.length);
const report = { startedAt, provider: provider.name, buffered, repeat,
  promptChars: buildSystemPrompt(tools, env).length, meanFirstTextMs: mean("firstTextMs"), meanElapsedMs: mean("elapsedMs"), results };
if (out) await writeFile(out, JSON.stringify(report, null, 2) + "\n", "utf8");
console.log(`平均: 最初 ${(report.meanFirstTextMs / 1000).toFixed(1)}秒 / 完了 ${(report.meanElapsedMs / 1000).toFixed(1)}秒`);
