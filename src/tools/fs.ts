import { readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { safePath, show } from "./paths.ts";
import { walkEntries } from "./walk.ts";
import { writeChecked } from "./syntax.ts";
import type { Tool, ToolContext } from "../types.ts";

const MAX_READ_BYTES = 200_000;

/**
 * ファイルを読む。存在しないときのメッセージは、頭脳にとっては次の一手の指示になる。
 * 「ありません」で終えると小さいモデルは諦めてユーザーに丸投げするので、
 * 何をすれば回復できるかまで書く。
 */
export async function readTextFile(ctx: ToolContext, abs: string): Promise<string> {
  try {
    return await readFile(abs, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `ファイルがありません: ${show(ctx, abs)} — パスを推測せず、` +
          `list_files か search で実在するパスを確かめてから呼び直してください。`,
      );
    }
    throw e;
  }
}

export const readFileTool: Tool = {
  name: "read_file",
  description: "ファイルの内容を行番号つきで読む",
  params: [{ name: "path", type: "string", required: true, description: "作業ルートからの相対パス" }],
  async run(args, ctx) {
    const abs = safePath(ctx, args.path);
    const raw = await readTextFile(ctx, abs);
    const truncated = raw.length > MAX_READ_BYTES;
    const body = truncated ? raw.slice(0, MAX_READ_BYTES) : raw;
    const numbered = body
      .split("\n")
      .map((line, i) => `${String(i + 1).padStart(5)}\t${line}`)
      .join("\n");
    return truncated ? `${numbered}\n\n… 長すぎるため途中で打ち切りました` : numbered;
  },
};

export const listFilesTool: Tool = {
  name: "list_files",
  description: "ディレクトリのファイル一覧を再帰的に取得する",
  params: [
    { name: "path", type: "string", required: false, description: "起点。省略時は作業ルート" },
    { name: "depth", type: "number", required: false, description: "潜る深さ。既定は 3" },
  ],
  async run(args, ctx) {
    const start = args.path === undefined ? ctx.root : safePath(ctx, args.path);
    const maxDepth = typeof args.depth === "number" ? args.depth : 3;

    const found: string[] = [];
    for await (const entry of walkEntries(start, { maxDepth, limit: 500 })) {
      found.push(entry.isDir ? `${show(ctx, entry.abs)}/` : show(ctx, entry.abs));
    }

    if (found.length === 0) return "(ファイルなし)";
    return found.sort().join("\n");
  },
};

export const writeFileTool: Tool = {
  name: "write_file",
  description:
    "新しいファイルを作る。既存ファイルの一部を直すなら edit_file か replace_lines を使うこと。" +
    "既存ファイルを全文書き換えるには overwrite を true にする必要がある",
  destructive: true,
  params: [
    { name: "path", type: "string", required: true, description: "作業ルートからの相対パス" },
    { name: "content", type: "string", required: true, description: "書き込む内容の全文" },
    {
      name: "overwrite",
      type: "boolean",
      required: false,
      description: "既存ファイルを全文置き換えることを承知している場合のみ true にする",
    },
  ],
  async run(args, ctx) {
    const abs = safePath(ctx, args.path);
    if (typeof args.content !== "string") {
      throw new Error("content は必須の文字列です");
    }

    let existing: string | null = null;
    try {
      existing = await readFile(abs, "utf8");
    } catch {
      existing = null;
    }

    // 弱いモデルは「一部を直す」つもりで全文を書き直し、覚えていない部分を消し飛ばす。
    // 実際に 79 行のファイルが捏造された 3 行に置き換わる事故が起きた。
    // 確認プロンプトは --yolo で飛ぶが、この関門はモデルに向いているので飛ばない。
    if (existing !== null && args.overwrite !== true) {
      const lineCount = existing.split("\n").length;
      throw new Error(
        [
          `${show(ctx, abs)} はすでに存在します（${lineCount} 行）。既存ファイルを壊さないため、write_file は既定で上書きしません。`,
          `一部を直したいなら edit_file（文字列置換）か replace_lines（行番号指定）を使ってください。`,
          `${lineCount} 行すべてを本当に捨てて書き直す場合だけ、overwrite に true を指定してください。`,
        ].join("\n"),
      );
    }

    const verb =
      existing === null
        ? "新規作成"
        : `全文を上書き (現在 ${existing.split("\n").length} 行 → ${args.content.split("\n").length} 行)`;
    const ok = await ctx.confirm(`${show(ctx, abs)} を${verb}します。よろしいですか？`);
    if (!ok) return "ユーザーが書き込みを拒否しました。";

    await mkdir(dirname(abs), { recursive: true });
    const note = await writeChecked(abs, existing, args.content, show(ctx, abs));
    return `${show(ctx, abs)} に ${args.content.split("\n").length} 行を書き込みました。${note ? `\n${note}` : ""}`;
  },
};
