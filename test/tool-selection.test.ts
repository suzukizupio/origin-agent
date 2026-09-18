import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Agent } from "../src/agent.ts";
import { allTools } from "../src/tools/index.ts";
import { formatToolCall } from "../src/protocol.ts";
import { temporaryDirectory } from "./helpers.ts";

test("道具の選択: JSONを明示したときだけ最初から専用ツールを渡す", async (t) => {
  const root = await temporaryDirectory(t);
  await writeFile(join(root, "settings.json"), "{}");
  await writeFile(join(root, "worker.ts"), "const count = 1;");
  let expected = false;
  const agent = new Agent({ tools: allTools, mode: "code", ctx: { root, confirm: async () => true }, provider: {
    name: "test", complete: async (_messages, tools) => {
      assert.equal(tools.some((tool) => tool.name === "edit_json"), expected);
      assert.ok(tools.some((tool) => tool.name === "edit_file"));
      return "完了";
    },
  } });
  await agent.run("worker.ts を説明して", () => {});
  expected = true;
  await agent.run("settings.json に count を追加して", () => {});
});

test("道具の選択: ファイルを発見して読んだ後と、その続きの依頼でもJSONを編集できる", async (t) => {
  const root = await temporaryDirectory(t);
  await writeFile(join(root, "preferences.json"), "{}");
  await writeFile(join(root, "worker.ts"), "const count = 1;");
  let step = 0;
  const agent = new Agent({ tools: allTools, mode: "code", ctx: { root, confirm: async () => true }, provider: {
    name: "test", complete: async (_messages, tools) => {
      const hasJson = tools.some((tool) => tool.name === "edit_json");
      if (step++ === 0) {
        assert.equal(hasJson, false);
        return formatToolCall("read_file", { path: "preferences.json" });
      }
      assert.equal(hasJson, step <= 3);
      return "確認しました";
    },
  } });
  await agent.run("設定ファイルを読んで", () => {}); // 最初は非表示、読んだ後に表示。
  await agent.run("その設定に count を追加して", () => {}); // 続きの依頼にも表示。
  await agent.run("worker.ts を説明して", () => {}); // 別のファイルを明示したら非表示。
  agent.reset();
  await agent.run("設定を確認して", () => {}); // リセットで対象も忘れる。
});

test("道具の選択: edit_json で編集したファイルにも続けて依頼できる", async (t) => {
  const root = await temporaryDirectory(t);
  await writeFile(join(root, "preferences.json"), "{}");
  let step = 0;
  const agent = new Agent({ tools: allTools, mode: "code", ctx: { root, confirm: async () => true }, provider: {
    name: "test", complete: async (_messages, tools) => {
      assert.ok(tools.some((tool) => tool.name === "edit_json"));
      if (step++ === 0) return formatToolCall("edit_json", { path: "preferences.json", key: "enabled", value: true });
      return "完了しました";
    },
  } });
  await agent.run("preferences.json の enabled を true にして", () => {});
  await agent.run("その設定に項目をもう1つ追加して", () => {});
});
