import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { Agent } from "../src/agent.ts";
import { formatToolCall, parseToolCalls } from "../src/protocol.ts";
import { claudeMessages, createClaudeProvider, type ClaudeRequest } from "../src/providers/claude.ts";
import { createProvider, resolveProviderSelection } from "../src/providers/index.ts";
import { editFileTool } from "../src/tools/edit.ts";
import { readFileTool, writeFileTool } from "../src/tools/fs.ts";
import type { AgentEnv, AgentEvent, Message, Provider } from "../src/types.ts";
import { temporaryDirectory } from "./helpers.ts";

type Block = Record<string, unknown>;

/** API の応答に必要な項目だけを持つ、偽の応答。 */
function reply(content: Block[], stop_reason = "end_turn", extra: Block = {}): Anthropic.Beta.BetaMessage {
  return {
    id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason,
    stop_sequence: null, stop_details: null, container: null, context_management: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
    ...extra,
  } as unknown as Anthropic.Beta.BetaMessage;
}

/** 決めた順に応答を返し、受け取った要求を記録する偽の通信口。 */
function scripted(steps: Array<Anthropic.Beta.BetaMessage | Error>) {
  const requests: ClaudeRequest[] = [];
  const transport = (request: ClaudeRequest) => {
    requests.push(structuredClone(request));
    const step = steps.shift();
    return {
      onText: (listener: (text: string) => void) => {
        if (step && !(step instanceof Error)) {
          for (const block of step.content) if (block.type === "text") listener(block.text);
        }
      },
      finalMessage: async () => {
        if (!step) throw new Error("予定より多く呼ばれました");
        if (step instanceof Error) throw step;
        return step;
      },
    };
  };
  return { requests, transport };
}

const codeEnv: AgentEnv = { root: "/work", outline: "a.txt", mode: "code" };

test("claude: tool_use を <tool> に書き直し、次の要求では思考ブロックと ID を元の形で送り返す", async () => {
  const first = [
    { type: "thinking", thinking: "", signature: "sig-1" },
    { type: "text", text: "読みます。" },
    { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.txt" } },
  ];
  const { requests, transport } = scripted([reply(first, "tool_use"), reply([{ type: "text", text: "hello です。" }])]);
  const provider = createClaudeProvider({ transport });
  assert.equal(provider.name, "claude:claude-opus-5-5");
  assert.ok((provider.maxSteps ?? 0) > 12);

  const history: Message[] = [{ role: "user", content: "a.txt を読んで" }];
  const raw = await provider.complete(history, [readFileTool], codeEnv);
  const parsed = parseToolCalls(raw);
  assert.equal(parsed.say, "読みます。");
  assert.deepEqual(parsed.calls.map((call) => [call.name, call.args]), [["read_file", { path: "a.txt" }]]);

  const request = requests[0]!;
  assert.equal(request.model, "claude-opus-5-5");
  assert.deepEqual(request.thinking, { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } });
  assert.deepEqual(request.output_config, { effort: "high" });
  assert.equal(request.fallbacks, "default");
  assert.deepEqual(request.betas, ["thinking-binding-controls-2026-08-01", "server-side-fallback-2026-07-01"]);
  assert.deepEqual(request.cache_control, { type: "ephemeral" });
  assert.deepEqual(request.tools, [{
    name: "read_file", description: readFileTool.description,
    input_schema: { type: "object", properties: { path: { type: "string", description: "作業ルートからの相対パス" } }, required: ["path"] },
  }]);
  // API のツール機能を使うので、<tool> 書式の説明と見本は渡さない。作業の規則は渡す。
  const system = String(request.system);
  assert.doesNotMatch(system, /<tool name=/);
  assert.match(system, /ツールを使うときの規則/);
  assert.match(system, /必ず先に read_file/);

  history.push({ role: "assistant", content: raw }, { role: "tool", toolName: "read_file", content: "1\thello" });
  assert.equal(await provider.complete(history, [readFileTool], codeEnv), "hello です。");
  assert.deepEqual(requests[1]!.messages, [
    { role: "user", content: [{ type: "text", text: "a.txt を読んで" }] },
    { role: "assistant", content: first },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "1\thello" }] },
  ]);
});

