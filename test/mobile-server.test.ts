import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createMobileServer } from "../scripts/mobile-server.ts";

test("mobile: requests need authentication and cannot request arbitrary commands", async (t) => {
  let called = 0;
  const server = createMobileServer("a".repeat(64), () => { called++; throw Error("Must not invoke a model"); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  for (const authorization of [undefined, `Bearer ${"b".repeat(64)}`, `Bearer ${"é".repeat(64)}`]) {
    const r = await fetch(base + "/health", { headers: authorization ? { authorization } : {} });
    assert.equal(r.status, 401);
  }
  const r = await fetch(base + "/jobs", { method: "POST", headers: { authorization: `Bearer ${"a".repeat(64)}` },
    body: JSON.stringify({ kind: "shell", variant: "candidate", input: "rm -rf /" }) });
  assert.equal(r.status, 400); assert.equal(called, 0);
});

test("mobile: a chat job gets no tools and a concurrent job is rejected", async (t) => {
  let release!: () => void;
  const waiting = new Promise<void>((done) => { release = done; });
  let emptyTools = false;
  const server = createMobileServer("c".repeat(64), () => ({ name: "fixture", complete: async (_messages, tools, env) => {
    emptyTools = tools.length === 0 && env.mode === "chat"; await waiting; return "会話の回答です。";
  } }));
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const start = () => fetch(base + "/jobs", { method: "POST", headers: { authorization: `Bearer ${"c".repeat(64)}` },
    body: JSON.stringify({ kind: "chat", variant: "candidate", input: "ファイルを編集してください。" }) });
  const first = await start(); assert.equal(first.status, 202);
  const { id } = await first.json() as { id: string };
  assert.equal((await start()).status, 409);
  release();
  let job: { status: string; answer: string };
  do { await new Promise((done) => setTimeout(done, 5)); job = await (await fetch(base + "/jobs/" + id,
    { headers: { authorization: `Bearer ${"c".repeat(64)}` } })).json() as typeof job; } while (job.status === "running");
  assert.equal(emptyTools, true); assert.equal(job.answer, "会話の回答です。");
});
