// 機械学習を一切使わない「頭脳」。
//
// 正規表現で意図を当てて、ツール呼び出しを組み立てるだけ。当然ものすごく馬鹿だが、
// エージェントのループ・ツール実行・権限確認・結果の戻しが本当に動くことを、
// モデルもAPIキーもネットワークも無しに証明できる。ここが全ての土台になる。

import { formatToolCall } from "../protocol.ts";
import type { Provider, Tool } from "../types.ts";

type Rule = {
  pattern: RegExp;
  build: (m: RegExpMatchArray) => string;
};

const RULES: Rule[] = [
  {
    pattern: /^(?:web|ネット検索)\s+(.+)$/i,
    build: (m) => formatToolCall("web_search", { query: m[1] ?? "" }),
  },
  {
    // 「ls」「一覧」「src を一覧」
    pattern: /^(?:ls|list|一覧|ファイル一覧)\s*(?:\s(.+?))?\s*(?:を?一覧)?$/i,
    build: (m) => formatToolCall("list_files", { path: m[1]?.trim() || "." }),
  },
  {
    // 「read src/cli.ts」「cat package.json」
    pattern: /^(?:cat|read|open|読んで|読む|開いて|見せて)\s+(.+)$/i,
    build: (m) => formatToolCall("read_file", { path: (m[1] ?? "").trim() }),
  },
  {
    // 「package.json を読んで」— 日本語の語順
    pattern: /^(.+?)\s*を\s*(?:読んで|読む|開いて|見せて)\s*$/,
    build: (m) => formatToolCall("read_file", { path: (m[1] ?? "").trim() }),
  },
  {
    // 「search Provider」「grep createAgent *.ts」「Provider を検索」
    pattern: /^(?:search|grep|検索)\s+(\S+)(?:\s+(\S+))?$/i,
    build: (m) =>
      formatToolCall(
        "search",
        m[2] === undefined ? { pattern: m[1] ?? "" } : { pattern: m[1] ?? "", glob: m[2] },
      ),
  },
  {
    pattern: /^(.+?)\s*を\s*(?:検索|探して)\s*$/,
    build: (m) => formatToolCall("search", { pattern: (m[1] ?? "").trim() }),
  },
  {
    // 「fetch https://…」「https://… を取得」
    pattern: /^(?:fetch|get|取得)\s+(https?:\/\/\S+)$/i,
    build: (m) => formatToolCall("web_fetch", { url: m[1] ?? "" }),
  },
  {
    pattern: /^(https?:\/\/\S+)\s*を\s*(?:取得|読んで|見て)\s*$/i,
    build: (m) => formatToolCall("web_fetch", { url: m[1] ?? "" }),
  },
  {
    // 「run npm test」「実行: git status」
    pattern: /^(?:run|exec|sh|実行)\s*[:：]?\s*(.+)$/i,
    build: (m) => formatToolCall("run_shell", { command: (m[1] ?? "").trim() }),
  },
  {
    // 「write memo.txt おはよう」
    pattern: /^(?:write|書いて)\s+(\S+)\s+([\s\S]+)$/i,
    build: (m) => formatToolCall("write_file", { path: m[1] ?? "", content: m[2] ?? "" }),
  },
];

function helpText(tools: Tool[]): string {
  return [
    "rule プロバイダが理解できる言い方はこれだけです:",
    "  ls [パス]                 ファイル一覧",
    "  search <正規表現> [glob]  中身を横断検索（「<語> を検索」でも可）",
    "  read <パス>               ファイルを読む（「<パス> を読んで」でも可）",
    "  write <パス> <内容>       ファイルに書き込む",
    "  run <コマンド>            シェルを実行",
    "  fetch <URL>               URL の本文を取得（「<URL> を取得」でも可）",
    "  web <検索語>              インターネットを検索（結果をそのまま表示）",
    "",
    "edit_file（部分置換）はルールでは呼べません。LLM の頭脳に切り替えると使えます。",
    "",
    `登録されているツール: ${tools.map((t) => t.name).join(", ")}`,
  ].join("\n");
}

export function createRuleProvider(): Provider {
  return {
    name: "rule",
    async complete(messages, tools) {
      const last = messages[messages.length - 1];
      if (!last) return "何か指示をください。";

      // ツールの結果が返ってきた直後。賢い要約はできないので、そのまま提示して終わる。
      if (last.role === "tool") {
        return `${last.toolName} の結果です。\n\n${last.content}`;
      }

      const input = last.content.trim();
      if (/^(こんにちは|こんばんは|おはよう(?:ございます)?|やあ|hello|hi)[!！。\s]*$/i.test(input)) {
        return "こんにちは、origin です。今は定型応答ですが、/search でネット検索を試せます。自由な会話は /provider ollama で始められます。";
      }
      if (/^(ありがとう(?:ございます)?|thanks|thank you)[!！。\s]*$/i.test(input)) {
        return "どういたしまして。また一緒に試してみましょう。";
      }
      if (/^(help|ヘルプ|使い方|\?)$/i.test(input)) {
        return helpText(tools);
      }

      for (const rule of RULES) {
        const m = input.match(rule.pattern);
        if (m) return rule.build(m);
      }

      return [
        "その言い方はまだ覚えていません。",
        "rule プロバイダはルールベースなので、書かれた規則しか理解できず、学習もしません。",
        "使える言い方は help で確認できます。",
        "自然な日本語を理解させたくなったら /provider ollama などに切り替えてください。",
      ].join("\n");
    },
  };
}
