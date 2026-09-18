// ツールの振る舞いを頭脳なしで検証する。
// LLM を挟まずに「壊れていないこと」を確かめられる場所を持っておくと、
// ツールを足すたびに手で確認する手間が消える。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseToolCalls, formatToolCall } from "../src/protocol.ts";
import { Agent } from "../src/agent.ts";
import type { AgentEvent, Provider } from "../src/types.ts";
import { searchTool } from "../src/tools/search.ts";
import { webFetchTool, htmlToText } from "../src/tools/web.ts";
import { editFileTool, replaceLinesTool } from "../src/tools/edit.ts";
import { readFileTool, writeFileTool } from "../src/tools/fs.ts";
import type { ToolContext } from "../src/types.ts";

type Fixture = { ctx: ToolContext; root: string; dispose: () => Promise<void> };

async function fixture(answer = true): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "origin-agent-test-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "const greeting = 1;\nconst other = 2;\n", "utf8");
  await writeFile(join(root, "src", "b.ts"), "const greeting = 3;\n", "utf8");
  await writeFile(join(root, "notes.md"), "greeting についてのメモ\n", "utf8");
  return {
    root,
    ctx: { root, confirm: async () => answer },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

test("protocol: ツール呼び出しと地の文を分離する", () => {
  const raw = `調べます。\n${formatToolCall("read_file", { path: "src/a.ts" })}\nお待ちください。`;
  const { calls, say } = parseToolCalls(raw);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "read_file");
  assert.deepEqual(calls[0]?.args, { path: "src/a.ts" });
  assert.match(say, /調べます/);
  assert.doesNotMatch(say, /<tool/);
});

test("protocol: 小さいモデルの崩れた書き方も受け付ける", () => {
  // 引用符が single / なし、中身がコードフェンス入り
  const raw = [
    `<tool name='list_files'>{"path":"src"}</tool>`,
    `<tool name=read_file>{"path":"a.ts"}</tool>`,
    '<tool name="search">\n```json\n{"pattern":"foo"}\n```\n</tool>',
  ].join("\n");
  const { calls } = parseToolCalls(raw);

  assert.deepEqual(
    calls.map((c) => c.name),
    ["list_files", "read_file", "search"],
  );
  assert.equal(calls.every((c) => c.error === undefined), true);
  assert.deepEqual(calls[2]?.args, { pattern: "foo" });
});

test("protocol: 単引用符で書かれた引数を直して読む", () => {
  // 3B が実際に出した形。中身に二重引用符を含む文字列を単引用符で囲んでくる。
  const raw = `<tool name="edit_file">{"path": "settings.json", "old_string": '"theme": "dark"', "new_string": '"theme": "dark",\\n  "language": "ja"'}</tool>`;
  const { calls } = parseToolCalls(raw);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.error, undefined);
  assert.deepEqual(calls[0]?.args, {
    path: "settings.json",
    old_string: '"theme": "dark"',
    new_string: '"theme": "dark",\n  "language": "ja"',
  });
});

test("protocol: バッククォートで書かれた引数も直して読む", () => {
  // 単引用符を直したら、同じモデルが今度はバッククォートを出してきた
  const raw =
    "<tool name=\"edit_file\">{\"path\": \"a.json\", \"old_string\": `\"theme\": \"dark\"`, \"new_string\": `\"theme\": \"dark\", \"language\": \"ja\"`}</tool>";
  const { calls } = parseToolCalls(raw);

  assert.equal(calls[0]?.error, undefined);
  assert.deepEqual(calls[0]?.args, {
    path: "a.json",
    old_string: '"theme": "dark"',
    new_string: '"theme": "dark", "language": "ja"',
  });
});

test("protocol: 正しい JSON は修復に回さず、そのまま読む", () => {
  // アポストロフィを含む値を壊さないこと
  const raw = `<tool name="write_file">{"path": "a.txt", "content": "it's fine"}</tool>`;
  const { calls } = parseToolCalls(raw);
  assert.equal(calls[0]?.error, undefined);
  assert.deepEqual(calls[0]?.args, { path: "a.txt", content: "it's fine" });
});

test("protocol: 壊れた JSON は例外にせずエラーとして持ち帰る", () => {
  const { calls } = parseToolCalls(`<tool name="read_file">{path: bad}</tool>`);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.error !== undefined);
});

