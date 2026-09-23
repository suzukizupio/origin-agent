// ollama プロバイダの、通信まわりの振る舞いを通信なしで確かめる。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createOllamaProvider } from "../src/providers/ollama.ts";
import type { CompletionStats } from "../src/types.ts";

function failingFetch(name: string): typeof fetch {
  return (async () => {
    const error = new Error("simulated");
    error.name = name;
    throw error;
  }) as typeof fetch;
}

async function completeOnce(provider: ReturnType<typeof createOllamaProvider>): Promise<unknown> {
  return provider.complete([{ role: "user", content: "こんにちは" }], [], { root: "", outline: "" });
}

test("ollama: 待ち時間切れを「接続できない・インストールして」と表示しない", async () => {
  // 以前は待ち時間切れも接続失敗と同じ文言になり、7B の採点で原因を取り違える恐れがあった
  const original = globalThis.fetch;
  globalThis.fetch = failingFetch("TimeoutError");
  try {
    await assert.rejects(
      () => completeOnce(createOllamaProvider({ model: "test-model", timeoutMs: 1_000 })),
      (error: Error) => {
        assert.match(error.message, /1 秒以内に返りませんでした/);
        assert.doesNotMatch(error.message, /インストール/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("ollama: 本当に接続できないときは、従来どおり起動方法を案内する", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = failingFetch("TypeError");
  try {
    await assert.rejects(
      () => completeOnce(createOllamaProvider({ model: "test-model" })),
      /接続できません/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("ollama: 待ち時間の上限は環境変数で上書きできる", async () => {
  const original = globalThis.fetch;
  const previous = process.env.ORIGIN_OLLAMA_TIMEOUT_MS;
  globalThis.fetch = failingFetch("TimeoutError");
  process.env.ORIGIN_OLLAMA_TIMEOUT_MS = "300000";
  try {
    await assert.rejects(
      () => completeOnce(createOllamaProvider({ model: "test-model" })),
      /300 秒以内に返りませんでした/,
    );
  } finally {
    globalThis.fetch = original;
    if (previous === undefined) delete process.env.ORIGIN_OLLAMA_TIMEOUT_MS;
    else process.env.ORIGIN_OLLAMA_TIMEOUT_MS = previous;
  }
});

test("ollama: 資料から答える段階では短い生成にし、既定の待ち時間を60秒にする", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let request: { options: { num_ctx: number; num_predict: number }; messages: Array<{ role: string; content: string }> } | undefined;
  globalThis.fetch = (async (_url, init) => {
    request = JSON.parse(String(init?.body)) as typeof request;
    return new Response(JSON.stringify({ message: { content: "回答" } }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const env = { root: "", outline: "", researchAnswerOnly: true };
  assert.equal(await createOllamaProvider().complete([{ role: "tool", toolName: "web_fetch", content: "所在地の資料" }], [], env), "回答");
  assert.deepEqual(request?.options, { temperature: 0.2, num_ctx: 8192, num_predict: 256, repeat_penalty: 1.15 });
  assert.equal(request?.messages.at(-1)?.content, "[参考資料]\n所在地の資料");

  globalThis.fetch = failingFetch("TimeoutError");
  await assert.rejects(createOllamaProvider().complete([], [], env), /60 秒以内に返りませんでした/);
});

test("ollama: UTF-8とJSONの分割を復元し、完了前に文字を渡す", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  let first!: () => void;
  const firstText = new Promise<void>((resolve) => { first = resolve; });
  globalThis.fetch = (async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).stream, true);
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { headers: { "content-type": "application/x-ndjson" } });
  }) as typeof fetch;
  let text = "";
  let metrics: CompletionStats | undefined;
  let completed = false;
  const pending = createOllamaProvider().complete([], [], { root: "", outline: "" }, {
    onText: (chunk) => { text += chunk; first(); }, onStats: (stats) => { metrics = stats; },
  }).then((answer) => { completed = true; return answer; });
  // fetch の返却から本文読み込みへ進むまで待つ。
  await Promise.resolve();
  const bytes = encoder.encode(JSON.stringify({ message: { content: "こんにちは🌱" }, done: false }) + "\r\n");
  for (const byte of bytes) stream.enqueue(Uint8Array.of(byte));
  await firstText;
  assert.equal(text, "こんにちは🌱");
  assert.equal(completed, false);
  stream.enqueue(encoder.encode(JSON.stringify({ message: { content: "。" }, done: true, prompt_eval_count: 12, eval_count: 3, eval_duration: 2_000_000, load_duration: 1_000_000 })));
  stream.close();
  assert.equal(await pending, "こんにちは🌱。");
  assert.equal(metrics?.outputTokens, 3);
  assert.equal(metrics?.generationMs, 2);
  assert.equal(metrics?.loadMs, 1);
});

test("ollama: ストリームの切断・エラー・不正JSONを成功として返さない", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  for (const [body, message] of [
    ['{"message":{"content":"途中"},"done":false}\n', /途中で途切れ/],
    ['{"error":"処理失敗"}\n', /処理失敗/],
    ['{broken}\n', /不正なJSON/],
  ] as const) {
    globalThis.fetch = (async () => new Response(body, { headers: { "content-type": "application/x-ndjson" } })) as typeof fetch;
    await assert.rejects(createOllamaProvider().complete([], [], { root: "", outline: "" }, { onText: () => {} }), message);
  }
});

test("ollama: 本文受信中の待ち時間切れも区別し、通常JSONの応答にも対応する", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = (async () => new Response(new ReadableStream({ start(controller) {
    controller.error(new DOMException("timeout", "TimeoutError"));
  } }), { headers: { "content-type": "application/x-ndjson" } })) as typeof fetch;
  await assert.rejects(createOllamaProvider({ timeoutMs: 1000 }).complete([], [], { root: "", outline: "" }, { onText: () => {} }), /1 秒以内/);
  let streamed = "";
  globalThis.fetch = (async () => new Response(JSON.stringify({ message: { content: "一括の応答" } }), { headers: { "content-type": "application/json" } })) as typeof fetch;
  assert.equal(await createOllamaProvider().complete([], [], { root: "", outline: "" }, { onText: (text) => { streamed += text; } }), "一括の応答");
  assert.equal(streamed, "一括の応答");
});
