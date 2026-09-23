import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../src/agent.ts";
import { formatToolCall } from "../src/protocol.ts";
import { resolveProvider, resolveProviderSelection } from "../src/providers/index.ts";
import type { AgentEvent, Provider, Tool } from "../src/types.ts";

test("chat: 会話が次の発話へ渡り、作業ディレクトリの情報は渡らない", async () => {
  const provider: Provider = {
    name: "test",
    complete: async (messages, _tools, env) => {
      assert.equal(env.root, "");
      assert.equal(env.outline, "");
      if (messages.length === 1) return "こんにちは、ハルさん。";
      assert.equal(messages[0]?.content, "私の名前はハルです。");
      assert.equal(messages[1]?.content, "こんにちは、ハルさん。");
      return "ハルさんです。";
    },
  };
  const agent = new Agent({ provider, tools: [], ctx: { root: process.cwd(), confirm: async () => false }, mode: "chat" });
  await agent.run("私の名前はハルです。", () => {});
  await agent.run("名前を覚えていますか？", () => {});
  assert.equal(agent.messages.at(-1)?.content, "ハルさんです。");
  agent.reset();
  assert.equal(agent.messages.length, 0);
});

test("chat: モデルがファイル変更を要求しても実行せず、code へ切り替えると使える", async () => {
  let invoked = 0;
  const writeTool: Tool = { name: "write_file", description: "test", params: [], run: async () => { invoked++; return "written"; } };
  const provider: Provider = {
    name: "test",
    complete: async (messages) => messages.at(-1)?.role === "tool" ? "終了" : formatToolCall("write_file", {}),
  };
  const agent = new Agent({ provider, tools: [writeTool], ctx: { root: process.cwd(), confirm: async () => true }, mode: "chat" });
  const events: AgentEvent[] = [];
  await agent.run("書いて", (event) => events.push(event));
  assert.equal(invoked, 0);
  assert.ok(events.some((event) => event.type === "tool_end" && !event.ok));
  agent.setMode("code");
  assert.equal(agent.messages.length, 0);
  await agent.run("書いて", () => {});
  assert.equal(invoked, 1);
});

test("/search: 検索を先に実行し、結果をモデルへ渡して回答させる", async () => {
  const order: string[] = [];
  const search: Tool = {
    name: "web_search", description: "test", params: [],
    run: async (args) => { order.push("search"); assert.equal(args.query, "TypeScript"); return "1. TypeScript\nURL: https://www.typescriptlang.org/\n抜粋: TypeScriptの公式サイトです。"; },
  };
  const provider: Provider = {
    name: "test",
    complete: async (messages) => {
      order.push("answer");
      assert.equal(messages.at(-1)?.role, "tool");
      assert.match(messages.at(-1)?.content ?? "", /typescriptlang/);
      return "TypeScriptの公式サイトです。";
    },
  };
  const agent = new Agent({ provider, tools: [search], ctx: { root: process.cwd(), confirm: async () => true }, mode: "chat" });
  await agent.run("調べて", () => {}, { name: "web_search", args: { query: "TypeScript" } });
  assert.deepEqual(order, ["search", "answer"]);
});

test("auto: インストール済みのモデルを選び、接続できないときだけ定型応答になる", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ models: [{ name: "local-chat:small" }] })));
  assert.equal((await resolveProvider("auto")).name, "ollama:local-chat:small");
  mock.mock.mockImplementation(async () => { throw new Error("offline"); });
  assert.equal((await resolveProvider("auto")).name, "rule");
  // 明示したモデルを、黙って rule にすり替えない。
  assert.equal((await resolveProvider("auto", "chosen:1b")).name, "ollama:chosen:1b");
});

test("auto: 7B があれば修正用に用意し、明示したモデルは変更しない", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ models: [
    { name: "qwen2.5-coder:3b" }, { name: "qwen2.5-coder:7b" },
  ] })));
  const automatic = await resolveProviderSelection("auto");
  assert.equal(automatic.provider.name, "ollama:qwen2.5-coder:3b");
  assert.equal(automatic.repairProvider?.name, "ollama:qwen2.5-coder:7b");
  assert.equal(mock.mock.callCount(), 1);

  const explicit = await resolveProviderSelection("ollama", "qwen2.5-coder:3b");
  assert.equal(explicit.provider.name, "ollama:qwen2.5-coder:3b");
  assert.equal(explicit.repairProvider, undefined);
  assert.equal(mock.mock.callCount(), 1);

  mock.mock.mockImplementation(async () => new Response(JSON.stringify({ models: [{ name: "qwen2.5-coder:3b" }] })));
  assert.equal((await resolveProviderSelection("auto")).repairProvider, undefined);
});

test("context: 資料が増えても直近の依頼と最後のツール結果を残す", async () => {
  const provider: Provider = {
    name: "test", complete: async (messages) => {
      assert.equal(messages[0]?.content, "最新の依頼");
      assert.equal(messages.at(-1)?.content, "最新の資料");
      assert.equal(messages.length, 3);
      return "回答";
    },
  };
  const tool: Tool = { name: "web_search", description: "test", params: [], run: async () => "最新の資料" };
  const agent = new Agent({ provider, tools: [tool], ctx: { root: process.cwd(), confirm: async () => true }, mode: "chat", contextBudget: 100 });
  agent.messages = [
    { role: "user", content: "古い依頼" }, { role: "assistant", content: "古い回答".repeat(100) },
  ];
  await agent.run("最新の依頼", () => {}, { name: "web_search", args: { query: "test" } });
});
