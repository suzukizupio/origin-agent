// 一時ディレクトリだけで、実際のモデルの小さなコード編集を確かめる。
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { Agent } from "../src/agent.ts";
import { allTools } from "../src/tools/index.ts";
import { resolveProvider } from "../src/providers/index.ts";

const provider = await resolveProvider("auto", process.argv[2]);
if (provider.name === "rule") throw new Error("Ollama のモデルを起動してから実行してください。");
const parent = resolve(tmpdir());
const root = await mkdtemp(join(parent, "origin-agent-code-check-"));
try {
  await writeFile(join(root, "config.json"), '{\n  "port": 3000,\n  "name": "practice"\n}\n');
  const agent = new Agent({
    provider, mode: "code", maxSteps: 6,
    // ファイルの読み取りと部分編集だけで採点する。シェルやネットは渡さない。
    tools: allTools.filter((tool) => ["list_files", "search", "read_file", "edit_json", "edit_file", "replace_lines"].includes(tool.name)),
    ctx: { root, confirm: async () => true },
  });
  console.log(`頭脳: ${provider.name}\n課題: config.json の port だけを 3000 から 4000 に変更する`);
  await agent.run("Change only port from 3000 to 4000 in config.json. Read the file first and verify the change.", (event) => {
    if (event.type === "assistant") console.log(event.text);
    if (event.type === "tool_start") console.log(`  ${event.name} ${JSON.stringify(event.args)}`);
    if (event.type === "tool_end") console.log(`  ${event.ok ? "✓" : "✗"} ${event.result}`);
    if (event.type === "done") console.log(`終了理由: ${event.reason}`);
  });
  const contents = await readFile(join(root, "config.json"), "utf8");
  assert.deepEqual(JSON.parse(contents), { port: 4000, name: "practice" });
  console.log("✓ 指定値への変更と、無関係な設定の保持を確認しました。");
} finally {
  const rel = relative(parent, resolve(root));
  if (isAbsolute(rel) || !rel.startsWith("origin-agent-code-check-") || /[\\/]/.test(rel) || rel.includes("..")) {
    throw new Error("一時ディレクトリの範囲を確認できません。削除を中止します。");
  }
  await rm(root, { recursive: true, force: true });
}
