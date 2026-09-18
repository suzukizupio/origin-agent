// 能力テストの課題集。
//
// ここに1件足すだけで、次回から採点対象になる。
// 「/feedback bad で記録した、うまくできなかった質問」をここへ昇格させていくと、
// 使うほど評価セットが育つ。それがこのプロジェクトでの「学習」の現実的な形。

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent, AgentMode } from "../src/types.ts";

export type Turn = {
  text: string;
  /** 送る前にエージェントを作り直す。再起動後も覚えているかを見るために使う */
  restart?: boolean;
};

export type TaskResult = {
  /** 最後のターンの回答 */
  answer: string;
  /** 最後のターンで起きたこと */
  events: AgentEvent[];
  root: string;
  read: (relativePath: string) => Promise<string>;
};

export type Task = {
  id: string;
  title: string;
  mode: AgentMode;
  /** assistant: 記憶と検索判断を通す / agent: ループだけを直接見る */
  via: "assistant" | "agent";
  /** 使わせるツールを名前で絞る。省略時はモードの既定 */
  tools?: string[];
  maxSteps?: number;
  /** ネットに出る課題。--offline で除外する */
  network?: boolean;
  setup?: (root: string) => Promise<void>;
  turns: Turn[];
  check: (result: TaskResult) => Promise<void> | void;
};

const EDIT_TOOLS = ["list_files", "search", "read_file", "edit_json", "edit_file", "replace_lines"];
const READ_TOOLS = ["list_files", "search", "read_file"];

async function put(root: string, relativePath: string, contents: string): Promise<void> {
  const target = join(root, relativePath);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, contents, "utf8");
}

