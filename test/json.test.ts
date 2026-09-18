import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { editJsonTool } from "../src/tools/json.ts";
import { temporaryDirectory } from "./helpers.ts";

test("edit_json: 追加時に既存の値・大きな数・空白・改行をそのまま残す", async (t) => {
  const root = await temporaryDirectory(t);
  const file = join(root, "settings.json");
  const before = '{\r\n\t"theme": "dark",\r\n\t"huge": 9007199254740993,\r\n\t"nested": {"a": [true, null, "} , \\\" :"]},\r\n\t"number": 1e400\r\n}\r\n';
  await writeFile(file, before);
  await editJsonTool.run({ path: "settings.json", key: "language", value: "ja" }, { root, confirm: async () => true });
  const after = await readFile(file, "utf8");
  assert.equal(after, before.replace('1e400\r\n}', '1e400,\r\n\t"language": "ja"\r\n}'));
  assert.equal(JSON.parse(after).language, "ja");
});

test("edit_json: 対象の値だけを更新し、JSONの各種の値を扱える", async (t) => {
  const root = await temporaryDirectory(t);
  const file = join(root, "settings.json");
  const before = '{ "target" : {"old": [1, 2]}, "keep": -0.00e+3 }';
  for (const value of [42, "日本語と\"引用符\"", true, null, [1, "two"], { nested: { enabled: false } }]) {
    await writeFile(file, before);
    await editJsonTool.run({ path: "settings.json", key: "target", value }, { root, confirm: async () => true });
    assert.equal(await readFile(file, "utf8"), before.replace('{"old": [1, 2]}', JSON.stringify(value)));
  }
});

test("edit_json: 空のオブジェクト・BOM・特殊な文字を含むキーも扱える", async (t) => {
  const root = await temporaryDirectory(t);
  const file = join(root, "settings.json");
  for (const before of ["{}", "{\n}", "{\r\n}\r\n", "\uFEFF{\r\n}\r\n"]) {
    await writeFile(file, before);
    for (const key of ["", "a.b", "__proto__", 'quote"\\key']) {
      await editJsonTool.run({ path: "settings.json", key, value: { safe: true } }, { root, confirm: async () => true });
      const after = await readFile(file, "utf8");
      assert.equal(after.startsWith("\uFEFF"), before.startsWith("\uFEFF"));
      const parsed = JSON.parse(after.replace(/^\uFEFF/, ""));
      assert.ok(Object.hasOwn(parsed, key));
      assert.deepEqual(parsed[key], { safe: true });
    }
  }
  assert.equal(({} as Record<string, unknown>).safe, undefined);
});

test("edit_json: 無効なJSON・曖昧なキー・不正な値は書き込まない", async (t) => {
  const root = await temporaryDirectory(t);
  const file = join(root, "settings.json");
  for (const before of ['{"x":1,}', '[1,2]', 'null', '{"x":1,"\\u0078":2}']) {
    await writeFile(file, before);
    await assert.rejects(editJsonTool.run({ path: "settings.json", key: "y", value: 2 }, { root, confirm: async () => { throw new Error("確認には進まない"); } }));
    assert.equal(await readFile(file, "utf8"), before);
  }
  await writeFile(file, '{}');
  for (const value of [undefined, NaN, Infinity, { invalid: undefined }, 1n]) {
    await assert.rejects(editJsonTool.run({ path: "settings.json", key: "x", value }, { root, confirm: async () => true }), /value/);
    assert.equal(await readFile(file, "utf8"), '{}');
  }
});

test("edit_json: 拒否時と変更不要時には書き込まない", async (t) => {
  const root = await temporaryDirectory(t);
  const file = join(root, "settings.json");
  await writeFile(file, '{"port":3000}');
  const result = await editJsonTool.run({ path: "settings.json", key: "port", value: 4000 }, { root, confirm: async () => false });
  assert.match(result, /拒否/);
  assert.equal(await readFile(file, "utf8"), '{"port":3000}');
  assert.match(await editJsonTool.run({ path: "settings.json", key: "port", value: 3000 }, { root, confirm: async () => { throw new Error("確認不要"); } }), /すでに/);
});

test("edit_json: 確認中のユーザーの変更を上書きしない", async (t) => {
  const root = await temporaryDirectory(t);
  const file = join(root, "settings.json");
  await writeFile(file, '{"port":3000}');
  await assert.rejects(editJsonTool.run({ path: "settings.json", key: "port", value: 4000 }, {
    root, confirm: async () => { await writeFile(file, '{"port":5000}'); return true; },
  }), /確認中にファイルが変わりました/);
  assert.equal(await readFile(file, "utf8"), '{"port":5000}');
});

test("edit_json: 外部を指すディレクトリリンクから作業ルートを出られない", async (t) => {
  const root = await temporaryDirectory(t);
  const outside = await temporaryDirectory(t);
  await writeFile(join(outside, "settings.json"), '{"port":3000}');
  await symlink(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(editJsonTool.run({ path: "linked/settings.json", key: "port", value: 4000 }, { root, confirm: async () => true }), /作業ルートの外/);
  assert.equal(await readFile(join(outside, "settings.json"), "utf8"), '{"port":3000}');
});
