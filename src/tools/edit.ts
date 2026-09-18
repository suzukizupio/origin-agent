// ファイルの一部だけを厳密一致で置換するツール。
//
// write_file（全文上書き）との差は大きい:
//   1. 頭脳が全文を書き直さずに済むので、無関係な行を勝手に壊さない
//   2. 出力トークンが桁で減る。小さいモデルほどこの差が効く
//   3. old_string を正確に引用させることで、実物を読まずに編集する事故を防げる
// 「一意に一致しなければ失敗」という厳しさが、そのまま安全装置になっている。

import { writeFile } from "node:fs/promises";
import { safePath, show } from "./paths.ts";
import { readTextFile } from "./fs.ts";
import type { Tool } from "../types.ts";

const PREVIEW_LINES = 6;

function preview(text: string): string {
  const lines = text.split("\n");
  const head = lines.slice(0, PREVIEW_LINES).join("\n    ");
  return lines.length > PREVIEW_LINES ? `${head}\n    … 他 ${lines.length - PREVIEW_LINES} 行` : head;
}

/**
 * 行番号で範囲を指定して置き換えるツール。
 *
 * edit_file は「文字列を正確に引き写せる」ことを前提にしているが、
 * 小さいモデルはファイルを読んだ直後でもそれができず、それらしい行を捏造する。
 * read_file が行番号を出している以上、番号で指させれば引き写しは要らない。
 *
 * 引き換えに脆さもある。編集するたび以降の行番号がずれるので、
 * 1回ごとに read_file で読み直す必要がある。
 * 引き写せるモデルには edit_file のほうが安全。
 */
export const replaceLinesTool: Tool = {
  name: "replace_lines",
  description:
    "read_file が示した行番号で範囲を指定して置き換える。" +
    "文字列を正確に引用するのが難しいときはこちらを使う。1回編集するたび行番号は変わる",
  destructive: true,
  params: [
    { name: "path", type: "string", required: true, description: "作業ルートからの相対パス" },
    { name: "start_line", type: "number", required: true, description: "置き換える最初の行番号（1始まり、この行を含む）" },
    { name: "end_line", type: "number", required: true, description: "置き換える最後の行番号（この行を含む）" },
    {
      name: "new_text",
      type: "string",
      required: true,
      description: "置き換え後のテキスト。行番号は付けない。空文字にするとその範囲を削除する",
    },
  ],
  async run(args, ctx) {
    const abs = safePath(ctx, args.path);
    const { start_line: start, end_line: end, new_text: newText } = args;

    if (typeof start !== "number" || typeof end !== "number") {
      throw new Error("start_line と end_line は数値です");
    }
    if (typeof newText !== "string") {
      throw new Error("new_text は必須の文字列です");
    }

    const before = await readTextFile(ctx, abs);
    const lines = before.split("\n");

    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw new Error("start_line と end_line は整数で指定してください");
    }
    if (start < 1 || start > lines.length) {
      throw new Error(`start_line が範囲外です: ${start}（このファイルは ${lines.length} 行）`);
    }
    if (end < start || end > lines.length) {
      throw new Error(`end_line が範囲外です: ${end}（start_line 以上 ${lines.length} 以下）`);
    }

    const removed = lines.slice(start - 1, end);
    const inserted = newText === "" ? [] : newText.split("\n");
    const after = [...lines.slice(0, start - 1), ...inserted, ...lines.slice(end)].join("\n");

    const ok = await ctx.confirm(
      [
        `${show(ctx, abs)} の ${start}〜${end} 行目を置き換えます。`,
        `  - ${preview(removed.join("\n"))}`,
        `  + ${preview(inserted.join("\n"))}`,
        "よろしいですか？",
      ].join("\n"),
    );
    if (!ok) return "ユーザーが編集を拒否しました。";

    await writeFile(abs, after, "utf8");
    return (
      `${show(ctx, abs)} の ${start}〜${end} 行目（${removed.length} 行）を ${inserted.length} 行に置き換えました。` +
      `行番号がずれたので、続けて編集するなら read_file で読み直してください。`
    );
  },
};