export const tasks: Task[] = [
  {
    id: "port-change",
    title: "設定値を1つだけ変更する",
    mode: "code",
    via: "agent",
    tools: EDIT_TOOLS,
    maxSteps: 6,
    setup: (root) => put(root, "config.json", '{\n  "port": 3000,\n  "name": "practice"\n}\n'),
    turns: [{ text: "config.json の port だけを 3000 から 4000 に変更してください。先にファイルを読み、変更後に読み直して確認してください。" }],
    check: async ({ read }) => {
      assert.deepEqual(JSON.parse(await read("config.json")), { port: 4000, name: "practice" });
    },
  },
  {
    id: "quoted-value",
    title: "引用符つきの文字列を置換する",
    mode: "code",
    via: "agent",
    tools: EDIT_TOOLS,
    maxSteps: 6,
    // 引用符を落として置換に失敗する例が実機で出た弱点。数値より難しい。
    setup: (root) => put(root, "config.json", '{\n  "port": 3000,\n  "name": "practice",\n  "env": "development"\n}\n'),
    turns: [{ text: "config.json の env を development から production に変更してください。他の設定は変えないでください。" }],
    check: async ({ read }) => {
      assert.deepEqual(JSON.parse(await read("config.json")), { port: 3000, name: "practice", env: "production" });
    },
  },
  {
    id: "add-field",
    title: "既存を壊さずに項目を足す",
    mode: "code",
    via: "agent",
    tools: EDIT_TOOLS,
    maxSteps: 6,
    setup: (root) => put(root, "settings.json", '{\n  "theme": "dark"\n}\n'),
    turns: [{ text: 'settings.json に "language": "ja" を追加してください。既存の設定は残してください。' }],
    check: async ({ read }) => {
      assert.deepEqual(JSON.parse(await read("settings.json")), { theme: "dark", language: "ja" });
    },
  },
  {
    id: "find-symbol",
    title: "定義がどのファイルにあるか調べる",
    mode: "code",
    via: "agent",
    tools: READ_TOOLS,
    maxSteps: 6,
    setup: async (root) => {
      await put(root, "src/greeting.ts", "export function greet(name: string): string {\n  return `こんにちは、${name}`;\n}\n");
      await put(root, "src/math.ts", "export function add(a: number, b: number): number {\n  return a + b;\n}\n");
      await put(root, "README.md", "# 練習用\n\ngreet と add があります。\n");
    },
    turns: [{ text: "greet 関数が定義されているのはどのファイルですか。ファイル名だけ答えてください。" }],
    check: ({ answer }) => {
      assert.match(answer, /greeting\.ts/);
      assert.doesNotMatch(answer, /math\.ts/);
    },
  },
  {
    id: "preserve-rest",
    title: "長いファイルの1行だけを変える",
    mode: "code",
    via: "agent",
    tools: EDIT_TOOLS,
    maxSteps: 6,
    setup: (root) =>
      put(
        root,
        "src/limits.ts",
        [
          "// 各種の上限値。",
          "export const MAX_RETRY = 3;",
          "export const TIMEOUT_MS = 20_000;",
          "export const MAX_FILE_BYTES = 1_000_000;",
          "export const MAX_LINE_LENGTH = 200;",
          "export const PREVIEW_LINES = 6;",
          "",
          "export function describe(): string {",
          "  return `retry=${MAX_RETRY} timeout=${TIMEOUT_MS}`;",
          "}",
          "",
        ].join("\n"),
      ),
    turns: [{ text: "src/limits.ts の TIMEOUT_MS を 20_000 から 30_000 に変更してください。他の行は一切変えないでください。" }],
    check: async ({ read }) => {
      const after = (await read("src/limits.ts")).split("\n");
      assert.ok(after.includes("export const TIMEOUT_MS = 30_000;"), "TIMEOUT_MS が変わっていること");
      // 巻き添えがないこと。ここが write_file による全文書き換え事故を捕まえる。
      for (const kept of [
        "export const MAX_RETRY = 3;",
        "export const MAX_FILE_BYTES = 1_000_000;",
        "export const MAX_LINE_LENGTH = 200;",
        "export const PREVIEW_LINES = 6;",
        "export function describe(): string {",
      ]) {
        assert.ok(after.includes(kept), `無関係な行が残っていること: ${kept}`);
      }
    },
  },
  {
    id: "json-flag",
    title: "真偽値を変更し、隣の入れ子の設定を残す",
    mode: "code",
    via: "agent",
    tools: EDIT_TOOLS,
    maxSteps: 6,
    setup: (root) => put(root, "feature.json", '{\n  "enabled": false,\n  "service": {"name": "demo", "retries": 2}\n}\n'),
    turns: [{ text: "feature.json の enabled を true にしてください。service の設定はそのまま残してください。" }],
    check: async ({ read }) => {
      assert.deepEqual(JSON.parse(await read("feature.json")), { enabled: true, service: { name: "demo", retries: 2 } });
    },
  },
  {
    id: "json-array",
    title: "配列の項目を追加し、既存の設定を残す",
    mode: "code",
    via: "agent",
    tools: EDIT_TOOLS,
    maxSteps: 6,
    setup: (root) => put(root, "app.json", '{\n  "name": "demo",\n  "cache": {"enabled": true}\n}\n'),
    turns: [{ text: 'app.json に "locales": ["ja", "en"] を追加してください。他の設定は変更しないでください。' }],
    check: async ({ read }) => {
      assert.deepEqual(JSON.parse(await read("app.json")), { name: "demo", cache: { enabled: true }, locales: ["ja", "en"] });
    },
  },
  {
    id: "name-in-session",
    title: "同じ会話の中で名前を覚える",
    mode: "chat",
    via: "assistant",
    maxSteps: 5,
    turns: [{ text: "私の名前はハルです。よろしく。" }, { text: "私の名前は何でしたか？" }],
    check: ({ answer }) => assert.match(answer, /ハル/),
  },
  {
    id: "name-after-restart",
    title: "再起動しても保存した呼び方を読み戻す",
    mode: "chat",
    via: "assistant",
    maxSteps: 5,
    turns: [{ text: "/remember 呼び方 ハル" }, { text: "私の名前は何ですか？", restart: true }],
    check: ({ answer }) => assert.match(answer, /ハル/),
  },
  {
    id: "no-fabricated-name",
    title: "知らない名前を作らない",
    mode: "chat",
    via: "assistant",
    maxSteps: 5,
    turns: [{ text: "私の名前は何ですか？" }],
    check: ({ answer }) => {
      assert.match(answer, /分かりません|わかりません/);
      assert.doesNotMatch(answer, /ハル|太郎/);
    },
  },
  {
    id: "location-search",
    title: "地名を自動で検索して所在地と出典を答える",
    mode: "chat",
    via: "assistant",
    maxSteps: 5,
    network: true,
    turns: [{ text: "つくばみらい市ってどこですか？" }],
    check: ({ answer, events }) => {
      assert.ok(
        events.some((e) => e.type === "tool_end" && e.name === "web_search" && e.ok),
        "web_search が成功していること",
      );
      assert.match(answer, /茨城/);
      assert.doesNotMatch(answer, /東北/);
      assert.match(answer, /https?:\/\//);
    },
  },
  {
    id: "location-paraphrase",
    title: "言い換えた地名の質問でも、記憶で答えず検索する",
    mode: "chat",
    via: "assistant",
    maxSteps: 5,
    network: true,
    // 採点課題の「どこですか？」は通るのに、この言い方では検索せず「広島県」と捏造した実例がある
    turns: [{ text: "つくばみらい市ってどんな場所？" }],
    check: ({ answer, events }) => {
      assert.ok(
        events.some((e) => e.type === "tool_end" && e.name === "web_search" && e.ok),
        "web_search が成功していること",
      );
      assert.match(answer, /茨城/);
      assert.doesNotMatch(answer, /広島|東北/);
      assert.match(answer, /https?:\/\//);
    },
  },
  {
    id: "location-in-code-mode",
    title: "コードモードでも、コードと関係ない事実は検索する",
    mode: "code",
    via: "assistant",
    maxSteps: 5,
    network: true,
    // スクリーンショットで「広島県」と捏造したときのモードは code だった
    turns: [{ text: "つくばみらい市ってどんな場所？" }],
    check: ({ answer, events }) => {
      assert.ok(
        events.some((e) => e.type === "tool_end" && e.name === "web_search" && e.ok),
        "web_search が成功していること",
      );
      assert.match(answer, /茨城/);
      assert.doesNotMatch(answer, /広島|東北/);
    },
  },
  {
    id: "explicit-search",
    title: "明示された検索語で調べ、出典を示す",
    mode: "chat",
    via: "assistant",
    maxSteps: 5,
    network: true,
    turns: [{ text: "/search TypeScript 公式サイト" }],
    check: ({ answer }) => assert.match(answer, /https?:\/\//),
  },
];