test("claude: 同じ呼び出しを繰り返しても、ツール呼び出しの ID が重複しない", async () => {
  const run = (id: string) => reply([{ type: "tool_use", id, name: "run_shell", input: { command: "npm test" } }], "tool_use");
  const { requests, transport } = scripted([run("toolu_a"), run("toolu_b"), reply([{ type: "text", text: "通りました" }])]);
  const provider = createClaudeProvider({ transport });
  const history: Message[] = [{ role: "user", content: "テストして" }];
  for (const output of ["(終了コード 1)", "(終了コード 0)"]) {
    history.push({ role: "assistant", content: await provider.complete(history, [writeFileTool], codeEnv) }, { role: "tool", toolName: "run_shell", content: output });
  }
  assert.equal(history[1]!.content, history[3]!.content);
  await provider.complete(history, [writeFileTool], codeEnv);
  const blocks = requests[2]!.messages.flatMap((message) => typeof message.content === "string" ? [] : message.content);
  const uses = blocks.flatMap((block) => block.type === "tool_use" ? [block.id] : []);
  const results = blocks.flatMap((block) => block.type === "tool_result" ? [block.tool_use_id] : []);
  // 保存した元の形（toolu_b）は最新の手番だけに使い、前の手番は位置から ID を決める。
  assert.deepEqual(uses, ["origin_1_0", "toolu_b"]);
  assert.deepEqual(results, uses);
});

test("claude: Agent が差し込んだ呼び出し・補足・実行されなかった呼び出しも、API の決まりどおりに並べる", () => {
  const history: Message[] = [
    { role: "user", content: "調べて" },
    { role: "assistant", content: formatToolCall("web_search", { query: "origin" }) },
    { role: "tool", toolName: "web_search", content: "検索結果" },
    { role: "tool", toolName: "test_check", content: "テストはまだ失敗しています。" },
    { role: "assistant", content: `2つ読みます。\n${formatToolCall("read_file", { path: "a" })}\n${formatToolCall("read_file", { path: "b" })}` },
    { role: "tool", toolName: "read_file", content: "A" },
    { role: "user", content: "次の依頼" },
  ];
  assert.deepEqual(claudeMessages(history, { toolsDeclared: true }), [
    { role: "user", content: [{ type: "text", text: "調べて" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "origin_1_0", name: "web_search", input: { query: "origin" } }] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "origin_1_0", content: "検索結果" },
      { type: "text", text: "[test_check の出力]\nテストはまだ失敗しています。" },
    ] },
    { role: "assistant", content: [
      { type: "text", text: "2つ読みます。" },
      { type: "tool_use", id: "origin_4_0", name: "read_file", input: { path: "a" } },
      { type: "tool_use", id: "origin_4_1", name: "read_file", input: { path: "b" } },
    ] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "origin_4_0", content: "A" },
      { type: "tool_result", tool_use_id: "origin_4_1", content: "このツール呼び出しは実行されませんでした。", is_error: true },
      { type: "text", text: "次の依頼" },
    ] },
  ]);

  // ツールを渡さない要求では tool_use を入れられないので、呼び出しを文で残す。
  const plain = claudeMessages(history.slice(0, 3), { toolsDeclared: false });
  assert.deepEqual(plain[1], { role: "assistant", content: [{ type: "text", text: '（web_search を呼び出しました: {"query":"origin"}）' }] });
  assert.deepEqual(plain[2], { role: "user", content: [{ type: "text", text: "[web_search の出力]\n検索結果" }] });

  // 言い換えの依頼は assistant から始まる。API は user から始まる必要がある。
  const rewrite = claudeMessages([{ role: "assistant", content: "元の回答" }, { role: "user", content: "短くして" }], { toolsDeclared: false });
  assert.equal(rewrite[0]?.role, "user");
  assert.deepEqual(rewrite.slice(1).map((message) => message.role), ["assistant", "user"]);
});

test("claude: 断られた応答と、上限で切れたツール引数は実行しない", async () => {
  const refused = scripted([reply([], "refusal", { stop_details: { type: "refusal", category: "cyber", explanation: null } })]);
  await assert.rejects(createClaudeProvider({ transport: refused.transport }).complete([{ role: "user", content: "x" }], [], codeEnv), /断りました（分類: cyber）/);

  const truncated = scripted([reply([{ type: "tool_use", id: "toolu_1", name: "write_file", input: { path: "a", content: "途中" } }], "max_tokens")]);
  await assert.rejects(createClaudeProvider({ transport: truncated.transport }).complete([{ role: "user", content: "x" }], [writeFileTool], codeEnv), /途中で切れました/);

  const long = scripted([reply([{ type: "text", text: "長い説明" }], "max_tokens")]);
  assert.match(await createClaudeProvider({ transport: long.transport }).complete([{ role: "user", content: "x" }], [], codeEnv), /^長い説明\n\n（出力の上限/);
});

