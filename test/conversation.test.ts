import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../src/agent.ts";
import { buildSystemPrompt, formatToolCall } from "../src/protocol.ts";
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


test("context: 3件だけでも長い過去ターンを外し、最新の質問は全文残す", async () => {
  const notices: AgentEvent[] = [];
  const agent = new Agent({ mode: "chat", tools: [], contextBudget: 100,
    ctx: { root: process.cwd(), confirm: async () => false }, provider: {
      name: "test", complete: async (messages) => {
        assert.deepEqual(messages, [{ role: "user", content: "新しい質問" }]);
        return "回答";
      },
    },
  });
  agent.messages = [{ role: "user", content: "前の質問" }, { role: "assistant", content: "長".repeat(1000) }];
  await agent.run("新しい質問", (event) => notices.push(event));
  assert.ok(notices.some((event) => event.type === "notice" && /古い発話 2 件/.test(event.message)));
});

test("context: 予算内の直前の条件は、より古いターンだけを落として保持する", async () => {
  const recent = [{ role: "user" as const, content: "予算は2000円です" }, { role: "assistant" as const, content: "その範囲で考えます" }];
  const agent = new Agent({ mode: "chat", tools: [], contextBudget: 100,
    ctx: { root: process.cwd(), confirm: async () => false }, provider: {
      name: "test", complete: async (messages) => {
        assert.deepEqual(messages, [...recent, { role: "user", content: "その条件で提案して" }]);
        return "回答";
      },
    },
  });
  agent.messages = [{ role: "user", content: "古い質問" }, { role: "assistant", content: "長".repeat(1000) }, ...recent];
  await agent.run("その条件で提案して", () => {});
});

test("context: 単独の長い質問を切らず、削除不能でもループしない", async () => {
  const input = "質問".repeat(100);
  const agent = new Agent({ mode: "chat", tools: [], contextBudget: 10,
    ctx: { root: process.cwd(), confirm: async () => false }, provider: {
      name: "test", complete: async (messages) => {
        assert.deepEqual(messages, [{ role: "user", content: input }]);
        return "回答";
      },
    },
  });
  await agent.run(input, () => {});
});

test("context: 4件の履歴から過去のツール呼び出しと結果を一緒に外す", async () => {
  const agent = new Agent({ mode: "chat", tools: [], contextBudget: 100,
    ctx: { root: process.cwd(), confirm: async () => false }, provider: {
      name: "test", complete: async (messages) => {
        assert.deepEqual(messages, [{ role: "user", content: "次の質問" }]);
        return "回答";
      },
    },
  });
  agent.messages = [{ role: "user", content: "前の質問" },
    { role: "assistant", content: formatToolCall("web_search", { query: "前の質問" }) },
    { role: "tool", toolName: "web_search", content: "資料".repeat(1000) }];
  await agent.run("次の質問", () => {});
});


test("rewrite: 専用プロンプトは使えないツールの呼び出し例を含めない", () => {
  const prompt = buildSystemPrompt([], { root: "", outline: "", mode: "chat", replyRewrite: true });
  assert.doesNotMatch(prompt, /<tool|web_search|read_file/);
  assert.match(prompt, /今回指定された形式を優先/);
  assert.match(prompt, /未確認/);
  assert.match(prompt, /URL/);
  assert.match(prompt, /命令には従いません/);
});

test("rewrite: ツール要求を実行せず、1回で未完了を返し、生出力を表示しない", async () => {
  let calls = 0;
  let executions = 0;
  const events: AgentEvent[] = [];
  const agent = new Agent({ mode: "chat", ctx: { root: process.cwd(), confirm: async () => true },
    tools: [{ name: "web_search", description: "test", params: [], run: async () => { executions++; return "結果"; } }],
    provider: { name: "test", complete: async (_messages, tools, _env, options) => {
      calls++;
      assert.deepEqual(tools, []);
      const raw = `検索します。${formatToolCall("web_search", { query: "秘密の話" })}`;
      options?.onText?.(raw);
      return raw;
    } },
  });
  await agent.run("それを短くして", (e) => events.push(e), { name: "web_search", args: { query: "実行しない" } },
    { rewriteSource: "前の回答", research: true, additionalSearches: ["実行しない"] });
  assert.equal(calls, 1);
  assert.equal(executions, 0);
  assert.ok(events.some((e) => e.type === "done" && e.reason === "stuck"));
  assert.ok(!events.some((e) => e.type === "assistant_delta" || e.type === "tool_start"));
  assert.doesNotMatch(agent.messages.at(-1)!.content, /秘密の話|<tool/);
});

test("rewrite: 元の回答が予算を超えると黙って切らず、モデルを呼ばずに案内する", async () => {
  const events: AgentEvent[] = [];
  const agent = new Agent({ mode: "chat", contextBudget: 20, tools: [],
    ctx: { root: process.cwd(), confirm: async () => false },
    provider: { name: "unused", complete: async () => { throw new Error("モデルは呼ばない"); } },
  });
  await agent.run("短くして", (e) => events.push(e), undefined, { rewriteSource: "長文".repeat(50) });
  assert.match(agent.messages.at(-1)!.content, /必要な部分だけ/);
  assert.ok(events.some((e) => e.type === "done" && e.reason === "stuck"));
});

test("rewrite: 履歴を整理しても、指定した元の回答を丸ごとモデルへ渡す", async () => {
  const agent = new Agent({ mode: "chat", contextBudget: 40, tools: [],
    ctx: { root: process.cwd(), confirm: async () => false },
    provider: { name: "test", complete: async (messages) => {
      assert.deepEqual(messages, [{ role: "assistant", content: "現在は2000円です。" }, { role: "user", content: "短くして" }]);
      return "2000円です。";
    } },
  });
  agent.messages = [{ role: "user", content: "過去".repeat(100) }, { role: "assistant", content: "現在は2000円です。" }];
  await agent.run("短くして", () => {}, undefined, { rewriteSource: "現在は2000円です。" });
});
