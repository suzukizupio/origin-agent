import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { formatToolCall } from "../src/protocol.ts";
import { temporaryDirectory } from "./helpers.ts";

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
});
