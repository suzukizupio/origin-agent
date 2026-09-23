#!/usr/bin/env node
// 対話シェル。エージェントを人間の指に繋ぐ層。

import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { join, resolve } from "node:path";
import { Agent } from "./agent.ts";
import { Assistant } from "./assistant.ts";
import { LearningStore } from "./learning.ts";
import { ReplyPrinter } from "./streaming.ts";
import { allTools } from "./tools/index.ts";
import { resolveProviderSelection, providerNames } from "./providers/index.ts";
import type { AgentEvent, AgentMode, CompletionStats } from "./types.ts";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

type Options = {
  provider: string;
  model: string | undefined;
  root: string;
  yolo: boolean;
  mode: AgentMode;
  dataDir?: string;
};

function parseArgs(argv: string[]): Options {
  const opts: Options = { provider: "auto", model: undefined, root: process.cwd(), yolo: false, mode: "chat" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (["--provider", "--model", "--root", "--mode", "--data-dir"].includes(arg ?? "") && (!next || next.startsWith("--"))) {
      throw new Error(`${arg} の値を指定してください。`);
    }
    if (arg === "--provider" && next !== undefined) opts.provider = argv[++i] ?? "auto";
    else if (arg === "--model" && next !== undefined) opts.model = argv[++i];
    else if (arg === "--root" && next !== undefined) opts.root = resolve(argv[++i] ?? ".");
    else if (arg === "--data-dir" && next !== undefined) opts.dataDir = resolve(argv[++i] ?? ".");
    else if (arg === "--yolo") opts.yolo = true;
    else if (arg === "--mode") {
      if (next !== "chat" && next !== "code") throw new Error("--mode は chat または code です。");
      opts.mode = next;
      i++;
    }
    else if (arg === "--help" || arg === "-h") {
      stdout.write(
        [
          "使い方: node src/cli.ts [オプション]",
          "",
          `  --provider <名前>  頭脳を選ぶ (auto | ${providerNames.join(" | ")})。既定は auto`,
          "  --model <名前>     プロバイダに渡すモデル名",
          "  --mode <モード>    chat（会話・検索、既定）/ code（コーディングも可能）",
          "  --root <パス>      作業ルート。既定は現在のディレクトリ",
          "  --data-dir <パス>  記憶・感想の保存先。既定は作業ルート内の .origin-agent",
          "  --yolo             確認プロンプトを出さない",
          "",
        ].join("\n"),
      );
      process.exit(0);
    } else throw new Error(`不明なオプション: ${arg}。--help で使い方を確認できます。`);
  }
  return opts;
}

const reply = new ReplyPrinter((text) => { stdout.write(text); });