test("安全装置: 作業ルートの外は読めない", async () => {
  const fx = await fixture();
  try {
    await assert.rejects(
      () => readFileTool.run({ path: "../../secret.txt" }, fx.ctx),
      /作業ルートの外/,
    );
  } finally {
    await fx.dispose();
  }
});

test("search: glob でファイルを絞り込める", async () => {
  const fx = await fixture();
  try {
    const all = await searchTool.run({ pattern: "greeting" }, fx.ctx);
    assert.match(all, /src\/a\.ts:1/);
    assert.match(all, /notes\.md:1/);

    const onlyTs = await searchTool.run({ pattern: "greeting", glob: "*.ts" }, fx.ctx);
    assert.match(onlyTs, /src\/a\.ts:1/);
    assert.doesNotMatch(onlyTs, /notes\.md/);
  } finally {
    await fx.dispose();
  }
});

test("edit_file: 一意に一致すれば置換する", async () => {
  const fx = await fixture();
  try {
    await editFileTool.run(
      { path: "src/a.ts", old_string: "const other = 2;", new_string: "const other = 99;" },
      fx.ctx,
    );
    const after = await readFile(join(fx.root, "src", "a.ts"), "utf8");
    assert.match(after, /const other = 99;/);
    assert.match(after, /const greeting = 1;/); // 巻き添えがないこと
  } finally {
    await fx.dispose();
  }
});

test("edit_file: 複数一致は replace_all なしでは拒否する", async () => {
  const fx = await fixture();
  try {
    await writeFile(join(fx.root, "dup.txt"), "x\nx\n", "utf8");
    await assert.rejects(
      () => editFileTool.run({ path: "dup.txt", old_string: "x", new_string: "y" }, fx.ctx),
      /2 箇所に一致/,
    );
    await editFileTool.run(
      { path: "dup.txt", old_string: "x", new_string: "y", replace_all: true },
      fx.ctx,
    );
    assert.equal(await readFile(join(fx.root, "dup.txt"), "utf8"), "y\ny\n");
  } finally {
    await fx.dispose();
  }
});

test("edit_file: 見つからない old_string は失敗する", async () => {
  const fx = await fixture();
  try {
    await assert.rejects(
      () => editFileTool.run({ path: "src/a.ts", old_string: "存在しない", new_string: "z" }, fx.ctx),
      /見つかりません/,
    );
  } finally {
    await fx.dispose();
  }
});

test("edit_file: 複数行を1行に詰めた old_string でも、空白を無視して1箇所なら置換する", async () => {
  const fx = await fixture();
  try {
    const source = "export function isAdult(age) {\n  return age > 18;\n}\n\nexport function other() {\n  return 1;\n}\n";
    await writeFile(join(fx.root, "age.js"), source, "utf8");
    const result = await editFileTool.run(
      { path: "age.js", old_string: "isAdult(age) { return age > 18; }", new_string: "isAdult(age) { return age >= 18; }" },
      fx.ctx,
    );
    assert.match(result, /1〜3 行目/);
    const after = await readFile(join(fx.root, "age.js"), "utf8");
    assert.equal(after, "export function isAdult(age) { return age >= 18; }\n\nexport function other() {\n  return 1;\n}\n");
  } finally {
    await fx.dispose();
  }
});

test("edit_file: 空白を無視した一致でも、インデントを二重にしない", async () => {
  const fx = await fixture();
  try {
    await writeFile(join(fx.root, "b.js"), "function f() {\n    return a+b;\n}\n", "utf8");
    // 行頭の空白の数も、演算子の前後の空白も実物と違う
    await editFileTool.run({ path: "b.js", old_string: "  return a + b;", new_string: "  return a * b;" }, fx.ctx);
    assert.equal(await readFile(join(fx.root, "b.js"), "utf8"), "function f() {\n    return a * b;\n}\n");
  } finally {
    await fx.dispose();
  }
});

