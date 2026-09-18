import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { temporaryDirectory } from "./helpers.ts";

test("CLI: 最後のデータが来る前に表示し、回答を重複させず /stats で時間を出す", { timeout: 15_000 }, async (t) => {
  const directory = await temporaryDirectory(t);
  let response: ServerResponse | undefined;
  let doneSent = false;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    assert.equal(JSON.parse(body).stream, true);
    response = res;
    res.setHeader("content-type", "application/x-ndjson");
    res.write(JSON.stringify({ message: { content: "返答の先頭です" }, done: false }) + "\n");
    // 子プロセスが表示したことを確認するまで、最終データを送らない。
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => { server.closeAllConnections(); return new Promise<void>((done) => server.close(() => done())); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const child = spawn(process.execPath, [resolve("src/cli.ts"), "--provider", "ollama", "--model", "test", "--data-dir", directory], {
    env: { ...process.env, OLLAMA_HOST: `http://127.0.0.1:${address.port}` }, windowsHide: true,
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text: string) => { errors += text; });
  child.stdout.on("data", (text: string) => {
    output += text;
    if (output.includes("返答の先頭です") && !doneSent) {
      doneSent = true;
      response!.end(JSON.stringify({ message: { content: "。完了しました。" }, done: true, eval_count: 9, eval_duration: 1_000_000 }));
    }
  });
  child.stdin.end("こんにちは\n/stats\n/exit\n");
  const code = await new Promise<number | null>((done, fail) => { child.once("error", fail); child.once("exit", done); });
  assert.equal(code, 0, errors);
  assert.equal(doneSent, true);
  assert.equal(output.split("返答の先頭です").length - 1, 1);
  assert.match(output, /返答の先頭です。完了しました。/);
  assert.match(output, /最初の表示/);
  assert.match(output, /出力 9トークン/);
});
