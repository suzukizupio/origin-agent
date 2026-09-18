import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentMode } from "./types.ts";

export type Memory = { key: string; value: string; updatedAt: string };
export type Feedback = {
  id: string; question: string; answer: string; rating: "good" | "bad";
  note: string; provider: string; mode: AgentMode; createdAt: string;
};
type State = { version: 1; memories: Memory[]; feedback: Feedback[] };

export function memoryKey(key: string): string {
  const trimmed = key.trim();
  return /^(名前|呼び名|呼び方|ニックネーム|name|nickname)$/i.test(trimmed) ? "呼び方" : trimmed;
}

function tokens(text: string): Set<string> {
  const cleaned = text.toLowerCase().replace(/教えて|ください|について|説明して|とは|ですか|でしたか|何ですか|もっと/g, "");
  const pieces = cleaned.match(/[a-z0-9_]{2,}|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) ?? [];
  return new Set(pieces.flatMap((piece) => /^[a-z0-9_]+$/.test(piece)
    ? [piece]
    : Array.from({ length: Math.max(0, piece.length - 1) }, (_, i) => piece.slice(i, i + 2))));
}

export function relevance(left: string, right: string): number {
  if (left.trim() === right.trim()) return 1;
  const a = tokens(left);
  const b = tokens(right);
  const common = [...a].filter((token) => b.has(token));
  return common.length / Math.max(1, Math.max(a.size, b.size));
}

function textField(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

function isState(value: unknown): value is State {
  if (!value || typeof value !== "object") return false;
  const s = value as State;
  return s.version === 1 && Array.isArray(s.memories) && s.memories.length <= 50
    && s.memories.every((m) => m && textField(m.key, 60) && !!m.key.trim() && textField(m.value, 500) && !!m.value.trim() && textField(m.updatedAt, 40))
    && new Set(s.memories.map((m) => m.key)).size === s.memories.length
    && Array.isArray(s.feedback) && s.feedback.length <= 200
    && s.feedback.every((f) => f && textField(f.id, 50) && textField(f.question, 2000)
      && textField(f.answer, 8000) && textField(f.note, 1000) && textField(f.provider, 200)
      && textField(f.createdAt, 40) && ["good", "bad"].includes(f.rating) && ["chat", "code"].includes(f.mode));
}

/** 明示された記憶と感想だけをローカル保存する。モデルに書き込みの権限は渡さない。 */
export class LearningStore {
  readonly directory: string;
  constructor(directory: string) { this.directory = resolve(directory); }

  async read(): Promise<State> {
    const file = join(this.directory, "learning.json");
    let raw: string;
    try { raw = await readFile(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, memories: [], feedback: [] };
      throw error;
    }
    try {
      if (raw.length > 3_000_000) throw new Error("too large");
      const data: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
      if (!isState(data)) throw new Error("invalid data");
      return data;
    } catch {
      throw new Error(`記憶ファイルを読み取れません。既存データは上書きしていません: ${file}`);
    }
  }

  private async update<T>(change: (state: State) => T): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    const lockPath = join(this.directory, "learning.lock");
    let lock;
    for (let attempt = 0; !lock; attempt++) {
      try { lock = await open(lockPath, "wx"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (attempt >= 30) throw new Error(`記憶ファイルが使用中です。別のoriginを終了して再試行してください: ${lockPath}`);
        await delay(50);
      }
    }
    const temp = join(this.directory, `learning-${randomUUID()}.tmp`);
    try {
      const state = await this.read();
      const result = change(state);
      await writeAtomicTemp(temp, JSON.stringify(state, null, 2) + "\n");
      await rename(temp, join(this.directory, "learning.json"));
      return result;
    } finally {
      try { await rm(temp, { force: true }); }
      finally { await lock.close(); await rm(lockPath, { force: true }); }
    }
  }

  async remember(rawKey: string, rawValue: string): Promise<Memory> {
    const key = memoryKey(rawKey);
    const value = rawValue.trim();
    if (!key || key.length > 60 || !value || value.length > 500) throw new Error("記憶の項目は1〜60文字、内容は1〜500文字で指定してください。");
    return this.update((state) => {
      const index = state.memories.findIndex((m) => m.key === key);
      if (index < 0 && state.memories.length >= 50) throw new Error("記憶は50件までです。/forget で不要な記憶を削除してください。");
      const entry = { key, value, updatedAt: new Date().toISOString() };
      if (index >= 0) {
        const previous = state.memories[index]!;
        if (previous.value !== value) state.feedback = state.feedback.filter((f) => !`${f.question}\n${f.answer}\n${f.note}`.includes(previous.value));
        state.memories[index] = entry;
      } else state.memories.push(entry);
      return entry;
    });
  }

  async forget(rawKey: string): Promise<boolean> {
    const key = memoryKey(rawKey);
    return this.update((state) => {
      const entry = state.memories.find((m) => m.key === key);
      if (!entry) return false;
      state.memories = state.memories.filter((m) => m.key !== key);
      // 削除した内容を過去の回答経由で再注入しない。
      state.feedback = state.feedback.filter((f) => !`${f.question}\n${f.answer}\n${f.note}`.includes(entry.value));
      return true;
    });
  }

  async addFeedback(input: Omit<Feedback, "id" | "createdAt">): Promise<Feedback> {
    if (!input.question.trim() || !input.answer.trim()) throw new Error("記録する回答がありません。");
    if (input.note.length > 1000 || (input.rating === "bad" && !input.note.trim())) throw new Error("改善点を1〜1000文字で指定してください。");
    return this.update((state) => {
      if (state.feedback.length >= 200) throw new Error("感想は200件までです。/feedback delete <ID> で不要な記録を削除してください。");
      const entry: Feedback = {
        ...input, question: input.question.slice(0, 2000), answer: input.answer.slice(0, 8000),
        note: input.note.trim(), id: randomUUID(), createdAt: new Date().toISOString(),
      };
      state.feedback.push(entry);
      return entry;
    });
  }

  async deleteFeedback(id: string): Promise<boolean> {
    return this.update((state) => {
      const previous = state.feedback.length;
      state.feedback = state.feedback.filter((f) => f.id !== id);
      return previous !== state.feedback.length;
    });
  }

  async context(question: string, mode: AgentMode): Promise<{ text: string; feedbackCount: number }> {
    const state = await this.read();
    const priorities = ["呼び方", "話し方", "目標"];
    const memories = state.memories.filter((m) => priorities.includes(m.key)
      || relevance(question, `${m.key} ${m.value}`) >= 0.2)
      .sort((a, b) => Number(priorities.includes(b.key)) - Number(priorities.includes(a.key))).slice(0, 6);
    const feedback = state.feedback.filter((f) => f.mode === mode && f.note && relevance(question, f.question) >= 0.25)
      .sort((a, b) => relevance(question, b.question) - relevance(question, a.question) || b.createdAt.localeCompare(a.createdAt)).slice(0, 3);
    return {
      text: [
        ...memories.map(({ key, value }) => `保存した${key}: ${JSON.stringify(value)}`),
        ...feedback.map(({ question: previousQuestion, rating, note }) => `以前の質問 ${JSON.stringify(previousQuestion)} への${rating === "bad" ? "改善の希望" : "よかった点"}: ${JSON.stringify(note)}`),
      ].join("\n"),
      feedbackCount: feedback.length,
    };
  }
}

async function writeAtomicTemp(file: string, contents: string): Promise<void> {
  const handle = await open(file, "wx");
  try { await handle.writeFile(contents, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
}
