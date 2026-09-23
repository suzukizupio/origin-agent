// ファイルの一部だけを厳密一致で置換するツール。
//
// write_file（全文上書き）との差は大きい:
//   1. 頭脳が全文を書き直さずに済むので、無関係な行を勝手に壊さない
//   2. 出力トークンが桁で減る。小さいモデルほどこの差が効く
//   3. old_string を正確に引用させることで、実物を読まずに編集する事故を防げる
// 「一意に一致しなければ失敗」という厳しさが、そのまま安全装置になっている。
//
// v0.7 で小さいモデル向けの受け止め方を2つ足した（ツールの説明文は変えていない）:
//   - 厳密一致しないとき、空白と改行を無視して1箇所に絞れれば置換する。ただし既存の定義を消す置換は通さない
//   - old_string が空なら、new_string をファイル末尾に追加する
// どの書き込みも writeChecked を通す。JavaScript を壊した編集は元に戻して失敗にする（syntax.ts）。

import { safePath, show } from "./paths.ts";
import { readTextFile } from "./fs.ts";
import { writeChecked } from "./syntax.ts";
import type { Tool, ToolContext } from "../types.ts";

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

    const note = await writeChecked(abs, before, after, show(ctx, abs));
    return (
      `${show(ctx, abs)} の ${start}〜${end} 行目（${removed.length} 行）を ${inserted.length} 行に置き換えました。` +
      `行番号がずれたので、続けて編集するなら read_file で読み直してください。` +
      (note ? `\n${note}` : "")
    );
  },
};

type Span = { start: number; end: number };

/**
 * 空白と改行を無視して old_string を探す。見つかった範囲は、ファイル側の
 * 最初と最後の非空白文字で区切る（前後のインデントや改行は含めない）。
 *
 * 実測: 3B は複数行の関数を1行に詰めて引用する。
 *   ファイル:   isAdult(age) {\n  return age > 18;\n}
 *   old_string: isAdult(age) { return age > 18; }
 * 意図は明らかなのに厳密一致で落ち、同じ引数で再試行して行き詰まった。
 */
function findIgnoringWhitespace(text: string, needle: string): Span[] {
  const compactNeedle = needle.replace(/\s+/g, "");
  if (compactNeedle === "") return [];
  // 空白を除いた文字列と、その各文字が元のどこにあったか
  const positions: number[] = [];
  let compact = "";
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i]!)) continue;
    compact += text[i];
    positions.push(i);
  }
  const spans: Span[] = [];
  for (let at = compact.indexOf(compactNeedle); at >= 0; at = compact.indexOf(compactNeedle, at + 1)) {
    spans.push({ start: positions[at]!, end: positions[at + compactNeedle.length - 1]! + 1 });
  }
  return spans;
}

/**
 * old_string に出てくる名前や数値を多く含む行を、近い順に返す。
 *
 * 実測: 3B は read_file で実物を読んだ直後でも、最初に思い込んだ文字列
 * （"TIMEOUT_MS: 20_000"。実物は "export const TIMEOUT_MS = 20_000;"）で置換を繰り返し、
 * 同じ呼び出しの3回目で打ち切られた（5回中3回）。
 * 「正確に引用して」と言うだけでなく、引用すべき実物を JSON 文字列の形で見せる。
 */
