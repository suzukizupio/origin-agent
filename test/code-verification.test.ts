import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Agent } from "../src/agent.ts";
import { formatToolCall } from "../src/protocol.ts";
import { ProviderTimeoutError, type AgentEvent, type Provider, type Tool } from "../src/types.ts";
import { temporaryDirectory } from "./helpers.ts";

const answer = (events: AgentEvent[]) => events
  .filter((event): event is Extract<AgentEvent, { type: "assistant" }> => event.type === "assistant")
  .map((event) => event.text).at(-1);

test("code: ローカルモデルの時間切れでも未完了を回答として返す", async (t) => {
  const root = await temporaryDirectory(t);
  const provider: Provider = { name: "slow-local", complete: async () => {
    throw new ProviderTimeoutError("ローカルモデルが時間切れです。");
  } };
  const agent = new Agent({ provider, tools: [], mode: "code", ctx: { root, confirm: async () => true } });
  const events: AgentEvent[] = [];

  await agent.run("関数を追加してください。", (event) => events.push(event));

  assert.match(answer(events) ?? "", /時間切れ.*完了していません/s);
  assert.equal(events.at(-1)?.type, "done");
  assert.equal(agent.messages.at(-1)?.role, "assistant");
});

test("code: 失敗テストの修正だけ強いモデルを使い、モデル切り替え後は引き継がない", async (t) => {
  const root = await temporaryDirectory(t);
  const used: string[] = [];
  const base: Provider = { name: "3b", complete: async () => { used.push("3b"); return "通常の回答"; } };
  const repair: Provider = { name: "7b", complete: async () => { used.push("7b"); return "修正の回答"; } };
  const agent = new Agent({ provider: base, repairProvider: repair, tools: [], mode: "code",
    ctx: { root, confirm: async () => true } });
  const events: AgentEvent[] = [];

  await agent.run("この関数を説明してください。", (event) => events.push(event));
  await agent.run("失敗したテストを修正してください。", (event) => events.push(event));
  await agent.run("Fix the failing tests.", (event) => events.push(event));
  await agent.run("失敗したテストを修正してください。テストは実行しないでください。", (event) => events.push(event));
  agent.setMode("chat");
  await agent.run("失敗したテストを修正してください。", (event) => events.push(event));
  agent.setMode("code");
  agent.setProviders(base);
  await agent.run("失敗したテストを修正してください。", (event) => events.push(event));

  assert.deepEqual(used, ["3b", "7b", "7b", "3b", "3b", "3b"]);
  assert.equal(events.filter((event) => event.type === "notice" && /7b/.test(event.message)).length, 2);
});

test("code: 失敗テストの修正依頼では実行と該当テストの読み取りを先に行う", async (t) => {
  const root = await temporaryDirectory(t);
  await mkdir(join(root, "test"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "package.json"), '{"scripts":{"test":"node --test"}}');
  await writeFile(join(root, "test", "cart.test.js"), 'import { total } from "../src/cart.js";\n');
  await writeFile(join(root, "src", "cart.js"), "source");
  let fixed = false;
  let testRuns = 0;
  const readPaths: string[] = [];
  let sawFilesBeforeModel = false;
  const shell: Tool = { name: "run_shell", description: "test", params: [], run: async () => {
    testRuns++;
    return fixed ? "(終了コード 0)\npassed" : "(終了コード 1)\ntest/cart.test.js:6:10\nexpected 250, actual 50";
  } };
  const read: Tool = { name: "read_file", description: "test", params: [], run: async (args) => {
    const path = String(args.path);
    readPaths.push(path);
    return path === "test/cart.test.js" ? 'import { total } from "../src/cart.js";' : "export function total(items) {}";
  } };
  const edit: Tool = { name: "edit_file", description: "test", params: [], run: async () => { fixed = true; return "edited"; } };
  let modelCalls = 0;
  const provider: Provider = { name: "scripted", complete: async (messages) => {
    modelCalls++;
    if (modelCalls === 1) {
      sawFilesBeforeModel = messages.filter((message) => message.toolName === "read_file").length === 2;
      return formatToolCall("edit_file", { path: "src/cart.js", old_string: "1", new_string: "0" });
    }
    return "テストを通しました。";
  } };
  const agent = new Agent({ provider, tools: [shell, read, edit], mode: "code", ctx: { root, confirm: async () => true } });
  const events: AgentEvent[] = [];

  await agent.run("テストが失敗しています。原因を調べて直してください。", (event) => events.push(event));

  assert.deepEqual(readPaths, ["test/cart.test.js", "src/cart.js"]);
  assert.equal(sawFilesBeforeModel, true);
  assert.equal(testRuns, 2);
  assert.match(answer(events) ?? "", /テストを通しました/);
});