test("edit_file: 空白を無視した一致で既存の定義が消えるなら、置換しない", async () => {
  const fx = await fixture();
  try {
    const source = "export function add(a, b) {\n  return a + b;\n}\n";
    await writeFile(join(fx.root, "math.js"), source, "utf8");
    // 「multiply を足して」と頼まれた 3B が実際に出した呼び出し
    await assert.rejects(
      () => editFileTool.run({
        path: "math.js",
        old_string: "export function add(a, b) { return a + b; }",
        new_string: "export function multiply(a, b) { return a * b; }",
      }, fx.ctx),
      /add の定義が消える.*old_string を空にすると/,
    );
    assert.equal(await readFile(join(fx.root, "math.js"), "utf8"), source);
  } finally {
    await fx.dispose();
  }
});

test("edit_file: old_string が空なら、new_string をファイル末尾に追加する", async () => {
  const fx = await fixture();
  try {
    await writeFile(join(fx.root, "math.js"), "export function add(a, b) {\n  return a + b;\n}\n", "utf8");
    const result = await editFileTool.run(
      { path: "math.js", old_string: "", new_string: "\nexport function multiply(a, b) { return a * b; }" },
      fx.ctx,
    );
    assert.match(result, /末尾に追加/);
    assert.equal(
      await readFile(join(fx.root, "math.js"), "utf8"),
      "export function add(a, b) {\n  return a + b;\n}\n\nexport function multiply(a, b) { return a * b; }\n",
    );

    // 末尾に改行がないファイルでも、既存の最終行とつながらない
    await writeFile(join(fx.root, "x.js"), "const a = 1;", "utf8");
    await editFileTool.run({ path: "x.js", old_string: "", new_string: "const b = 2;" }, fx.ctx);
    assert.equal(await readFile(join(fx.root, "x.js"), "utf8"), "const a = 1;\nconst b = 2;\n");

    await assert.rejects(() => editFileTool.run({ path: "x.js", old_string: "", new_string: "  " }, fx.ctx), /両方とも空/);
  } finally {
    await fx.dispose();
  }
});

test("edit_file: 空白を無視すると複数に一致するなら、置換せず行番号を示す", async () => {
  const fx = await fixture();
  try {
    const source = "if (a) {\n  x = 1;\n}\nif (b) {\n  x = 1;\n}\n";
    await writeFile(join(fx.root, "c.js"), source, "utf8");
    await assert.rejects(
      () => editFileTool.run({ path: "c.js", old_string: "x=1;", new_string: "x = 2;" }, fx.ctx),
      /2 箇所に一致.*2 行目、5 行目/,
    );
    assert.equal(await readFile(join(fx.root, "c.js"), "utf8"), source);
  } finally {
    await fx.dispose();
  }
});

test("edit_file: new_string の $& を特殊置換として解釈しない", async () => {
  const fx = await fixture();
  try {
    await editFileTool.run(
      { path: "src/b.ts", old_string: "const greeting = 3;", new_string: "const price = '$& $1 100%';" },
      fx.ctx,
    );
    const after = await readFile(join(fx.root, "src", "b.ts"), "utf8");
    assert.match(after, /const price = '\$& \$1 100%';/);
  } finally {
    await fx.dispose();
  }
});

test("search: path にファイルを直接指定できる", async () => {
  const fx = await fixture();
  try {
    // ディレクトリ前提で走査していた頃は、ここが「一致なし」になって頭脳を誤誘導した
    const hit = await searchTool.run({ pattern: "greeting", path: "src/a.ts" }, fx.ctx);
    assert.match(hit, /src\/a\.ts:1/);
    assert.doesNotMatch(hit, /src\/b\.ts/);

    await assert.rejects(
      () => searchTool.run({ pattern: "greeting", path: "ない.txt" }, fx.ctx),
      /存在しません/,
    );
  } finally {
    await fx.dispose();
  }
});

test("edit_file: old_string が正規表現っぽいと、そう名指しして教える", async () => {
  const fx = await fixture();
  try {
    await assert.rejects(
      () =>
        editFileTool.run(
          { path: "src/a.ts", old_string: "const \\w+ = 1;", new_string: "x" },
          fx.ctx,
        ),
      /正規表現/,
    );
  } finally {
    await fx.dispose();
  }
});

