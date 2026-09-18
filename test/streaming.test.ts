import { test } from "node:test";
import assert from "node:assert/strict";
import { createTextPreview, ReplyPrinter } from "../src/streaming.ts";
import { Agent } from "../src/agent.ts";
import { formatToolCall } from "../src/protocol.ts";
import type { AgentEvent } from "../src/types.ts";

test("streaming: 分割されたツール構文を表示せず、普通の文字は完了前に表示する", () => {
  const chunks: string[] = [];
  const preview = createTextPreview((text) => chunks.push(text));
  preview("  調べ");
  assert.deepEqual(chunks, ["調べ"]);
  preview("ます。\n<");
  preview('tool name="web_search">{"query":"秘密"}</tool>');
  preview("その後の回答");
  assert.equal(chunks.join(""), "調べます。");
  const code: string[] = [];
  const second = createTextPreview((text) => code.push(text));
  second("例です。\n`"); second("``json\n{\"x\": 1}\n```");
  assert.equal(code.join(""), "例です。");
});

test("streaming: 空白と改行を保ち、最終回答や追加された出典を二重表示しない", () => {
  let screen = "";
  const printer = new ReplyPrinter((text) => { screen += text; });
  const preview = createTextPreview((text) => printer.delta(text));
  preview(" Hello "); preview("world\n"); preview("次の行");
  printer.answer("Hello world\n次の行\n参照元: https://example.com/");
  assert.equal(screen, "\nHello world\n次の行\n参照元: https://example.com/\n");
  printer.delta("途中"); printer.finish(); printer.answer("次の回答");
  assert.ok(screen.endsWith("\n途中\n\n次の回答\n"));
});

test("streaming: 完了前のツールは実行せず、途中で失敗した回答を履歴に入れない", async () => {
  let executed = 0;
  const events: AgentEvent[] = [];
  const agent = new Agent({ mode: "chat", ctx: { root: ".", confirm: async () => true },
    tools: [{ name: "web_search", description: "test", params: [], run: async () => { executed++; return "結果"; } }],
    provider: { name: "broken", complete: async (_messages, _tools, _env, options) => {
      options?.onText?.("調べます。" + formatToolCall("web_search", { query: "秘密" }));
      throw new Error("途中で切断");
    } },
  });
  await assert.rejects(agent.run("調べて", (event) => events.push(event)), /途中で切断/);
  assert.equal(executed, 0);
  assert.equal(agent.messages.filter((message) => message.role === "assistant").length, 0);
  assert.equal(events.filter((event) => event.type === "assistant").length, 0);
  assert.deepEqual(events, [{ type: "assistant_delta", text: "調べます。" }]);
});

test("streaming: 完了した回答の全文と計測を残す", async () => {
  const events: AgentEvent[] = [];
  const agent = new Agent({ mode: "chat", tools: [], ctx: { root: ".", confirm: async () => true },
    provider: { name: "stream", complete: async (_messages, _tools, _env, options) => {
      options?.onText?.("こんに"); options?.onText?.("ちは。");
      options?.onStats?.({ elapsedMs: 10, outputTokens: 3 });
      return "こんにちは。";
    } },
  });
  await agent.run("こんにちは", (event) => events.push(event));
  assert.equal(events.filter((event) => event.type === "assistant").length, 1);
  assert.ok(events.some((event) => event.type === "model_stats"));
  assert.equal(agent.messages.at(-1)?.content, "こんにちは。");
});
