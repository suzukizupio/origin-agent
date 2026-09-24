// 能力テストの課題集。
//
// ここに1件足すだけで、次回から採点対象になる。
// 「/feedback bad で記録した、うまくできなかった質問」をここへ昇格させていくと、
// 使うほど評価セットが育つ。それがこのプロジェクトでの「学習」の現実的な形。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
  /** 日常会話だけを、ファイル操作やWeb検索なしで測る評価セット */
  suite?: "daily";
  /** assistant: 記憶と検索判断を通す / agent: ループだけを直接見る */
  via: "assistant" | "agent";
  /** 使わせるツールを名前で絞る。省略時はモードの既定 */
  tools?: string[];
  maxSteps?: number;
  /** ネットに出る課題。--offline で除外する */
  network?: boolean;
  /**
   * 骨格を直している間は見ない課題。--holdout のときだけ走らせる。
   * tune だけを見て直すと、採点の文面を覚えただけの改善になりやすい。
   */
  holdout?: boolean;
  setup?: (root: string) => Promise<void>;
  turns: Turn[];
  check: (result: TaskResult) => Promise<void> | void;
};

const EDIT_TOOLS = ["list_files", "search", "read_file", "edit_json", "edit_file", "replace_lines"];
const READ_TOOLS = ["list_files", "search", "read_file"];
const CODE_TOOLS = [...EDIT_TOOLS, "run_shell"];

async function put(root: string, relativePath: string, contents: string): Promise<void> {
  const target = join(root, relativePath);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, contents, "utf8");
}

const PACKAGE_JSON = '{\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n';

