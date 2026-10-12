import { test } from "node:test";
import assert from "node:assert/strict";
import { createOriginConversationProvider, isQuestionEcho } from "../src/providers/origin-conversation.ts";

const question = "こんにちは。あなたは何ができますか？";
const echo = "こんにちは。あなたが何ができますか？";
const env = { root: "", outline: "", mode: "chat" as const };

test("conversation: detects the reported near-echo while preserving greetings and requested quotations", () => {
  assert.equal(isQuestionEcho(question, echo), true);
  assert.equal(isQuestionEcho(question, question), true);
  assert.equal(isQuestionEcho("こんにちは", "こんにちは"), false);
  assert.equal(isQuestionEcho("次の質問をそのまま復唱して：何ができますか？", "次の質問をそのまま復唱して：何ができますか？"), false);
  assert.equal(isQuestionEcho(question, "文章の作成、要約、コードの説明をお手伝いできます。"), false);
});

test("conversation: uses its own model and retries an echoed question once before publishing text", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let calls = 0;
  const answer = "文章の作成や要約、コードの説明をお手伝いできます。";
  globalThis.fetch = (async (url, init) => {
    assert.equal(url, "http://127.0.0.1:18083/v1/completions");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.variant, "baseline");
    if (calls > 0) assert.match(body.messages.at(-1).content, /質問への答え/);
    return Response.json({ variant: "baseline", text: calls++ === 0 ? echo : answer, finish_reason: "eos" });
  }) as typeof fetch;
  const published: string[] = [];
  const result = await createOriginConversationProvider().complete([{role:"user",content:question}], [], env, {onText:text=>published.push(text)});
  assert.equal(result, answer); assert.equal(calls, 2); assert.deepEqual(published, [answer]);
});

test("conversation: a second echo is an error and is never presented as an answer", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json({variant:"baseline",text:echo,finish_reason:"eos"}); }) as typeof fetch;
  const published: string[] = [];
  await assert.rejects(() => createOriginConversationProvider().complete([{role:"user",content:question}],[],env,{onText:text=>published.push(text)}), /質問を繰り返した/);
  assert.equal(calls, 2); assert.deepEqual(published, []);
});
