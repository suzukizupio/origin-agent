import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { formatToolCall } from "../src/protocol.ts";
import { temporaryDirectory } from "./helpers.ts";
import { tasks } from "../scripts/eval-tasks.ts";
import type { TaskResult } from "../scripts/eval-tasks.ts";

test("eval: 実行した操作・最終回答・失敗理由を成功失敗ともに保存する", async (t) => {
  const root = await temporaryDirectory(t);
  let response = "";
  const server = createServer(async (req, res) => {
    // 小さなモデルを模擬し、1回目は更新、2回目は何もせず終了する。
    for await (const _chunk of req) { /* drain */ }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ message: { content: response } }));
    response = "終了しました";
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => { server.closeAllConnections(); return new Promise<void>((done) => server.close(() => done())); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  response = formatToolCall("edit_json", { path: "settings.json", key: "language", value: "ja" });
  const out = join(root, "report.json");
  await promisify(execFile)(process.execPath, [resolve("scripts/eval.ts"), "--provider", "ollama", "--only", "add-field", "--repeat", "2", "--out", out], {
    env: { ...process.env, OLLAMA_HOST: `http://127.0.0.1:${address.port}` }, windowsHide: true, timeout: 15_000,
  });
  const report = JSON.parse(await readFile(out, "utf8"));
  assert.equal(report.passed, 1);
  assert.equal(report.total, 2);
  assert.equal(report.completed, true);
  const task = report.tasks[0];
  assert.ok(task.tools.includes("edit_json"));
  assert.equal(task.attempts[0].ok, true);
  const operation = task.attempts[0].trace[0].events.filter((event: { type: string }) => event.type === "tool_start" || event.type === "tool_end");
  assert.equal(operation[0].name, "edit_json");
  assert.equal(operation[1].ok, true);
  assert.equal(task.attempts[1].ok, false);
  assert.match(task.attempts[1].reason, /language/);
  assert.ok(task.attempts[1].trace[0].events.some((event: { type: string; text?: string }) => event.type === "assistant" && event.text === "終了しました"));
  const partial = join(root, "partial.json");
  await writeFile(partial, JSON.stringify({ ...report, completed: false }));
  await assert.rejects(promisify(execFile)(process.execPath, [resolve("scripts/eval.ts"), "--provider", "ollama", "--only", "add-field", "--compare", partial], {
    env: { ...process.env, OLLAMA_HOST: `http://127.0.0.1:${address.port}` }, windowsHide: true, timeout: 15_000,
  }), /途中の採点結果/);

  response = "記載なし";
  const dailyOut = join(root, "daily.json");
  await promisify(execFile)(process.execPath, [resolve("scripts/eval.ts"), "--provider", "ollama", "--suite", "daily", "--only", "daily-missing-info", "--repeat", "1", "--out", dailyOut], {
    env: { ...process.env, OLLAMA_HOST: `http://127.0.0.1:${address.port}` }, windowsHide: true, timeout: 15_000,
  });
  const daily = JSON.parse(await readFile(dailyOut, "utf8"));
  assert.equal(daily.suite, "daily");
  assert.equal(daily.completed, true);
  assert.equal(daily.passed, 1);
  assert.deepEqual(daily.tasks[0].tools, []);
  assert.equal(daily.tasks[0].attempts[0].trace[0].input.includes("メモ"), true);
});


test("eval daily: モデルなしで課題を一覧表示でき、選択とオプションを検証する", async () => {
  const run = (...args: string[]) => promisify(execFile)(process.execPath, [resolve("scripts/eval.ts"), ...args], {
    env: { ...process.env, OLLAMA_HOST: "http://127.0.0.1:1" }, windowsHide: true, timeout: 10_000,
  });
  const result = await run("--suite", "daily", "--offline", "--list");
  assert.equal(result.stdout.trim().split("\n").length, 7);
  assert.match(result.stdout, /daily-followup/);
  assert.doesNotMatch(result.stdout, /port-change|location-search/);
  const selected = await run("--suite", "daily", "--only", "daily-update", "--list");
  assert.equal(selected.stdout.trim().split("\n").length, 1);
  await assert.rejects(run("--suite", "unknown", "--list"), /all または daily/);
  await assert.rejects(run("--suite", "daily", "--only", "port-change", "--list"), /走らせる課題がありません/);
  await assert.rejects(run("--suite", "daily", "--provider", "rule"), /採点には言語モデル/);
});

test("eval daily: 各採点条件は正答と代表的な誤答を区別し、外部ツールを渡さない", async () => {
  const answers: Record<string, [string, string]> = {
    "daily-rewrite": ["金曜日14時、図書室で読書会。\n持ち物は本です。", "読書会をします。"],
    "daily-followup": ["候補Bは夜に復習20分です。", "候補Aは朝に読書です。"],
    "daily-update": ["2,000円", "5000円"],
    "daily-correction": ["木曜日", "水曜日"],
    "daily-summary": ["- 水曜日10時、会議室A\n- 持ち物：ノート", "勉強会があります。"],
    "daily-missing-info": ["記載なし", "責任者は山田さんです。"],
    "daily-clarify": ["何と何を比較したいですか？", "こちらの方がおすすめです。"],
  };
  const selected = tasks.filter((task) => task.suite === "daily");
  assert.equal(selected.length, Object.keys(answers).length);
  for (const task of selected) {
    assert.equal(task.mode, "chat");
    assert.deepEqual(task.tools, []);
    assert.notEqual(task.network, true);
    const [good, bad] = answers[task.id]!;
    const result = (answer: string): TaskResult => ({ answer, events: [], root: "", read: async () => { throw new Error("読まない"); } });
    await task.check(result(good));
    await assert.rejects(async () => task.check(result(bad)), { name: "AssertionError" }, task.id);
  }
});
