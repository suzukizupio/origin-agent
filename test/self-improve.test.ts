import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { formatToolCall } from "../src/protocol.ts";
import { isEditableSourcePath, proposeSelfChange, proposalTools } from "../src/self-improve.ts";
import type { AgentEvent, Provider } from "../src/types.ts";
import { temporaryDirectory } from "./helpers.ts";

test("自己改修の候補は src の既存ファイルだけ変更できる", async (t) => {
  const root = await temporaryDirectory(t);
  await mkdir(join(root, "src"));
  await mkdir(join(root, "test"));
  await writeFile(join(root, "src", "a.js"), "export const value = 1;\n");
  await writeFile(join(root, "test", "a.test.js"), "const expected = 1;\n");
  assert.equal(isEditableSourcePath("src/a.js"), true);
  for (const path of ["test/a.test.js", "src/../test/a.test.js", "src\\..\\test\\a.test.js", "C:\\tmp\\a.js", "src/self-improve.ts", "src/sandbox-eval.ts"]) {
    assert.equal(isEditableSourcePath(path), false, path);
  }
  assert.equal(proposalTools.some((tool) => tool.name === "run_shell" || tool.name.startsWith("web_")), false);

  const outputs = [
    formatToolCall("edit_file", { path: "test/a.test.js", old_string: "1", new_string: "2" }),
    formatToolCall("edit_file", { path: "src/a.js", old_string: "1", new_string: "2" }),
    "候補を作りました。",
  ];
  const provider: Provider = { name: "scripted", complete: async () => outputs.shift() ?? "" };
  const events: AgentEvent[] = [];
  await proposeSelfChange(root, "src の値を更新", provider, (event) => events.push(event));

  assert.equal(await readFile(join(root, "test", "a.test.js"), "utf8"), "const expected = 1;\n");
  assert.equal(await readFile(join(root, "src", "a.js"), "utf8"), "export const value = 2;\n");
  assert.ok(events.some((event) => event.type === "tool_end" && event.name === "edit_file" && !event.ok));
});