function nearestLines(text: string, needle: string, limit = 3): string[] {
  const tokens = [...new Set(needle.match(/[A-Za-z_$][\w$]*|\d[\d_.]*/g) ?? [])];
  if (tokens.length === 0) return [];
  const needed = Math.max(1, Math.ceil(tokens.length / 2));
  return text.split("\n")
    .map((line, index) => {
      const words = new Set(line.match(/[A-Za-z_$][\w$]*|\d[\d_.]*/g) ?? []);
      return { line: line.trim(), number: index + 1, score: tokens.filter((token) => words.has(token)).length };
    })
    .filter((candidate) => candidate.line !== "" && candidate.score >= needed)
    .sort((a, b) => b.score - a.score || a.number - b.number)
    .slice(0, limit)
    .map((candidate) => `  ${candidate.number} 行目: ${JSON.stringify(candidate.line)}`);
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

const DEFINITION = /\b(?:function\s*\*?\s*|class\s+|(?:const|let|var)\s+)([A-Za-z_$][\w$]*)/g;

/** 関数・クラス・変数として定義されている名前（JavaScript / TypeScript の書き方） */
function definedNames(text: string): Set<string> {
  return new Set([...text.matchAll(DEFINITION)].map((match) => match[1]!));
}

/**
 * old_string が空のときは、new_string をファイル末尾に足す。
 *
 * 実測: 関数を足してと頼まれた 3B は、3回中3回とも old_string を空にして追加しようとした。
 * 以前は「置換専用で挿入はできません」と断っていたが、既存の行を引用し直す書き方には
 * 一度も移れず、同じ呼び出しを繰り返して行き詰まった。意図は明らかなので、その形で受け止める。
 */
async function append(ctx: ToolContext, abs: string, addition: string): Promise<string> {
  if (addition.trim() === "") {
    throw new Error("old_string と new_string が両方とも空です。追加する内容を new_string に書いてください。");
  }
  const before = await readTextFile(ctx, abs);
  const separator = before === "" || before.endsWith("\n") ? "" : "\n";
  let after = before + separator + addition;
  if (!after.endsWith("\n")) after += "\n";

  const ok = await ctx.confirm(
    [
      `${show(ctx, abs)} の末尾に追加します（old_string が空のため）。`,
      `  + ${preview(addition.replace(/^\n+/, ""))}`,
      "よろしいですか？",
    ].join("\n"),
  );
  if (!ok) return "ユーザーが編集を拒否しました。";

  const note = await writeChecked(abs, before, after, show(ctx, abs));
  return (
    `old_string が空だったので、new_string を ${show(ctx, abs)} の末尾に追加しました` +
    `（${before.split("\n").length} 行 → ${after.split("\n").length} 行）。` +
    `ほかの場所に入れたかった場合は、その場所の既存の行を old_string にしてください。read_file で結果を確認してください。` +
    (note ? `\n${note}` : "")
  );
}

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
      // 実測: 末尾に足すつもりの 3B が old_string ごと書き忘れた。空と同じ（末尾に追加）として受ける
      fallback: "",
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
    if (typeof newString !== "string") {
      throw new Error("new_string は必須の文字列です");
    }
    if (oldString === "") return await append(ctx, abs, newString);
    if (oldString === newString) {
      throw new Error("old_string と new_string が同じです");
    }

    const before = await readTextFile(ctx, abs);
    const parts = before.split(oldString);
    const hits = parts.length - 1;

    // 厳密一致しないときだけ、空白と改行を無視して探す。1箇所に絞れたときに限り置換する
    const loose = hits === 0 ? findIgnoringWhitespace(before, oldString) : [];
    if (loose.length > 1) {
      throw new Error(
        `old_string が見つかりません。空白と改行を無視すると ${loose.length} 箇所に一致しました` +
          `（${loose.map((span) => `${lineOf(before, span.start)} 行目`).join("、")}）。` +
          `前後の行を含めて一意になるまで広げてください。`,
      );
    }
    if (loose.length === 1) {
      const span = loose[0]!;
      // 見つかった範囲は前後の空白を含まない。old_string の前後にあった空白は
      // new_string からも外し、インデントや改行が二重にならないようにする
      const lead = oldString.match(/^\s*/)?.[0] ?? "";
      const trail = oldString.match(/\s*$/)?.[0] ?? "";
      let replacement = newString;
      if (lead && replacement.startsWith(lead)) replacement = replacement.slice(lead.length);
      if (trail && replacement.endsWith(trail)) replacement = replacement.slice(0, replacement.length - trail.length);
      const after = before.slice(0, span.start) + replacement + before.slice(span.end);
      const from = lineOf(before, span.start);
      const to = lineOf(before, span.end);

      // 推測で広げた一致なので、既存の定義を消す置換までは通さない。
      // 実測: 関数を「足して」と頼まれた 3B が、add を丸ごと multiply に置き換えようとした。
      const lost = [...definedNames(before.slice(span.start, span.end))].filter((name) => !definedNames(replacement).has(name));
      if (lost.length > 0) {
        throw new Error(
          `空白と改行を無視すると ${from}〜${to} 行目に一致しましたが、この置換では ${lost.join("、")} の定義が消えるため、置換しませんでした。` +
            `既存の定義を残すなら new_string にも含めてください。新しい関数を足すだけなら、old_string を空にするとファイル末尾に追加できます。`,
        );
      }

      const ok = await ctx.confirm(
        [
          `${show(ctx, abs)} を編集します（空白と改行の違いを無視して一致した ${from}〜${to} 行目）。`,
          `  - ${preview(before.slice(span.start, span.end))}`,
          `  + ${preview(replacement)}`,
          "よろしいですか？",
        ].join("\n"),
      );
      if (!ok) return "ユーザーが編集を拒否しました。";

      const note = await writeChecked(abs, before, after, show(ctx, abs));
      return (
        `old_string は空白や改行が実物と違いましたが、それを無視すると ${from}〜${to} 行目の1箇所に一致したので置換しました。` +
        `read_file で結果を確認してください。` +
        (note ? `\n${note}` : "")
      );
    }

    if (hits === 0) {
      // 小さいモデルの典型的な外し方を先回りして名指しする。
      // 「見つかりません」だけだと、同じ old_string で延々と再試行してくる。
      const unescaped = oldString.replaceAll("\\n", "\n");
      const escapedNewlines = unescaped !== oldString && before.includes(unescaped);
      const removedDefinitions = [...definedNames(oldString)].filter((name) => !definedNames(newString).has(name));
      const looksLikeRegex = /\\[dws.+*?]|\[\^?.+\]|\.\*|\\\./.test(oldString);
      const near = nearestLines(before, oldString);
      throw new Error(
        [
          `old_string がファイル内に見つかりません。`,
          ...(escapedNewlines ? [
            `old_string の \\n が実際の改行ではなく、2文字のまま渡されています。JSON では改行を \\n と1回だけエスケープしてください。`,
          ] : []),
          ...(removedDefinitions.length > 0 ? [
            `この置換案では既存の ${removedDefinitions.join("、")} の定義が消えます。新しい関数を追加するだけなら old_string を空文字にし、new_string に新しい関数だけを書いて末尾へ追加してください。`,
          ] : []),
          ...(near.length > 0
            ? ["ファイル内の近い行（実物はこう書かれています。old_string には \"\" の中身をそのまま使えます）:", ...near]
            : []),
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

    const note = await writeChecked(abs, before, after, show(ctx, abs));
    const delta = after.split("\n").length - before.split("\n").length;
    const deltaText = delta === 0 ? "行数は変わりません" : `行数 ${delta > 0 ? "+" : ""}${delta}`;
    return `${show(ctx, abs)} の ${hits} 箇所を置換しました（${deltaText}）。${note ? `\n${note}` : ""}`;
  },
};