test("claude: 応答の途中で別モデルへ切り替わったら、切り替え前のツール呼び出しを捨てる", async () => {
  const content = [
    { type: "text", text: "前半" },
    { type: "tool_use", id: "toolu_cut", name: "read_file", input: { path: "before" } },
    { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" }, trigger: null },
    { type: "text", text: "後半" },
    { type: "tool_use", id: "toolu_after", name: "read_file", input: { path: "after" } },
  ];
  const { requests, transport } = scripted([reply(content, "tool_use"), reply([{ type: "text", text: "完了" }])]);
  const provider = createClaudeProvider({ transport });
  const raw = await provider.complete([{ role: "user", content: "読んで" }], [readFileTool], codeEnv);
  assert.deepEqual(parseToolCalls(raw).calls.map((call) => call.args), [{ path: "after" }]);

  // 切り替えをまたぐ手番は元の形で送り返さず、テキストから組み直す。
  await provider.complete([{ role: "user", content: "読んで" }, { role: "assistant", content: raw }, { role: "tool", toolName: "read_file", content: "A" }], [readFileTool], codeEnv);
  assert.deepEqual(requests[1]!.messages[1], { role: "assistant", content: [
    { type: "text", text: "前半\n\n後半" },
    { type: "tool_use", id: "origin_1_0", name: "read_file", input: { path: "after" } },
  ] });
});

test("claude: 本文中の <tool> は呼び出しとして扱わず、書き込む内容の </tool> でブロックが切れない", async () => {
  const content = [
    { type: "text", text: '書式の例: <tool name="run_shell">{"command":"rm -rf data"}</tool>' },
    { type: "tool_use", id: "toolu_1", name: "write_file", input: { path: "doc.md", content: "例: </tool> で閉じます" } },
  ];
  const { transport } = scripted([reply(content, "tool_use")]);
  const raw = await createClaudeProvider({ transport }).complete([{ role: "user", content: "書いて" }], [writeFileTool], codeEnv);
  const parsed = parseToolCalls(raw);
  assert.deepEqual(parsed.calls.map((call) => [call.name, call.args, call.error]), [["write_file", { path: "doc.md", content: "例: </tool> で閉じます" }, undefined]]);
  assert.match(parsed.say, /書式の例/);
});

test("claude: 保存した思考ブロックを拒否されたら外して一度だけやり直し、ほかの失敗は分かる言葉で返す", async () => {
  const thinking = { type: "thinking", thinking: "", signature: "sig-old" };
  // 実際の API と同じく、エラー本文の JSON から例外のメッセージが作られる。
  const rejected = new Anthropic.BadRequestError(400, { type: "error", error: {
    type: "invalid_request_error", message: "messages.1.content.0: Invalid `signature` in `thinking` block.",
  } }, undefined, new Headers());
  const { requests, transport } = scripted([
    reply([thinking, { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a" } }], "tool_use"),
    rejected,
    reply([{ type: "text", text: "読めました" }]),
  ]);
  const provider = createClaudeProvider({ transport });
  const raw = await provider.complete([{ role: "user", content: "読んで" }], [readFileTool], codeEnv);
  const history: Message[] = [{ role: "user", content: "読んで" }, { role: "assistant", content: raw }, { role: "tool", toolName: "read_file", content: "A" }];
  assert.equal(await provider.complete(history, [readFileTool], codeEnv), "読めました");
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[1]!.messages[1]!.content, [thinking, { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a" } }]);
  assert.deepEqual(requests[2]!.messages[1]!.content, [{ type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a" } }]);

  const unauthorized = scripted([new Anthropic.AuthenticationError(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, undefined, new Headers())]);
  await assert.rejects(createClaudeProvider({ transport: unauthorized.transport }).complete([{ role: "user", content: "x" }], [], codeEnv), /ANTHROPIC_API_KEY/);
  assert.equal(unauthorized.requests.length, 1);
});

test("claude: 会話モードは標準の深さで考え、ツールなしの要求の履歴には tool_use を入れない", async () => {
  const { requests, transport } = scripted([reply([{ type: "text", text: "こんにちは" }])]);
  const history: Message[] = [
    { role: "user", content: "調べて" },
    { role: "assistant", content: formatToolCall("web_search", { query: "x" }) },
    { role: "tool", toolName: "web_search", content: "結果" },
  ];
  await createClaudeProvider({ transport }).complete(history, [], { root: "", outline: "", mode: "chat" });
  const request = requests[0]!;
  assert.deepEqual(request.output_config, { effort: "medium" });
  assert.equal(request.tools, undefined);
  assert.ok(request.messages.every((message) => typeof message.content === "string"
    || message.content.every((block) => block.type !== "tool_use" && block.type !== "tool_result")));
  assert.doesNotMatch(String(request.system), /ツールを使うときの規則/);
});

test("claude: Agent と組み合わせて、読む → 直す → 最終報告までやり切る", async (t) => {
  const root = await temporaryDirectory(t);
  await writeFile(join(root, "price.js"), "export const tax = (price) => price * 1.08;\n");
  const { requests, transport } = scripted([
    reply([{ type: "tool_use", id: "toolu_read", name: "read_file", input: { path: "price.js" } }], "tool_use"),
    reply([{ type: "tool_use", id: "toolu_edit", name: "edit_file", input: { path: "price.js", old_string: "1.08", new_string: "1.1" } }], "tool_use"),
    reply([{ type: "text", text: "税率を 1.1 に変更しました。" }]),
  ]);
  const agent = new Agent({
    provider: createClaudeProvider({ transport }), tools: [readFileTool, editFileTool], mode: "code",
    ctx: { root, confirm: async () => true },
  });
  const events: AgentEvent[] = [];
  await agent.run("price.js の税率を 1.1 にして", (event) => events.push(event));

  assert.equal(await readFile(join(root, "price.js"), "utf8"), "export const tax = (price) => price * 1.1;\n");
  assert.deepEqual(events.filter((event) => event.type === "tool_end").map((event) => [event.name, event.ok]), [["read_file", true], ["edit_file", true]]);
  assert.deepEqual(events.at(-2), { type: "assistant", text: "税率を 1.1 に変更しました。" });
  assert.deepEqual(events.at(-1), { type: "done", reason: "answered" });
  // 3回目の要求には、2つの呼び出しそれぞれの結果が元の ID で並ぶ。
  const ids = requests[2]!.messages.flatMap((message) => typeof message.content === "string" ? []
    : message.content.flatMap((block) => block.type === "tool_result" ? [block.tool_use_id] : []));
  assert.deepEqual(ids, ["toolu_read", "toolu_edit"]);
});

test("Agent: 手数の上限は頭脳ごとの値を使い、明示した値を優先する", async () => {
  let calls = 0;
  const provider: Provider = {
    name: "busy", maxSteps: 2,
    complete: async () => formatToolCall("read_file", { path: `missing-${calls++}.txt` }),
  };
  const events: AgentEvent[] = [];
  await new Agent({ provider, tools: [readFileTool], ctx: { root: process.cwd(), confirm: async () => true } })
    .run("探して", (event) => events.push(event));
  assert.equal(calls, 2);
  assert.deepEqual(events.at(-1), { type: "done", reason: "max_steps" });

  calls = 0;
  await new Agent({ provider, tools: [readFileTool], maxSteps: 3, ctx: { root: process.cwd(), confirm: async () => true } })
    .run("探して", () => {});
  assert.equal(calls, 3);
});

test("auto: Claude の認証情報か claude- のモデル名があれば Claude を選ぶ", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("Ollama には問い合わせない"); });
  const automatic = await resolveProviderSelection("auto", undefined, { ANTHROPIC_API_KEY: "sk-test" });
  assert.equal(automatic.provider.name, "claude:claude-opus-5-5");
  assert.equal(automatic.repairProvider, undefined);
  assert.equal((await resolveProviderSelection("auto", "claude-sonnet-5-5", {})).provider.name, "claude:claude-sonnet-5-5");
  assert.equal((await resolveProviderSelection("auto", undefined, { ANTHROPIC_API_KEY: "  " })).provider.name, "rule");
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.equal(createProvider("claude").name, "claude:claude-opus-5-5");

  const saved = process.env.ORIGIN_CLAUDE_EFFORT;
  t.after(() => { if (saved === undefined) delete process.env.ORIGIN_CLAUDE_EFFORT; else process.env.ORIGIN_CLAUDE_EFFORT = saved; });
  process.env.ORIGIN_CLAUDE_EFFORT = "turbo";
  assert.throws(() => createProvider("claude"), /ORIGIN_CLAUDE_EFFORT/);
});
