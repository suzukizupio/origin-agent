import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** 検索・一覧で常に無視するディレクトリ。ここを歩くとトークンも時間も溶ける */
export const IGNORED = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  "vendor",
  "__pycache__",
  ".venv",
  "target",
]);

export type Entry = { abs: string; name: string; isDir: boolean; depth: number };

/** ディレクトリを再帰的に歩く。list_files と search が共有する */
export async function* walkEntries(
  start: string,
  opts: { maxDepth?: number; limit?: number } = {},
): AsyncGenerator<Entry> {
  const maxDepth = opts.maxDepth ?? 10;
  const limit = opts.limit ?? 5000;
  let count = 0;

  async function* step(dir: string, depth: number): AsyncGenerator<Entry> {
    if (depth > maxDepth || count >= limit) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // 読めないディレクトリは黙って飛ばす
    }

    for (const entry of entries) {
      if (count >= limit) return;
      if (entry.name.startsWith(".") || IGNORED.has(entry.name)) continue;

      const abs = join(dir, entry.name);
      const isDir = entry.isDirectory();
      count++;
      yield { abs, name: entry.name, isDir, depth };
      if (isDir) yield* step(abs, depth + 1);
    }
  }

  yield* step(start, 1);
}