/** 作業ルートでテストを走らせる。採点側が自分で確かめ、モデルの「通りました」は信じない */
function runTests(root: string): { ok: boolean; output: string } {
  const result = spawnSync(process.execPath, ["--test"], { cwd: root, encoding: "utf8", timeout: 60_000, windowsHide: true });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** 編集後のモジュールを読み込む。構文を壊していればここで落ちる */
async function load(root: string, relativePath: string): Promise<Record<string, unknown>> {
  return await import(pathToFileURL(join(root, relativePath)).href) as Record<string, unknown>;
}

function fn(module: Record<string, unknown>, name: string): (...args: unknown[]) => unknown {
  const value = module[name];
  assert.equal(typeof value, "function", `${name} が export された関数であること`);
  return value as (...args: unknown[]) => unknown;
}

/** 落ちるテストを直す課題の共通の採点。テストファイルを書き換えて通すのは不正解 */
async function checkFixedTests(result: TaskResult, testPath: string, testSource: string): Promise<void> {
  assert.equal(await result.read(testPath), testSource, "テストファイルを変更していないこと");
  const run = runTests(result.root);
  assert.ok(run.ok, `テストが通ること:\n${run.output.slice(-400)}`);
}

// ここから下の「コードを直す」課題は v0.7 で追加した。設定値の変更より一段むずかしい、
// 実際のコーディングに近い作業（テストを走らせる・原因を探す・関数を足す）を見る。
// holdout の3件は tune の3件と同じ種類で、ファイル・関数・言い回しだけを変えてある。

const CART_TEST = [
  'import { test } from "node:test";',
  'import assert from "node:assert/strict";',
  'import { total } from "../src/cart.js";',
  "",
  'test("合計金額", () => {',
  "  assert.equal(total([{ price: 100, qty: 2 }, { price: 50, qty: 1 }]), 250);",
  "});",
  "",
  'test("空のカートは0円", () => {',
  "  assert.equal(total([]), 0);",
  "});",
  "",
].join("\n");

const STATS_TEST = [
  'import { test } from "node:test";',
  'import assert from "node:assert/strict";',
  'import { average, max } from "../src/stats.js";',
  "",
  'test("平均", () => {',
  "  assert.equal(average([2, 4, 6]), 4);",
  "  assert.equal(average([]), 0);",
  "});",
  "",
  'test("最大値", () => {',
  "  assert.equal(max([1, 5, 3]), 5);",
  "});",
  "",
].join("\n");

const codeTasks: Task[] = [
  {
    id: "fix-failing-test",
    title: "落ちているテストを走らせ、原因のコードを直す",
    mode: "code",
    via: "agent",
    tools: CODE_TOOLS,
    maxSteps: 10,
    setup: async (root) => {
      await put(root, "package.json", PACKAGE_JSON);
      await put(root, "src/cart.js", [
        "export function total(items) {",
        "  let sum = 0;",
        "  for (let i = 1; i < items.length; i++) {",
        "    sum += items[i].price * items[i].qty;",
        "  }",
        "  return sum;",
        "}",
        "",
      ].join("\n"));
      await put(root, "test/cart.test.js", CART_TEST);
    },
    turns: [{ text: "npm test が失敗しています。原因を調べて src のコードを直し、テストが通ることを確認してください。テストファイルは変更しないでください。" }],
    check: async (result) => {
      await checkFixedTests(result, "test/cart.test.js", CART_TEST);
      const total = fn(await load(result.root, "src/cart.js"), "total");
      // テストに合わせて値を埋め込んだだけの修正を見分ける
      assert.equal(total([{ price: 10, qty: 3 }]), 30, "テスト以外の入力でも正しいこと");
    },
  },
  {
    id: "fix-described-bug",
    title: "説明されたバグを直し、隣の関数を残す",
    mode: "code",
    via: "agent",
    tools: CODE_TOOLS,
    maxSteps: 8,
    setup: async (root) => {
      await put(root, "package.json", PACKAGE_JSON);
      await put(root, "src/age.js", [
        "export function isAdult(age) {",
        "  return age > 18;",
        "}",
        "",
        "export function ageGroup(age) {",
        '  if (age < 13) return "child";',
        '  if (age < 20) return "teen";',
        '  return "adult";',
        "}",
        "",
      ].join("\n"));
    },
    turns: [{ text: "src/age.js の isAdult(18) が false になります。18歳以上なら true を返すように直してください。" }],
    check: async ({ root }) => {
      const module = await load(root, "src/age.js");
      const isAdult = fn(module, "isAdult");
      const ageGroup = fn(module, "ageGroup");
      assert.equal(isAdult(18), true, "isAdult(18) が true");
      assert.equal(isAdult(17), false, "isAdult(17) が false");
      assert.equal(isAdult(40), true, "isAdult(40) が true");
      assert.deepEqual([ageGroup(10), ageGroup(15), ageGroup(30)], ["child", "teen", "adult"], "ageGroup が変わっていないこと");
    },
  },
  {
    id: "add-function",
    title: "既存の関数を残して、新しい関数を足す",
    mode: "code",
    via: "agent",
    tools: CODE_TOOLS,
    maxSteps: 8,
    setup: async (root) => {
      await put(root, "package.json", PACKAGE_JSON);
      await put(root, "src/math.js", [
        "export function add(a, b) {",
        "  return a + b;",
        "}",
        "",
        "export function subtract(a, b) {",
        "  return a - b;",
        "}",
        "",
      ].join("\n"));
    },
    turns: [{ text: "src/math.js に、2つの数の積を返す multiply(a, b) を追加して export してください。既存の関数はそのまま残してください。" }],
    check: async ({ root }) => {
      const module = await load(root, "src/math.js");
      assert.equal(fn(module, "multiply")(3, 4), 12);
      assert.equal(fn(module, "multiply")(-2, 5), -10);
      assert.equal(fn(module, "add")(1, 2), 3, "add が残っていること");
      assert.equal(fn(module, "subtract")(5, 2), 3, "subtract が残っていること");
    },
  },
  {
    id: "holdout-fix-failing-test",
    title: "（holdout）落ちているテストの原因を直す",
    mode: "code",
    via: "agent",
    tools: CODE_TOOLS,
    maxSteps: 10,
    holdout: true,
    setup: async (root) => {
      await put(root, "package.json", PACKAGE_JSON);
      await put(root, "src/stats.js", [
        "export function average(values) {",
        "  if (values.length === 0) return 0;",
        "  let sum = 0;",
        "  for (const value of values) sum += value;",
        "  return sum / (values.length + 1);",
        "}",
        "",
        "export function max(values) {",
        "  return Math.max(...values);",
        "}",
        "",
      ].join("\n"));
      await put(root, "test/stats.test.js", STATS_TEST);
    },
    turns: [{ text: "テストを実行すると失敗します。原因を見つけて直してください。テストのファイルは書き換えないでください。" }],
    check: async (result) => {
      await checkFixedTests(result, "test/stats.test.js", STATS_TEST);
      assert.equal(fn(await load(result.root, "src/stats.js"), "average")([10]), 10, "テスト以外の入力でも正しいこと");
    },
  },
  {
    id: "holdout-fix-described-bug",
    title: "（holdout）説明されたバグを直し、隣の関数を残す",
    mode: "code",
    via: "agent",
    tools: CODE_TOOLS,
    maxSteps: 8,
    holdout: true,
    setup: async (root) => {
      await put(root, "package.json", PACKAGE_JSON);
      await put(root, "src/list.js", [
        "export function isEmpty(list) {",
        "  return list.length > 0;",
        "}",
        "",
        "export function first(list) {",
        "  return list[0];",
        "}",
        "",
      ].join("\n"));
    },
    turns: [{ text: "src/list.js の isEmpty が逆の結果を返しています。空の配列のときだけ true を返すように修正してください。" }],
    check: async ({ root }) => {
      const module = await load(root, "src/list.js");
      assert.equal(fn(module, "isEmpty")([]), true);
      assert.equal(fn(module, "isEmpty")([1]), false);
      assert.equal(fn(module, "first")([7, 8]), 7, "first が変わっていないこと");
    },
  },
  {
    id: "holdout-add-function",
    title: "（holdout）既存の関数を残して、新しい関数を足す",
    mode: "code",
    via: "agent",
    tools: CODE_TOOLS,
    maxSteps: 8,
    holdout: true,
    setup: async (root) => {
      await put(root, "package.json", PACKAGE_JSON);
      await put(root, "src/strings.js", [
        "export function upper(text) {",
        "  return text.toUpperCase();",
        "}",
        "",
      ].join("\n"));
    },
    turns: [{ text: "src/strings.js に、文字列を逆順にして返す reverse(text) 関数を追加してください。upper は残してください。" }],
    check: async ({ root }) => {
      const module = await load(root, "src/strings.js");
      assert.equal(fn(module, "reverse")("abc"), "cba");
      assert.equal(fn(module, "upper")("a"), "A", "upper が残っていること");
    },
  },
];

/** 日常会話の小さな回帰課題。合格はこの条件だけの確認で、意味全体の採点ではない。 */
const dailyTasks: Task[] = [
  {
    id: "daily-rewrite", title: "直前の回答を内容を保って短く整える", mode: "chat", via: "assistant", suite: "daily", tools: [], maxSteps: 1,
    turns: [
      { text: "連絡文を作ってください。読書会は金曜日の14時、図書室で開催します。持ち物は本です。これ以外の情報は足さないでください。" },
      { text: "それを2行でまとめて" },
    ],
    check: ({ answer }) => {
      assert.equal(answer.trim().split(/\r?\n/).filter((line) => line.trim()).length, 2);
      assert.ok(answer.length <= 140);
      for (const pattern of [/金曜/, /14時/, /図書室/, /本/]) assert.match(answer.normalize("NFKC"), pattern);
    },
  },
  {
    id: "daily-followup", title: "前の発話にある候補を参照する", mode: "chat", via: "assistant", suite: "daily", tools: [], maxSteps: 1,
    turns: [
      { text: "勉強の候補Aは朝に読書10分、候補Bは夜に復習20分です。まず内容を確認してください。" },
      { text: "そのうち20分のものについて、候補名と何をするかを一文で答えてください。" },
    ],
    check: ({ answer }) => {
      assert.match(answer.normalize("NFKC"), /候補B/);
      assert.match(answer, /復習/);
      assert.doesNotMatch(answer.normalize("NFKC"), /候補A/);
    },
  },
  {
    id: "daily-update", title: "変更された条件を優先する", mode: "chat", via: "assistant", suite: "daily", tools: [], maxSteps: 1,
    turns: [
      { text: "私が本を買う予算は5000円です。今は確認だけしてください。" },
      { text: "予算を2000円に変更します。" },
      { text: "今の予算はいくらですか？金額だけ答えてください。" },
    ],
    check: ({ answer }) => assert.match(answer.normalize("NFKC").replace(/[\s,、。]/g, ""), /^2000円$/),
  },
  {
    id: "daily-correction", title: "ユーザーの訂正を反映する", mode: "chat", via: "assistant", suite: "daily", tools: [], maxSteps: 1,
    turns: [
      { text: "私の打ち合わせは水曜日です。まず確認だけしてください。" },
      { text: "訂正します。打ち合わせは木曜日でした。" },
      { text: "私の打ち合わせは何曜日ですか？曜日だけ答えてください。" },
    ],
    check: ({ answer }) => assert.match(answer.replace(/[\s。]/g, ""), /^木曜(?:日)?$/),
  },
  {
    id: "daily-summary", title: "渡した文章を指定の長さで要約する", mode: "chat", via: "assistant", suite: "daily", tools: [], maxSteps: 1,
    turns: [{ text: "次の連絡文を、日時・場所と持ち物の2点に分けて、2行の箇条書きだけで短くまとめてください。\n連絡文：勉強会は水曜日の10時に会議室Aで行います。持ち物はノートです。会場では参加者同士が交流する予定です。" }],
    check: ({ answer }) => {
      const lines = answer.trim().split(/\r?\n/).filter((line) => line.trim());
      assert.equal(lines.length, 2, "2行でまとめること");
      assert.ok(lines.every((line) => /^\s*(?:[-*・]|\d+[.)、])\s*/.test(line)), "箇条書きであること");
      assert.ok(answer.length <= 140, "短くまとめること");
      for (const pattern of [/水曜/, /10時/, /会議室A/, /ノート/]) assert.match(answer.normalize("NFKC"), pattern);
    },
  },
  {
    id: "daily-missing-info", title: "資料にない情報を作らない", mode: "chat", via: "assistant", suite: "daily", tools: [], maxSteps: 1,
    turns: [{ text: "次のメモだけを根拠に、勉強会の責任者の氏名を答えてください。氏名が書かれていなければ『記載なし』だけと答えてください。\nメモ：勉強会は木曜日、会議室Cで開催します。" }],
    check: ({ answer }) => assert.match(answer.replace(/[\s。「」『』]/g, ""), /^記載なし$/),
  },
  {
    id: "daily-clarify", title: "対象が不明なら推測せず確認する", mode: "chat", via: "assistant", suite: "daily", tools: [], maxSteps: 1,
    turns: [{ text: "それを比較してください。" }],
    check: ({ answer }) => {
      assert.match(answer, /何|どの|どれ|対象|比較するもの/);
      assert.match(answer, /[?？]|教えて|知らせて|示して|提示|指定|分かりません|わかりません|不明/);
      assert.ok(answer.length <= 200, "比較を捏造せず短く確認すること");
    },
  },
];

export const tasks: Task[] = [
  ...dailyTasks,
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
  ...codeTasks,
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