test("write_file: 既存ファイルを overwrite なしで潰さない", async () => {
  const fx = await fixture();
  try {
    const before = await readFile(join(fx.root, "src", "a.ts"), "utf8");

    // 「一部を直す」つもりで全文を捏造してくる、弱いモデルの再現
    await assert.rejects(
      () => writeFileTool.run({ path: "src/a.ts", content: "const greeting = 1;" }, fx.ctx),
      /すでに存在します/,
    );
    assert.equal(await readFile(join(fx.root, "src", "a.ts"), "utf8"), before);

    // 新規作成は素通し
    await writeFileTool.run({ path: "新しい.txt", content: "やあ" }, fx.ctx);
    assert.equal(await readFile(join(fx.root, "新しい.txt"), "utf8"), "やあ");

    // 明示的に overwrite したときだけ全文を置き換える
    await writeFileTool.run({ path: "src/a.ts", content: "置き換え済み", overwrite: true }, fx.ctx);
    assert.equal(await readFile(join(fx.root, "src", "a.ts"), "utf8"), "置き換え済み");
  } finally {
    await fx.dispose();
  }
});

test("replace_lines: 行番号で置き換える", async () => {
  const fx = await fixture();
  try {
    // src/a.ts は "const greeting = 1;\nconst other = 2;\n"（3行目は空）
    await replaceLinesTool.run(
      { path: "src/a.ts", start_line: 2, end_line: 2, new_text: "const other = 99;\nconst extra = 3;" },
      fx.ctx,
    );
    const after = await readFile(join(fx.root, "src", "a.ts"), "utf8");
    assert.equal(after, "const greeting = 1;\nconst other = 99;\nconst extra = 3;\n");
  } finally {
    await fx.dispose();
  }
});

test("replace_lines: 範囲外の行番号は拒否する", async () => {
  const fx = await fixture();
  try {
    await assert.rejects(
      () => replaceLinesTool.run({ path: "src/a.ts", start_line: 0, end_line: 1, new_text: "x" }, fx.ctx),
      /start_line が範囲外/,
    );
    await assert.rejects(
      () => replaceLinesTool.run({ path: "src/a.ts", start_line: 1, end_line: 99, new_text: "x" }, fx.ctx),
      /end_line が範囲外/,
    );
  } finally {
    await fx.dispose();
  }
});

test("replace_lines: new_text を空にすると行を削除する", async () => {
  const fx = await fixture();
  try {
    await replaceLinesTool.run({ path: "src/a.ts", start_line: 1, end_line: 1, new_text: "" }, fx.ctx);
    const after = await readFile(join(fx.root, "src", "a.ts"), "utf8");
    assert.equal(after, "const other = 2;\n");
  } finally {
    await fx.dispose();
  }
});

test("agent: 同じツール呼び出しの繰り返しを検出して止める", async () => {
  const fx = await fixture();
  try {
    // 何を返されても同じ呼び出しを続ける、行き詰まった頭脳の再現
    const stuckBrain: Provider = {
      name: "stuck",
      complete: async () => formatToolCall("read_file", { path: "src/a.ts" }),
    };

    const agent = new Agent({ provider: stuckBrain, tools: [readFileTool], ctx: fx.ctx });
    const events: AgentEvent[] = [];
    await agent.run("読んで", (e) => events.push(e));

    const done = events.find((e): e is Extract<AgentEvent, { type: "done" }> => e.type === "done");
    assert.equal(done?.reason, "stuck");

    // maxSteps(12) まで回らず、3回目の呼び出し前に止まる
    const invocations = events.filter((e) => e.type === "tool_start").length;
    assert.equal(invocations, 2);
  } finally {
    await fx.dispose();
  }
});

test("agent: 編集した後の読み直しは、繰り返しとして数えない", async () => {
  const fx = await fixture();
  try {
    // 読む → 読む → 直す → 読み直す。3回目の read_file は内容が変わった後なので正当な確認
    const script = [
      formatToolCall("read_file", { path: "src/a.ts" }),
      formatToolCall("read_file", { path: "src/a.ts" }),
      formatToolCall("edit_file", { path: "src/a.ts", old_string: "= 1;", new_string: "= 10;" }),
      formatToolCall("read_file", { path: "src/a.ts" }),
      "直しました。",
    ];
    const brain: Provider = { name: "script", complete: async () => script.shift() ?? "終わりました。" };
    const agent = new Agent({ provider: brain, tools: [readFileTool, editFileTool], ctx: fx.ctx });
    const events: AgentEvent[] = [];
    await agent.run("a.ts の 1 を 10 にして", (e) => events.push(e));

    const done = events.find((e): e is Extract<AgentEvent, { type: "done" }> => e.type === "done");
    assert.equal(done?.reason, "answered");
    assert.equal(events.filter((e) => e.type === "tool_start").length, 4);
  } finally {
    await fx.dispose();
  }
});

