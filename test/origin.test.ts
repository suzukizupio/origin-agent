import { test } from "node:test";
import assert from "node:assert/strict";
import { createOriginProvider, originHost, originMessages } from "../src/providers/origin.ts";
import { createProvider } from "../src/providers/index.ts";
import { ProviderTimeoutError } from "../src/types.ts";

test("origin: curated SFT and inference share the system prompt and tool-result wrapper", () => {
  const messages = originMessages([{ role: "user", content: "作業してください" }, { role: "tool", toolName: "read_file", content: "実物" }], [], { root: "fixture", outline: "src/file.js", mode: "code" });
  assert.equal(messages[0]?.role, "system");
  assert.match(messages[0]?.content ?? "", /src\/file.js/);
  assert.equal(messages[2]?.content, "[あなたが呼び出した read_file の出力]\n実物\n\nこの結果を踏まえ、必要ならツールを呼んで作業を続けてください。");
  assert.equal(createProvider("origin", "baseline").name, "origin:baseline");
  assert.throws(() => createProvider("origin", "unknown"), /baseline.*candidate/);
});

test("origin: selects local endpoints and never sends inference to external hosts", () => {
  assert.equal(originHost("http://127.0.0.1:18080"), "http://127.0.0.1:18080");
  for (const host of ["https://example.com", "http://example.com", "http://localhost/path", "http://user:pass@localhost", "http://localhost/?token=secret"]) assert.throws(() => originHost(host), /ローカル/);
});

test("origin: tool-free mobile conversations preserve history without advertising unavailable tools", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const history = [{ role: "user" as const, content: "こんにちわ" }, { role: "assistant" as const, content: "こんにちは" }, { role: "user" as const, content: "ありがとう" }];
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.variant, "candidate");
    assert.match(body.messages[0].content, /Japanese/);
    assert.doesNotMatch(body.messages[0].content, /web_search|<tool|\/mode|\/remember/);
    assert.deepEqual(body.messages.slice(1), history);
    return Response.json({ variant: "candidate", text: "どういたしまして。", finish_reason: "eos" });
  }) as typeof fetch;
  const provider = createOriginProvider({ conversationOnly: true });
  const env = { root: "", outline: "", mode: "chat" as const };
  assert.equal(await provider.complete(history, [], env), "どういたしまして。");
  await assert.rejects(() => provider.complete([{ role: "tool", content: "検索結果" }], [], env), /会話専用/);
  await assert.rejects(() => provider.complete(history, [], { ...env, mode: "code" }), /会話専用/);
});

test("origin: completed generation passes text and metrics through the Provider interface", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = (async (_url, init) => {
    assert.equal(init?.redirect, "error");
    const body = JSON.parse(String(init?.body)) as { variant: string; messages: Array<{ role: string }> };
    assert.equal(body.variant, "candidate"); assert.equal(body.messages[0]?.role, "system");
    return new Response(JSON.stringify({ variant: "candidate", text: "回答", finish_reason: "eos", prompt_tokens: 5, output_tokens: 2, elapsed_ms: 10 }));
  }) as typeof fetch;
  let text = "";
  let tokens = 0;
  const result = await createOriginProvider().complete([{ role: "user", content: "質問" }], [], { root: "", outline: "" }, { onText: (value) => { text += value; }, onStats: (stats) => { tokens = stats.outputTokens ?? 0; } });
  assert.equal(result, "回答"); assert.equal(text, result); assert.equal(tokens, 2);
});

test("origin: does not accept truncated output, wrong variants, empty output or HTTP failures", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const ask = () => createOriginProvider().complete([], [], { root: "", outline: "" });
  for (const data of [{ variant: "candidate", text: "partial", finish_reason: "length" }, { variant: "baseline", text: "wrong model", finish_reason: "eos" }, { variant: "candidate", text: "", finish_reason: "eos" }]) {
    globalThis.fetch = (async () => new Response(JSON.stringify(data))) as typeof fetch;
    await assert.rejects(ask);
  }
  globalThis.fetch = (async () => new Response("server error", { status: 500 })) as typeof fetch;
  await assert.rejects(ask, /HTTP 500/);
  globalThis.fetch = (async () => new Response(JSON.stringify({ variant: "candidate", text: "partial", finish_reason: "timeout" }))) as typeof fetch;
  await assert.rejects(ask, ProviderTimeoutError);
});

test("origin: treats a request timeout as an incomplete task", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = (async () => { const error = new Error("simulated"); error.name = "TimeoutError"; throw error; }) as typeof fetch;
  await assert.rejects(() => createOriginProvider({ timeoutMs: 1000 }).complete([], [], { root: "", outline: "" }), ProviderTimeoutError);
});

test("origin: a timeout while receiving the body is also an incomplete task", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = (async () => {
    const response = new Response();
    Object.defineProperty(response, "text", { value: async () => { throw new DOMException("Body timed out", "TimeoutError"); } });
    return response;
  }) as typeof fetch;
  await assert.rejects(() => createOriginProvider({ timeoutMs: 1000 }).complete([], [], { root: "", outline: "" }), ProviderTimeoutError);
});
