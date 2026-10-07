import { test } from "node:test";
import assert from "node:assert/strict";
import { developmentTasks, heldoutTasks, runDistillTask, validateTeacherPatch } from "../scripts/distill-curriculum.ts";
import { formatToolCall } from "../src/protocol.ts";
import type { Provider } from "../src/types.ts";

test("distillation: development partitions have different task identities and parameters", () => {
  const tasks = ["train", "validation", "tune"].flatMap((split) => developmentTasks(split as "train" | "validation" | "tune"));
  assert.equal(new Set(tasks.map((task) => task.id)).size, tasks.length);
  assert.equal(new Set(tasks.map((task) => `${task.family}:${task.a}:${task.b}`)).size, tasks.length);
  assert.ok(tasks.every((task) => task.split !== "holdout"));
});

test("distillation: teacher patches are restricted to bounded return expressions", () => {
  const task = developmentTasks("train")[0]!;
  const patch = { path: task.path, old_string: "return value;", new_string: "return Math.max(-7, Math.min(5, value));" };
  assert.deepEqual(validateTeacherPatch(patch, task), patch);
  const threshold = developmentTasks("train")[2]!;
  assert.equal(validateTeacherPatch({ path: threshold.path, old_string: "return value;", new_string: "return value >= 0;" }, threshold).new_string, "return value >= 0;");
  for (const new_string of ["return value && value >= 9 ? true : false;", "return value === 0 || !(value < 0);", "return value * 2 + (-1);"]) assert.equal(validateTeacherPatch({ ...patch, new_string }, task).new_string, new_string);
  for (const change of [{ path: "../other.js" }, { old_string: "" }, { new_string: "return process.exit(0);" }, { new_string: "return Math.constructor(value);" }, { new_string: "return value; while (true) {}" }, { new_string: "return value = 5;" }]) assert.throws(() => validateTeacherPatch({ ...patch, ...change }, task));
});

test("distillation: synthetic final-evaluation recipes cannot duplicate development parameters", () => {
  const seen = new Set(["train", "validation", "tune"].flatMap((split) => developmentTasks(split as "train" | "validation" | "tune")).map((task) => `${task.family}:${task.a}:${task.b}`));
  for (const nonce of [1, 42, 12345, 999999999]) {
    const tasks = heldoutTasks(nonce); const keys = tasks.map((task) => `${task.family}:${task.a}:${task.b}`);
    assert.equal(new Set(keys).size, 4); assert.ok(keys.every((key) => !seen.has(key))); assert.ok(tasks.every((task) => task.split === "holdout"));
  }
});

test("distillation: only a preserved, tested, completed trajectory passes", async () => {
  const task = developmentTasks("train")[0]!; let step = 0;
  const actions = [formatToolCall("read_file", { path: task.path }), formatToolCall("edit_file", { path: task.path, old_string: "return value;", new_string: "return Math.max(-7, Math.min(5, value));" }), formatToolCall("run_shell", { command: "node --test" }), "テストが通りました。"];
  const provider: Provider = { name: "fixture", complete: async () => actions[step++]! };
  const result = await runDistillTask(task, provider);
  assert.equal(result.ok, true, result.reason);
  const failed = await runDistillTask(task, { name: "claims-only", complete: async () => "修正してテストも通りました。" });
  assert.equal(failed.ok, false);
  let skipped = 1;
  const unread = await runDistillTask(task, { name: "no-read", complete: async () => actions[skipped++] ?? "完了です。" });
  assert.equal(unread.ok, false);
  assert.ok(unread.events.some((event) => event.type === "tool_end" && event.name === "edit_file" && !event.ok));
});
