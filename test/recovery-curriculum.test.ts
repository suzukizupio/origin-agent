import { test } from "node:test";
import assert from "node:assert/strict";
import { runRecovery, recoveryRecipe } from "../scripts/recovery-curriculum.ts";
import { formatToolCall } from "../src/protocol.ts";
import type { Provider } from "../src/types.ts";

test("recovery: only verified continuation actions become targets, failure remains context", async () => {
  for (const seed of [30, 31]) {
    const result = await runRecovery(seed, undefined, "train");
    assert.equal(result.ok, true);
    assert.equal(result.examples.length, 4);
    const examples = result.examples as Array<{ messages: Array<{ role: string; content: string }> }>;
    assert.match(examples[0]!.messages.at(-1)!.content, /name="read_file"/);
    assert.ok(examples[0]!.messages.some((message) => /old_string が一致しません/.test(message.content)));
    assert.equal(result.events.filter((event) => event.type === "tool_end" && !event.ok).length, 1);
    for (const example of examples) assert.equal(example.messages.at(-1)?.role, "assistant");
  }
});

test("recovery: passing tests without re-reading after the failure is insufficient", async () => {
  const task = recoveryRecipe(32);
  const actions = [formatToolCall("edit_file", { path: task.path, old_string: task.oldString, new_string: task.newString }),
    formatToolCall("run_shell", { command: "node --test" }), "完了しました。"];
  const provider: Provider = { name: "skips-reread", complete: async () => actions.shift() ?? "完了しました。" };
  const result = await runRecovery(32, provider);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /re-read/);
  assert.equal(result.examples.length, 0);
});

test("recovery: a repeated stale replacement and premature answer fail the task", async () => {
  const task = recoveryRecipe(33);
  const actions = [formatToolCall("read_file", { path: task.path }),
    formatToolCall("edit_file", { path: task.path, old_string: "return value;", new_string: task.newString }), "完了しました。"];
  const provider: Provider = { name: "stale-retry", complete: async () => actions.shift() ?? "完了しました。" };
  const result = await runRecovery(33, provider);
  assert.equal(result.ok, false);
  assert.equal(result.events.some((event) => event.type === "tool_end" && event.name === "run_shell" && event.ok), false);
});

test("recovery: fixture identities cannot escape the temporary workspace", () => {
  for (const seed of [-1, 10000, 1.2, NaN]) assert.throws(() => recoveryRecipe(seed), /Seed/);
});
