import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createMobileServer } from "../scripts/mobile-server.ts";
import { CONVERSATION_MODEL } from "../src/providers/origin-conversation.ts";

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
  let job: { status: string; answer: string; model: string; variant: string };
  do { await new Promise((done) => setTimeout(done, 5)); job = await (await fetch(base + "/jobs/" + id,
    { headers: { authorization: `Bearer ${"c".repeat(64)}` } })).json() as typeof job; } while (job.status === "running");
  assert.equal(emptyTools, true); assert.equal(job.answer, "会話の回答です。");
  assert.equal(job.model, CONVERSATION_MODEL); assert.equal(job.variant, "baseline");
});

test("mobile: reports a missing or wrong conversation model independently of the coding model", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let chat = "offline";
  globalThis.fetch = (async (url, init) => {
    if (String(url) === "http://127.0.0.1:18080/health") return Response.json({ready:true,base_repository:"Qwen/Qwen2.5-Coder-0.5B-Instruct",adapter_sha256:"fixture-adapter"});
    if (String(url) === "http://127.0.0.1:18083/health") {
      if (chat === "offline") throw Error("Unavailable");
      return Response.json({ready:true,base_repository:chat,adapter_sha256:null});
    }
    return original(url, init);
  }) as typeof fetch;
  const server = createMobileServer("e".repeat(64));
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address !== "string");
  for (chat of ["offline", "wrong-model", CONVERSATION_MODEL]) {
    const response = await fetch(`http://127.0.0.1:${address.port}/health`, {headers:{authorization:`Bearer ${"e".repeat(64)}`}});
    assert.equal(response.status,200);
    const health = await response.json() as {ready:boolean;models:{chat:{ready:boolean};code:{ready:boolean}}};
    assert.equal(health.models.code.ready,true);
    assert.equal(health.models.chat.ready,chat === CONVERSATION_MODEL);
    assert.equal(health.ready,chat === CONVERSATION_MODEL);
  }
});

test("mobile: empty answers and unavailable tool requests are failed jobs", async (t) => {
  let response = "   ";
  const server = createMobileServer("d".repeat(64), (variant, kind) => {
    assert.equal(variant, "baseline"); assert.equal(kind, "chat");
    return { name: "fixture", complete: async () => response };
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: `Bearer ${"d".repeat(64)}` };
  for (response of ["   ", '<tool name="web_search">{"query":"こんにちわ"}</tool>']) {
    const start = await fetch(base + "/jobs", { method: "POST", headers, body: JSON.stringify({kind:"chat",variant:"candidate",input:"こんにちわ"}) });
    assert.equal(start.status, 202);
    const { id } = await start.json() as {id:string};
    let job: { status:string; ok:boolean; reason:string };
    do { await new Promise((done) => setTimeout(done, 5)); job = await (await fetch(base + "/jobs/" + id, {headers})).json() as typeof job; } while (job.status === "running");
    assert.equal(job.status, "failed"); assert.equal(job.ok, false); assert.match(job.reason, /文章の回答/);
  }
});
