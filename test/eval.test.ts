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
  let stall = false;
  let requests = 0;
  const server = createServer(async (req, res) => {
    // 小さなモデルを模擬し、1回目は更新、2回目は何もせず終了する。
    for await (const _chunk of req) { /* drain */ }
    requests++;
    if (stall) return;
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
  assert.equal(task.attempts[1].failureKind, "check_failed");
  // Dockerの読み取り専用worktreeでは、ホスト側の.git参照が見えない場合もある。
  if (report.sourceCommit !== undefined) assert.match(report.sourceCommit, /^[a-f0-9]{40,64}$/);
  if (report.sourceDirty !== undefined) assert.equal(typeof report.sourceDirty, "boolean");
  assert.equal(report.nodeVersion, process.version);
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

  stall = true;
  const before = requests;
  const timeoutOut = join(root, "timeout.json");
  const evaluate = (outPath: string) => promisify(execFile)(process.execPath, [resolve("scripts/eval.ts"), "--provider", "ollama", "--suite", "daily", "--only", "daily-correction", "--repeat", "1", "--timeout", "0.1", "--out", outPath], {
    env: { ...process.env, OLLAMA_HOST: `http://127.0.0.1:${address.port}` }, windowsHide: true, timeout: 15_000,
  });
  await evaluate(timeoutOut);
  const timed = JSON.parse(await readFile(timeoutOut, "utf8"));
  assert.equal(timed.passed, 0);
  assert.equal(timed.tasks[0].attempts[0].failureKind, "timeout");
  assert.equal(timed.tasks[0].attempts[0].trace.length, 1, "時間切れの後の会話で成功を装わない");
  assert.equal(requests - before, 1);
  stall = false;
  response = "";
  const errorOut = join(root, "error.json");
  await evaluate(errorOut);
  assert.equal(JSON.parse(await readFile(errorOut, "utf8")).tasks[0].attempts[0].failureKind, "provider_error");
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


test("eval review: モデルなしで保存済みの失敗・所要時間・条件差を表示する", async (t) => {
  const root = await temporaryDirectory(t);
  const attempt = { ok: false, ms: 120000, reason: "時間切れ", failureKind: "timeout", trace: [
    { input: "要約して", restart: false, events: [{ type: "assistant", text: "未完了です" }] },
  ] };
  const data = { provider: "ollama:fake", completed: true, repeat: 1, passed: 0, total: 1, timeoutSec: 120, tasks: [
    { id: "daily-example", title: "要約", passed: 0, total: 1, meanMs: 120000, failures: ["時間切れ"], attempts: [attempt] },
  ] };
  const file = join(root, "report.json"), old = join(root, "old.json");
  await writeFile(file, JSON.stringify(data));
  await writeFile(old, JSON.stringify({ ...data, provider: "ollama:other", timeoutSec: 300 }));
  const run = (...args: string[]) => promisify(execFile)(process.execPath, [resolve("scripts/eval.ts"), "--review", file, ...args], {
    env: { ...process.env, OLLAMA_HOST: "http://127.0.0.1:1" }, timeout: 10000, windowsHide: true,
  });
  const { stdout } = await run("--compare", old);
  for (const text of ["モデル時間切れ: 1件", "要約して", "未完了です", "120.0秒", "比較条件に違い: provider", "比較条件に違い: timeoutSec"]) assert.ok(stdout.includes(text), text);
  assert.equal(await readFile(file, "utf8"), JSON.stringify(data));
  await assert.rejects(run("--only", "missing"), /指定した課題/);
  await assert.rejects(run("--out", old), /併用できません/);
  await writeFile(file, JSON.stringify({ ...data, completed: false, tasks: [{ ...data.tasks[0], attempts: undefined }] }));
  assert.match((await run()).stdout, /途中の結果/);
  assert.match((await run()).stdout, /試行の履歴なし/);
  await writeFile(file, JSON.stringify({ ...data, passed: 1 }));
  await assert.rejects(run(), /形式または集計が不正/);
  await writeFile(file, '{bad');
  await assert.rejects(run(), /エラー:/);
});

test("eval review: holdoutの内容を表示せず、端末制御文字も無効化する", async (t) => {
  const root = await temporaryDirectory(t);
  const file = join(root, "holdout.json");
  const data = { provider: "fake", completed: true, repeat: 1, passed: 0, total: 1, tasks: [
    { id: "holdout-secret", title: "SECRET_TITLE", passed: 0, total: 1, meanMs: 10, failures: ["SECRET_REASON"] },
  ] };
  const run = () => promisify(execFile)(process.execPath, [resolve("scripts/eval.ts"), "--review", file], { timeout: 10000, windowsHide: true });
  await writeFile(file, JSON.stringify(data));
  const result = await run();
  assert.match(result.stdout, /holdoutを含む/);
  assert.doesNotMatch(result.stdout, /SECRET|holdout-secret/);
  await writeFile(file, JSON.stringify({ ...data, tasks: [{ ...data.tasks[0], id: "normal", title: "\u001b[2Jtitle" }] }));
  assert.doesNotMatch((await run()).stdout, /\u001b/);
});