test("code: 失敗したテストを編集後に再実行し、通れば完了できる", async (t) => {
  const root = await temporaryDirectory(t);
  let fixed = false;
  let testRuns = 0;
  const shell: Tool = { name: "run_shell", description: "test", params: [], run: async () => {
    testRuns++;
    return fixed ? "(終了コード 0)\n2 tests passed" : "(終了コード 1)\nExpected 250, received 50";
  } };
  const edit: Tool = { name: "edit_file", description: "test", params: [], run: async () => { fixed = true; return "編集しました"; } };
  const outputs = [
    formatToolCall("run_shell", { command: "npm test" }),
    formatToolCall("edit_file", { path: "src/cart.js", old_string: "1", new_string: "0" }),
    "修正してテストが通りました。",
  ];
  const provider: Provider = { name: "scripted", complete: async () => outputs.shift() ?? "" };
  const agent = new Agent({ provider, tools: [shell, edit], mode: "code", ctx: { root, confirm: async () => true } });
  const events: AgentEvent[] = [];

  await agent.run("テストが失敗しています。原因を調べて直してください。", (event) => events.push(event));

  assert.equal(testRuns, 2);
  assert.match(answer(events) ?? "", /テストが通りました/);
  assert.ok(events.some((event) => event.type === "tool_end" && event.name === "run_shell" && event.ok));
});

test("code: テスト未通過の完了報告を止め、原因調査を再度促す", async (t) => {
  const root = await temporaryDirectory(t);
  const shell: Tool = { name: "run_shell", description: "test", params: [], run: async () => "(終了コード 1)\nExpected 250, received 50" };
  let calls = 0;
  let sawNudge = false;
  const provider: Provider = { name: "scripted", complete: async (messages) => {
    calls++;
    sawNudge ||= messages.some((message) => message.toolName === "test_check" && /最初から追い/.test(message.content));
    return calls === 1 ? formatToolCall("run_shell", { command: "npm test" }) : "完了しました。";
  } };
  const agent = new Agent({ provider, tools: [shell], mode: "code", maxSteps: 5, ctx: { root, confirm: async () => true } });
  const events: AgentEvent[] = [];

  await agent.run("npm test が失敗しています。原因を調べて直してください。", (event) => events.push(event));

  assert.equal(sawNudge, true);
  assert.equal(calls, 4);
  assert.match(answer(events) ?? "", /修正を完了できませんでした/);
  assert.equal(agent.messages.some((message) => message.role === "assistant" && message.content === "完了しました。"), false);
});

test("code: 複合シェルコマンドは自動で再実行しない", async (t) => {
  const root = await temporaryDirectory(t);
  let testRuns = 0;
  const shell: Tool = { name: "run_shell", description: "test", params: [], run: async () => {
    testRuns++;
    return "(終了コード 1)\nfailed";
  } };
  const edit: Tool = { name: "edit_file", description: "test", params: [], run: async () => "編集しました" };
  const outputs = [
    formatToolCall("run_shell", { command: "npm test; echo done" }),
    formatToolCall("edit_file", { path: "src/cart.js", old_string: "1", new_string: "0" }),
    "確認が必要です。",
  ];
  const provider: Provider = { name: "scripted", complete: async () => outputs.shift() ?? "" };
  const agent = new Agent({ provider, tools: [shell, edit], mode: "code", ctx: { root, confirm: async () => true } });

  await agent.run("失敗を直してください。", () => {});

  assert.equal(testRuns, 1);
});

test("code: テストを実行しない指示ではモデルのテスト呼び出しも止める", async (t) => {
  const root = await temporaryDirectory(t);
  await writeFile(join(root, "package.json"), '{"scripts":{"test":"node --test"}}');
  let testRuns = 0;
  const shell: Tool = { name: "run_shell", description: "test", params: [], run: async () => { testRuns++; return "(終了コード 0)"; } };
  let calls = 0;
  const provider: Provider = { name: "scripted", complete: async () => {
    calls++;
    return calls === 1 ? formatToolCall("run_shell", { command: "npm test" }) : "テストは実行していません。";
  } };
  const agent = new Agent({ provider, tools: [shell], mode: "code", ctx: { root, confirm: async () => true } });
  const events: AgentEvent[] = [];

  await agent.run("テストが失敗していますが、テストを実行しないで修正してください。", (event) => events.push(event));

  assert.equal(testRuns, 0);
  assert.ok(events.some((event) => event.type === "tool_end" && event.name === "run_shell" && !event.ok));
});

test("code: テストファイルを変更しない指示を編集ツールでも守る", async (t) => {
  const root = await temporaryDirectory(t);
  const changed: string[] = [];
  const edit: Tool = { name: "edit_file", description: "test", params: [], run: async (args) => {
    changed.push(String(args.path));
    return "編集しました";
  } };
  const outputs = [
    formatToolCall("edit_file", { path: "test/cart.test.js", old_string: "a", new_string: "b" }),
    formatToolCall("edit_file", { path: "src/cart.js", old_string: "a", new_string: "b" }),
    "実装を修正しました。",
  ];
  const provider: Provider = { name: "scripted", complete: async () => outputs.shift() ?? "" };
  const agent = new Agent({ provider, tools: [edit], mode: "code", ctx: { root, confirm: async () => true } });
  const events: AgentEvent[] = [];

  await agent.run("テストファイルは変更しないで、src のコードを修正してください。", (event) => events.push(event));

  assert.deepEqual(changed, ["src/cart.js"]);
  assert.ok(events.some((event) => event.type === "tool_end" && event.name === "edit_file"
    && !event.ok && /テストファイルの変更が禁止/.test(event.result)));
});
