// JSON の最上位のキー1つだけを追加・更新する。
// 全文を stringify すると、大きな整数・空白・既存の表記まで変わってしまう。
// JSON.parse で検証した後、対象の値の範囲だけを文字列として差し替える。
import { realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { readTextFile } from "./fs.ts";
import { safePath, show } from "./paths.ts";
import type { Tool, ToolContext } from "../types.ts";

type Property = { key: string; keyStart: number; start: number; end: number };

function parseJson(text: string): unknown {
  return JSON.parse(text.startsWith("\uFEFF") ? text.slice(1) : text);
}

function properties(text: string): Property[] {
  let parsed: unknown;
  try { parsed = parseJson(text); }
  catch { throw new Error("有効なJSONではありません。read_file で内容を確認してください。コメント付きJSONは対象外です。"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("edit_json は最上位がオブジェクトのJSONを編集します。配列や単独の値は対象外です。");
  }
  const found: Property[] = [];
  const keys = new Set<string>();
  let depth = 0;
  let key: string | undefined;
  let keyStart = -1;
  let start = -1;
  // 構文は上で検証済み。文字列内の括弧やエスケープを1トークンにまとめる。
  for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/g)) {
    const token = match[0];
    if (depth === 1) {
      if (start >= 0 && (token === "," || token === "}")) {
        let end = match.index;
        while (end > start && /\s/.test(text[end - 1]!)) end--;
        if (keys.has(key!)) throw new Error(`キー ${JSON.stringify(key)} が重複しています。編集箇所を一意に決められません。`);
        keys.add(key!);
        found.push({ key: key!, keyStart, start, end });
        key = undefined;
        start = -1;
      } else if (key === undefined && token.startsWith('"')) {
        key = JSON.parse(token) as string;
        keyStart = match.index;
      } else if (key !== undefined && start < 0 && token !== ":") {
        start = match.index;
      }
    }
    if (token === "{" || token === "[") depth++;
    if (token === "}" || token === "]") depth--;
  }
  return found;
}

async function checkedPath(ctx: ToolContext, abs: string): Promise<string> {
  const target = await realpath(abs);
  const root = await realpath(ctx.root);
  const rel = relative(root, target);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) {
    throw new Error("作業ルートの外を指すファイルは編集できません。");
  }
  return target;
}

export const editJsonTool: Tool = {
  name: "edit_json",
  description: "JSONの最上位のキー1つを追加・更新する。他のキーはそのまま残す。JSONの項目変更にはこれを使う。" +
    '引数の例: {"path":"config.json","key":"title","value":"練習"}',
  destructive: true,
  params: [
    { name: "path", type: "string", required: true, description: "既存のJSONファイルの相対パス" },
    { name: "key", type: "string", required: true, description: "追加・更新する最上位のキー名（ドットは階層を表さない）" },
    { name: "value", type: "json", required: true, description: "新しい値そのもの。文字列の前後に引用符という文字を追加しない。数値・真偽値・null・配列・オブジェクトもそのまま渡す" },
  ],
  async run(args, ctx) {
    const abs = safePath(ctx, args.path);
    if (typeof args.key !== "string") throw new Error("key は文字列で指定してください。");
    const key = args.key;
    let encoded: string | undefined;
    try {
      encoded = JSON.stringify(args.value, (_key, value: unknown) => {
        if (value === undefined || typeof value === "function" || typeof value === "symbol"
          || (typeof value === "number" && !Number.isFinite(value))) throw new Error("invalid value");
        return value;
      });
    } catch { throw new Error("value はJSONで表せる値を指定してください。"); }
    if (encoded === undefined) throw new Error("value は必須です。文字列・数値・真偽値・null・配列・オブジェクトを指定してください。");
    const target = await checkedPath(ctx, abs);
    if ((await stat(target)).size > 200_000) throw new Error("edit_json は200KB以下のJSONを対象にします。");
    const before = await readTextFile(ctx, abs);
    const fields = properties(before);
    const current = fields.find((field) => field.key === key);
    let after: string;
    if (current) {
      after = before.slice(0, current.start) + encoded + before.slice(current.end);
    } else {
      const last = fields.at(-1);
      const point = last?.end ?? before.indexOf("{") + 1;
      const multiline = before.includes("\n");
      const newline = before.includes("\r\n") ? "\r\n" : "\n";
      const prefix = before.slice(0, fields[0]?.keyStart ?? point);
      const indent = prefix.match(/(?:^|\n)([\t ]+)$/)?.[1] ?? "  ";
      const gap = multiline ? newline + indent : (last ? " " : "");
      after = before.slice(0, point) + (last ? "," : "") + gap + JSON.stringify(key) + ": " + encoded + before.slice(point);
    }
    parseJson(after); // 生成結果も検証し、不正なJSONは書き込まない。
    if (after === before) return `${show(ctx, abs)} の ${JSON.stringify(key)} はすでに指定された値です。`;
    const oldValue = current ? before.slice(current.start, current.end) : "(未登録)";
    const ok = await ctx.confirm(`${show(ctx, abs)} のキー ${JSON.stringify(key)} を${current ? "更新" : "追加"}します。\n  - ${oldValue.slice(0, 300)}\n  + ${encoded.slice(0, 300)}\nよろしいですか？`);
    if (!ok) return "ユーザーが編集を拒否しました。";
    if (await checkedPath(ctx, abs) !== target || await readTextFile(ctx, abs) !== before) {
      throw new Error("確認中にファイルが変わりました。read_file で読み直してから編集してください。");
    }
    await writeFile(abs, after, "utf8");
    return `${show(ctx, abs)} の ${JSON.stringify(key)} を ${encoded} にしました。他のキーは保持しました。read_file で確認してください。`;
  },
};
