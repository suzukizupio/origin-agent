import { resolve, relative, isAbsolute } from "node:path";
import type { ToolContext } from "../types.ts";

/**
 * root の外に出ようとするパスを弾く。
 * エージェントにパス文字列を自由に書かせる以上、ここが唯一の防壁になる。
 */
export function safePath(ctx: ToolContext, input: unknown, label = "path"): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error(`${label} は必須の文字列です`);
  }
  const abs = resolve(ctx.root, input);
  const rel = relative(ctx.root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`作業ルートの外は触れません: ${input}`);
  }
  return abs;
}

/** 絶対パスを、頭脳に見せる用の相対パスに直す */
export function show(ctx: ToolContext, abs: string): string {
  return relative(ctx.root, abs).replaceAll("\\", "/") || ".";
}

/** `*.ts` や `*.{ts,tsx}` 程度の簡易グロブを正規表現に直す */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  let braceDepth = 0;
  for (const ch of glob) {
    if (ch === "*") out += "[^/\\\\]*";
    else if (ch === "?") out += "[^/\\\\]";
    else if (ch === "{") {
      out += "(";
      braceDepth++;
    } else if (ch === "}" && braceDepth > 0) {
      out += ")";
      braceDepth--;
    } else if (ch === "," && braceDepth > 0) out += "|";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "i");
}