function render(event: AgentEvent): void {
  switch (event.type) {
    case "assistant":
      reply.answer(event.text);
      break;
    case "assistant_delta":
      reply.delta(event.text);
      break;
    case "model_stats":
      break;
    case "tool_start": {
      reply.finish();
      const args = Object.entries(event.args)
        .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 60)}`)
        .join(" ");
      stdout.write(c.dim(`\n  ● ${event.name} ${args}\n`));
      break;
    }
    case "tool_end": {
      const mark = event.ok ? c.green("  ✓") : c.red("  ✗");
      const lines = event.result.split("\n");
      const head = lines.slice(0, 12).join("\n    ");
      const rest = lines.length > 12 ? c.dim(`\n    … 他 ${lines.length - 12} 行`) : "";
      stdout.write(`${mark}\n    ${c.dim(head)}${rest}\n`);
      break;
    }
    case "notice":
      reply.finish();
      stdout.write(c.yellow(`\n  ! ${event.message}\n`));
      break;
    case "done":
      reply.finish();
      if (event.reason === "max_steps") {
        stdout.write(c.yellow("\n  ! 最大ステップ数に達したので止めました\n"));
      } else if (event.reason === "stuck") {
        stdout.write(c.yellow("  ! 指示を変えるか、賢い頭脳に差し替えてみてください\n"));
      }
      break;
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const selection = await resolveProviderSelection(opts.provider, opts.model);
  const store = new LearningStore(opts.dataDir ?? join(opts.root, ".origin-agent"));
  const saved = await store.read();
  const rl = readline.createInterface({ input: stdin, output: stdout });

  // 入力行をキューに溜め、メインループと確認プロンプトの両方がここから引く。
  // rl.question を使わないのは、パイプ入力（テストや自動化）だと
  // ストリーム終端と噛み合わず1行しか読めないため。null は「もう入力がない」。
  const pending: string[] = [];
  const waiting: Array<(line: string | null) => void> = [];
  let ended = false;

  rl.on("line", (line: string) => {
    const waiter = waiting.shift();
    if (waiter) waiter(line);
    else pending.push(line);
  });
  rl.on("close", () => {
    ended = true;
    while (waiting.length > 0) waiting.shift()?.(null);
  });

  const ask = (prompt: string): Promise<string | null> => {
    const queued = pending.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (ended) return Promise.resolve(null);
    rl.setPrompt(prompt);
    rl.prompt();
    return new Promise((done) => waiting.push(done));
  };

  const agent = new Agent({
    ...selection,
    tools: allTools,
    mode: opts.mode,
    ctx: {
      root: opts.root,
      confirm: async (message: string) => {
        if (opts.yolo) return true;
        // 複数行の確認メッセージ（edit_file の差分など）は、
        // 最終行だけをプロンプトにして、それ以外は先に表示する。
        const lines = message.split("\n");
        const question = lines.pop() ?? "";
        if (lines.length > 0) {
          stdout.write(c.yellow(`\n  ? ${lines.join("\n  ")}\n`));
          const answer = await ask(c.yellow(`  ${question} [y/N] `));
          return answer !== null && /^(y|yes)$/i.test(answer.trim());
        }
        const answer = await ask(c.yellow(`\n  ? ${question} [y/N] `));
        // 答えられない状況（非対話実行）では拒否側に倒す
        return answer !== null && /^(y|yes)$/i.test(answer.trim());
      },
    },
  });

  const assistant = new Assistant(agent, store);

  stdout.write(
    [
      "",
      c.bold("origin-agent") + c.dim(" v0.8.1"),
      c.dim(`  頭脳: ${agent.provider.name}`),
      c.dim(`  モード: ${agent.mode === "chat" ? "会話・ネット検索" : "コーディング"}`),
      c.dim(`  作業ルート: ${opts.root}`),
      c.dim(`  保存した記憶: ${saved.memories.length}件 / 感想: ${saved.feedback.length}件`),
      c.dim(`  ツール: ${agent.toolList.map((t) => t.name).join(", ")}`),
      opts.yolo ? c.red("  確認プロンプトなし (--yolo)") : "",
      "",
      "  こんにちは。会話したり、気になることを一緒に調べたりしましょう。",
      c.dim("  /memory  /remember 呼び方 ハル  /search <検索語>  /help  /exit"),
      "",
    ]
      .filter((line) => line !== "")
      .join("\n") + "\n",
  );
  if (agent.provider.name === "rule") {
    stdout.write(c.yellow("  定型応答モードです。自由な会話・検索結果の要約には Ollama のモデルが必要です。\n"));
  }

  let lastTiming: { elapsedMs: number; firstTextMs?: number; calls: CompletionStats[] } | undefined;
  for (;;) {
    const line = await ask(c.cyan("\n> "));
    if (line === null) break;
    const input = line.trim();
    if (input === "") continue;

    if (input === "/exit" || input === "/quit") break;
    if (input === "/reset") {
      assistant.reset();
      stdout.write(c.dim("  会話をリセットしました。保存した記憶は残っています。\n"));
      continue;
    }
    if (input === "/tools") {
      for (const tool of agent.toolList) {
        stdout.write(`  ${c.bold(tool.name)} — ${tool.description}\n`);
      }
      continue;
    }
    if (input === "/stats") {
      if (!lastTiming) { stdout.write("  まだ応答の計測がありません。\n"); continue; }
      const seconds = (ms: number) => `${(ms / 1000).toFixed(2)}秒`;
      stdout.write(`  前の応答: 全体 ${seconds(lastTiming.elapsedMs)} / 最初の表示 ${lastTiming.firstTextMs === undefined ? "なし" : seconds(lastTiming.firstTextMs)}\n`);
      for (const [index, stats] of lastTiming.calls.entries()) {
        const detail = [
          stats.loadMs === undefined ? "" : `モデル読み込み ${seconds(stats.loadMs)}`,
          stats.promptMs === undefined ? "" : `入力の処理 ${seconds(stats.promptMs)}`,
          stats.generationMs === undefined ? "" : `文章の生成 ${seconds(stats.generationMs)}`,
          stats.outputTokens === undefined ? "" : `出力 ${stats.outputTokens}トークン`,
        ].filter(Boolean).join(" / ");
        stdout.write(`  モデル ${index + 1}回目: ${seconds(stats.elapsedMs)}${detail ? ` (${detail})` : ""}\n`);
      }
      if (!lastTiming.calls.length) stdout.write("  モデルの完了計測なし（記憶コマンド・定型応答・通信失敗など）。\n");
      continue;
    }
    if (/^\/mode(?:\s|$)/.test(input)) {
      const [, mode] = input.split(/\s+/);
      if (mode !== "chat" && mode !== "code") {
        stdout.write(`  現在: ${agent.mode}。/mode chat（会話）または /mode code（コーディング）\n`);
        continue;
      }
      agent.setMode(mode);
      assistant.reset();
      stdout.write(c.green(`  ${mode === "chat" ? "会話" : "コーディング"}モードに切り替え、会話をリセットしました\n`));
      continue;
    }
    if (/^\/provider(?:\s|$)/.test(input)) {
      const [, name, model] = input.split(/\s+/);
      if (name === undefined) {
        stdout.write(`  現在: ${agent.provider.name}（選べるのは auto, ${providerNames.join(", ")}）\n`);
        continue;
      }
      try {
        const next = await resolveProviderSelection(name, model);
        agent.setProviders(next.provider, next.repairProvider);
        assistant.reset();
        stdout.write(c.green(`  頭脳を ${agent.provider.name} に差し替えました\n`));
      } catch (e) {
        stdout.write(c.red(`  ${(e as Error).message}\n`));
      }
      continue;
    }
    if (input === "/help") {
      stdout.write(
        [
          "  /tools               ツール一覧",
          "  /stats               前の応答時間と、モデルの処理時間を確認",
          "  /provider [名前]     頭脳を差し替える",
          "  /mode chat|code      会話・検索 / コーディングへ切り替え（会話をリセット）",
          "  /search <検索語>     インターネットで調べる",
          "  /remember <項目> <内容>  記憶を保存・更新（例: /remember 呼び方 ハル）",
          "  /memory              保存した記憶を確認",
          "  /forget <項目>       記憶と、その内容を含む感想を削除（会話もリセット）",
          "  /feedback good [感想]    直前の回答のよかった点を記録",
          "  /feedback bad <改善点>   直前の回答の改善点を記録",
          "  /feedback list          最近の感想を確認",
          "  /feedback delete <ID>   感想を削除",
          "  /reset               会話をリセット",
          "  /exit                終了",
        ].join("\n") + "\n",
      );
      continue;
    }

    const started = performance.now();
    let firstTextMs: number | undefined;
    const calls: CompletionStats[] = [];
    try {
      if (!input.startsWith("/")) stdout.write(c.dim("  考えています…\n"));
      await assistant.run(input, (event) => {
        if ((event.type === "assistant_delta" || event.type === "assistant") && event.text) firstTextMs ??= performance.now() - started;
        if (event.type === "model_stats") calls.push(event.stats);
        render(event);
      });
    } catch (e) {
      reply.finish();
      stdout.write(c.red(`\n  エラー: ${(e as Error).message}\n`));
    } finally {
      reply.finish();
      lastTiming = { elapsedMs: performance.now() - started, firstTextMs, calls };
    }
  }

  rl.close();
}

await main().catch((error: unknown) => {
  console.error(`エラー: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