test("agent: 使えない web_ ツールを呼んでも、調べものの失敗として打ち切らない", async () => {
  const fx = await fixture();
  try {
    const script = [
      formatToolCall("web_search", { query: "npm test failed" }),
      formatToolCall("read_file", { path: "src/a.ts" }),
      "読みました。",
    ];
    const brain: Provider = { name: "script", complete: async () => script.shift() ?? "終わりました。" };
    const agent = new Agent({ provider: brain, tools: [readFileTool], ctx: fx.ctx });
    const events: AgentEvent[] = [];
    await agent.run("a.ts を読んで", (e) => events.push(e));

    const ends = events.filter((e): e is Extract<AgentEvent, { type: "tool_end" }> => e.type === "tool_end");
    assert.equal(ends[0]?.ok, false);
    assert.match(ends[0]?.result ?? "", /使えません/);
    assert.equal(ends[1]?.name, "read_file");
    const answers = events.filter((e): e is Extract<AgentEvent, { type: "assistant" }> => e.type === "assistant");
    assert.equal(answers.at(-1)?.text, "読みました。");
  } finally {
    await fx.dispose();
  }
});

test("web: HTML を本文テキストに落とす", () => {
  const { title, text } = htmlToText(
    `<html><head><title>テスト &amp; 見本</title>
     <style>body{color:red}</style></head>
     <body><script>alert(1)</script>
     <h1>見出し</h1><p>本文の &lt;段落&gt; です。</p><p>2つ目&#x3002;</p></body></html>`,
  );

  assert.equal(title, "テスト & 見本");
  assert.doesNotMatch(text, /alert|color:red/); // script / style は落ちる
  assert.match(text, /本文の <段落> です。/); // 実体参照が戻る
  assert.match(text, /2つ目。/); // 数値参照も戻る
});

test("web: 本文領域を優先し、長いメニューより後ろの資料を残す", () => {
  const { title, text } = htmlToText(`<title>県の概要</title><nav>${"案内 ".repeat(5000)}</nav><main><h1>県の概要</h1><p>面積は1234km²。</p><nav>関連リンク</nav></main><footer>電話番号1234</footer>`);
  assert.equal(title, "県の概要");
  assert.match(text, /面積は1234km²/);
  assert.doesNotMatch(text, /案内|関連リンク|電話番号/);
  assert.match(htmlToText("<nav>メニュー</nav><p>mainがない本文</p>").text, /mainがない本文/);
  const article = htmlToText('<script>"<main>偽の本文</main>"</script><main><header>2026年9月の統計</header><p>実際の本文</p></main>').text;
  assert.match(article, /2026年9月の統計/);
  assert.match(article, /実際の本文/);
  assert.doesNotMatch(article, /偽の本文/);
});

test("web_fetch: http/https 以外は拒否する", async () => {
  const ctx: ToolContext = { root: process.cwd(), confirm: async () => true };
  await assert.rejects(() => webFetchTool.run({ url: "file:///C:/Windows/win.ini" }, ctx), /http\/https/);
  await assert.rejects(() => webFetchTool.run({ url: "これはURLではない" }, ctx), /URL として解釈できません/);
});

test("web_fetch: 確認を拒否したら通信しない", async () => {
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    called = true;
    throw new Error("通信してはいけない");
  }) as typeof fetch;
  try {
    const ctx: ToolContext = { root: process.cwd(), confirm: async () => false };
    const result = await webFetchTool.run({ url: "https://example.com" }, ctx);
    assert.match(result, /拒否/);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = original;
  }
});

test("edit_file: 確認を拒否したらファイルは変わらない", async () => {
  const fx = await fixture(false);
  try {
    const before = await readFile(join(fx.root, "src", "a.ts"), "utf8");
    const result = await editFileTool.run(
      { path: "src/a.ts", old_string: "const other = 2;", new_string: "const other = 99;" },
      fx.ctx,
    );
    assert.match(result, /拒否/);
    assert.equal(await readFile(join(fx.root, "src", "a.ts"), "utf8"), before);
  } finally {
    await fx.dispose();
  }
});