export const editFileTool: Tool = {
  name: "edit_file",
  description:
    "ファイル内の文字列を厳密一致で置換する。全文を書き直さずに一部だけ直せる。" +
    "old_string は正規表現ではなく、ファイルからそのまま引用した文字列",
  destructive: true,
  params: [
    { name: "path", type: "string", required: true, description: "作業ルートからの相対パス" },
    {
      name: "old_string",
      type: "string",
      required: true,
      description:
        "置換したい既存の文字列をそのまま引用する。正規表現やワイルドカードは使えない。" +
        "read_file の出力の行頭にある行番号とタブは含めないこと。ファイル内でちょうど1箇所に一致する必要がある",
    },
    { name: "new_string", type: "string", required: true, description: "置き換え後の文字列" },
    {
      name: "replace_all",
      type: "boolean",
      required: false,
      description: "一致箇所すべてを置換する。変数名の一括改名などに使う",
    },
  ],
  async run(args, ctx) {
    const abs = safePath(ctx, args.path);
    const oldString = args.old_string;
    const newString = args.new_string;

    if (typeof oldString !== "string") {
      throw new Error("old_string は必須の文字列です");
    }
    if (oldString === "") {
      // 空の old_string は「ここに挿入したい」の意思表示として出てくる。
      // このツールは置換しかできないので、置換で追加する書き方を示す。
      throw new Error(
        [
          "old_string が空です。edit_file は置換専用で、挿入はできません。",
          "追加したいときは、追加する場所の既存の行を old_string にして、",
          "new_string にその既存の行と新しい行の両方を書いてください。",
          "old_string は read_file で見た通りの文字列にすること。",
          "行番号で位置を指定したい場合は replace_lines を使ってください。",
        ].join("\n"),
      );
    }
    if (typeof newString !== "string") {
      throw new Error("new_string は必須の文字列です");
    }
    if (oldString === newString) {
      throw new Error("old_string と new_string が同じです");
    }

    const before = await readTextFile(ctx, abs);
    const parts = before.split(oldString);
    const hits = parts.length - 1;

    if (hits === 0) {
      // 小さいモデルの典型的な外し方を先回りして名指しする。
      // 「見つかりません」だけだと、同じ old_string で延々と再試行してくる。
      const looksLikeRegex = /\\[dws.+*?]|\[\^?.+\]|\.\*|\\\./.test(oldString);
      throw new Error(
        [
          `old_string がファイル内に見つかりません。`,
          looksLikeRegex
            ? `old_string が正規表現に見えます。このツールは正規表現を解釈しません。ファイル内の文字列をそのまま引用してください。`
            : `read_file で現在の内容を確認し、空白や改行まで正確に引用してください。`,
          `行頭の行番号とタブ（read_file が付けたもの）は含めないこと。`,
          `ファイル内の引用符を落としていないか確認してください。一意な短い部分だけを old_string にする方法もあります。`,
          `どこを直すか分からない場合は、先に search で該当箇所を探してください。`,
        ].join("\n"),
      );
    }
    const replaceAll = args.replace_all === true;
    if (hits > 1 && !replaceAll) {
      throw new Error(
        `old_string が ${hits} 箇所に一致します。前後の行を含めて一意になるまで広げるか、replace_all を true にしてください。`,
      );
    }

    // String.replace は new_string 中の $& などを特殊置換として解釈してしまうため使わない
    const index = before.indexOf(oldString);
    const after = replaceAll
      ? parts.join(newString)
      : before.slice(0, index) + newString + before.slice(index + oldString.length);

    const ok = await ctx.confirm(
      [
        `${show(ctx, abs)} を編集します。`,
        `  - ${preview(oldString)}`,
        `  + ${preview(newString)}`,
        `${hits} 箇所を置換します。よろしいですか？`,
      ].join("\n"),
    );
    if (!ok) return "ユーザーが編集を拒否しました。";

    await writeFile(abs, after, "utf8");
    const delta = after.split("\n").length - before.split("\n").length;
    const deltaText = delta === 0 ? "行数は変わりません" : `行数 ${delta > 0 ? "+" : ""}${delta}`;
    return `${show(ctx, abs)} の ${hits} 箇所を置換しました（${deltaText}）。`;
  },
};
