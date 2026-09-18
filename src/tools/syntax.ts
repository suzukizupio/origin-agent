// 編集で JavaScript を壊していないかを確かめる関門。
//
// 実測: 関数を足してと頼まれた 3B は、末尾への追加を何度も繰り返して
//   Identifier 'multiply' has already been declared / Duplicate export of 'multiply'
// の状態でファイルを残し、「完了しました」と報告した（3回中2回）。
// 確認プロンプトは --yolo で飛ぶが、この関門はツールの中にあるので飛ばない。
//
// 対象は .js / .mjs / .cjs だけ。node --check は TypeScript の型注釈を構文エラーとして扱うため、
// .ts に使うと正しいファイルまで「壊れた」と判定してしまう。

import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { extname } from "node:path";

const CHECKABLE = new Set([".js", ".mjs", ".cjs"]);

/** 構文エラーの内容（行番号つき）。確かめられないファイルや、問題がなければ undefined */
export function syntaxError(abs: string): string | undefined {
  if (!CHECKABLE.has(extname(abs).toLowerCase())) return undefined;
  const result = spawnSync(process.execPath, ["--check", abs], { encoding: "utf8", timeout: 10_000, windowsHide: true });
  // node を起動できない・時間切れのときは判定できない。編集自体は止めない
  if (result.error || result.status === 0) return undefined;
  const text = result.stderr ?? "";
  const line = text.match(/:(\d+)\r?\n/)?.[1];
  const message = text.match(/SyntaxError: [^\r\n]+/)?.[0] ?? text.trim().split(/\r?\n/).at(-1) ?? "構文エラー";
  return line ? `${line} 行目 ${message}` : message;
}

/**
 * 書き込んでから構文を確かめる。元は正しかったファイルを壊したなら、元に戻して失敗にする。
 * 元から壊れていたファイル（構文エラーを直す途中など）は戻さず、残っているエラーを返す。
 * 問題がなければ undefined。
 */
export async function writeChecked(abs: string, before: string | null, after: string, shown: string): Promise<string | undefined> {
  await writeFile(abs, after, "utf8");
  const error = syntaxError(abs);
  if (error === undefined) return undefined;
  if (before === null) return `書き込んだ ${shown} に構文エラーがあります: ${error}`;

  await writeFile(abs, before, "utf8");
  if (syntaxError(abs) !== undefined) {
    await writeFile(abs, after, "utf8");
    return `編集前から構文エラーがあり、編集後も残っています: ${error}`;
  }
  const duplicate = error.match(/Identifier '([\w$]+)' has already been declared|Duplicate export of '([\w$]+)'/);
  const name = duplicate?.[1] ?? duplicate?.[2];
  const existing = name === undefined ? [] : definitionLines(before, name);
  throw new Error(
    [
      `この編集で ${shown} が JavaScript として読めなくなったため（${error}）、編集を取り消して元に戻しました。`,
      ...(existing.length > 0
        // 実測: export なしで足した関数に export を付けたくて、export 付きの同じ関数を足し直し続けた
        ? [`${name} はすでにファイル内にあります。足し直さず、今ある行を old_string にして置き換えてください:`, ...existing]
        : ["read_file で今の内容を確かめてから、構文が正しくなるように編集してください。"]),
    ].join("\n"),
  );
}

/** name を定義・export している行（行番号つき、JSON 文字列の形） */
function definitionLines(text: string, name: string): string[] {
  const escaped = name.replace(/[$]/g, "\\$");
  const pattern = new RegExp(`\\b(?:function\\s*\\*?\\s*|class\\s+|const\\s+|let\\s+|var\\s+)${escaped}\\b|export\\s*\\{[^}]*\\b${escaped}\\b`);
  return text.split("\n")
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => pattern.test(line))
    .slice(0, 3)
    .map(({ line, number }) => `  ${number} 行目: ${JSON.stringify(line)}`);
}
