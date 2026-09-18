// 能力テストの採点。
//
// check:code / check:growth との違いは1点だけ、しかし決定的:
// あちらは1回試して assert で落ちる。こちらは同じ課題を何度も試して成功率を出す。
//
// LLM は毎回違う出力を出すので、1回の成功は「できた」の証明にならない。
// 実際に同じ3Bモデル・同じ課題で、4回失敗して5回目に成功した記録がある（README参照）。
// その5回目だけを見れば緑になるが、本当の成功率は20%だった。
//
//   npm run eval -- --repeat 3
//   npm run eval -- --repeat 3 --model qwen2.5-coder:7b --out 7b.json
//   npm run eval -- --repeat 3 --compare 7b.json
//   npm run eval -- --holdout --repeat 3   … 直し終わってから1回。合計だけを表示する

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { Agent } from "../src/agent.ts";
import { Assistant } from "../src/assistant.ts";
import { LearningStore } from "../src/learning.ts";
import { allTools } from "../src/tools/index.ts";
import { resolveProvider } from "../src/providers/index.ts";
import { tasks as allTasks } from "./eval-tasks.ts";
import type { Task, TaskResult } from "./eval-tasks.ts";
import type { AgentEvent, Provider } from "../src/types.ts";

const PREFIX = "origin-agent-eval-";

type TurnTrace = { input: string; restart: boolean; events: AgentEvent[] };
type Attempt = { ok: boolean; ms: number; reason?: string; trace: TurnTrace[] };
type TaskReport = {
  id: string; title: string; passed: number; total: number; meanMs: number; failures: string[];
  tools?: string[];
  attempts?: Attempt[];
};
type Report = {
  startedAt: string;
  completed?: boolean;
  provider: string;
  repeat: number;
  /** 1回の応答を待つ上限（秒）。条件が違う結果同士を比べていないか確かめるために残す。古い結果には無い */
  timeoutSec?: number;
  passed: number;
  total: number;
  tasks: TaskReport[];
};

type Options = {
  repeat: number;
  provider: string;
  model: string | undefined;
  only: string[];
  offline: boolean;
  holdout: boolean;
  out: string | undefined;
  compare: string | undefined;
  min: number;
  timeoutSec: number | undefined;
};

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    repeat: 3, provider: "auto", model: undefined, only: [],
    offline: false, holdout: false, out: undefined, compare: undefined, min: 0, timeoutSec: undefined,
  };
  const needsValue = ["--repeat", "--provider", "--model", "--only", "--out", "--compare", "--min", "--timeout"];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const next = argv[i + 1];
    if (needsValue.includes(arg) && (next === undefined || next.startsWith("--"))) {
      throw new Error(`${arg} の値を指定してください。`);
    }
    if (arg === "--repeat") opts.repeat = Number(argv[++i]);
    else if (arg === "--provider") opts.provider = argv[++i] ?? "auto";
    else if (arg === "--model") opts.model = argv[++i];
    else if (arg === "--only") opts.only = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--out") opts.out = resolve(argv[++i] ?? "");
    else if (arg === "--compare") opts.compare = resolve(argv[++i] ?? "");
    else if (arg === "--min") opts.min = Number(argv[++i]);
    else if (arg === "--timeout") opts.timeoutSec = Number(argv[++i]);
    else if (arg === "--offline") opts.offline = true;
    else if (arg === "--holdout") opts.holdout = true;
    else if (arg === "--help" || arg === "-h") {
      console.log([
        "使い方: node scripts/eval.ts [オプション]",
        "",
        "  --repeat <回数>    1課題あたりの試行回数。既定は 3",
        "  --provider <名前>  auto | rule | ollama。既定は auto",
        "  --model <名前>     モデル名",
        "  --only <id,id>     指定した課題だけ走らせる",
        "  --offline          ネットを使う課題を除外する",
        "  --holdout          holdout の課題だけを走らせ、合計だけを表示する。骨格を直し終わってから使う",
        "  --out <パス>       成績・操作履歴をJSONで保存する（課題ごとに途中保存）",
        "  --compare <パス>   保存した結果と比べて増減を表示する",
        "  --min <0〜1>       全体の成功率がこれ未満なら終了コード1。既定は 0",
        "  --timeout <秒>     1回の応答を待つ上限。7B 以上を GPU なしで測るときは 300 程度に延ばす",
        "",
        `課題: ${allTasks.map((t) => t.id).join(", ")}`,
      ].join("\n"));
      process.exit(0);
    } else throw new Error(`不明なオプション: ${arg}`);
  }
  if (!Number.isInteger(opts.repeat) || opts.repeat < 1) throw new Error("--repeat は1以上の整数です。");
  if (!(opts.min >= 0 && opts.min <= 1)) throw new Error("--min は 0〜1 です。");
  if (opts.timeoutSec !== undefined && !(opts.timeoutSec > 0)) throw new Error("--timeout は正の秒数です。");
  return opts;
}

/** 一時ディレクトリを、自分が作ったものだと確認してから消す */
async function cleanup(parent: string, directory: string): Promise<void> {
  const rel = relative(parent, resolve(directory));
  if (isAbsolute(rel) || !rel.startsWith(PREFIX) || /[\\/]/.test(rel) || rel.includes("..")) {
    throw new Error(`一時ディレクトリの範囲を確認できません。削除を中止します: ${directory}`);
  }
  await rm(directory, { recursive: true, force: true });
}

function oneLine(text: string, max = 110): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

async function runOnce(task: Task, provider: Provider): Promise<Attempt> {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, PREFIX));
  const started = Date.now();
  const trace: TurnTrace[] = [];
  try {
    await task.setup?.(root);

    const names = task.tools;
    const store = new LearningStore(root);
    const build = () => {
      const agent = new Agent({
        provider,
        mode: task.mode,
        maxSteps: task.maxSteps ?? 6,
        tools: names === undefined ? allTools : allTools.filter((tool) => names.includes(tool.name)),
        // 採点中は人が居ないので承認は通す。write_file の上書き禁止など、
        // モデルに向いた関門はここでは緩まない。そこが守りの本体。
        ctx: { root, confirm: async () => true },
      });
      return { agent, assistant: new Assistant(agent, store) };
    };

    let built = build();
    let events: AgentEvent[] = [];
    let answer = "";

    for (const turn of task.turns) {
      if (turn.restart === true) built = build(); // 再起動相当。保存した記憶だけが引き継がれる
      events = [];
      answer = "";
      trace.push({ input: turn.text, restart: turn.restart === true, events });
      const collect = (event: AgentEvent): void => {
        events.push(event);
        if (event.type === "assistant") answer = event.text;
      };
      if (task.via === "assistant") await built.assistant.run(turn.text, collect);
      else await built.agent.run(turn.text, collect);
    }

    const result: TaskResult = {
      answer,
      events,
      root,
      read: (relativePath) => readFile(join(root, relativePath), "utf8"),
    };
    await task.check(result);
    return { ok: true, ms: Date.now() - started, trace };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, reason: (error as Error).message, trace };
  } finally {
    await cleanup(parent, root);
  }
}

function bar(passed: number, total: number): string {
  return "█".repeat(passed) + "░".repeat(Math.max(0, total - passed));
}

function printTable(report: Report, previous: Report | undefined): void {
  const width = Math.max(...report.tasks.map((t) => t.id.length), 4);
  console.log(`\n${"課題".padEnd(width)}  成功率        平均    ${previous ? "前回比  " : ""}内容`);
  console.log("-".repeat(width + (previous ? 46 : 38)));

  for (const task of report.tasks) {
    const rate = `${task.passed}/${task.total} ${bar(task.passed, task.total)}`;
    const mean = `${(task.meanMs / 1000).toFixed(1)}秒`;
    let delta = "";
    if (previous) {
      const before = previous.tasks.find((t) => t.id === task.id);
      if (before === undefined) delta = "  新規  ";
      else {
        const diff = task.passed / task.total - before.passed / before.total;
        delta = diff === 0 ? "   →    " : `  ${diff > 0 ? "↑" : "↓"}${Math.abs(diff * 100).toFixed(0).padStart(3)}% `;
      }
    }
    console.log(`${task.id.padEnd(width)}  ${rate.padEnd(12)}  ${mean.padStart(6)}  ${delta}${task.title}`);
    const oldTools = previous?.tasks.find((t) => t.id === task.id)?.tools;
    if (oldTools && task.tools && JSON.stringify(oldTools) !== JSON.stringify(task.tools)) {
      console.log(`  ツール変更: ${oldTools.join(", ")} → ${task.tools.join(", ")}`);
    }
  }

  const rate = report.total === 0 ? 0 : report.passed / report.total;
  console.log("-".repeat(width + (previous ? 46 : 38)));
  console.log(`${"合計".padEnd(width)}  ${report.passed}/${report.total} (${(rate * 100).toFixed(0)}%)`);

  const weak = report.tasks.filter((t) => t.passed < t.total);
  if (weak.length > 0) {
    console.log("\n落ちた課題と、最後の理由:");
    for (const task of weak) {
      console.log(`  ${task.id}: ${oneLine(task.failures.at(-1) ?? "理由不明")}`);
    }
    console.log("\nここが次に骨格を直す場所です。プロンプト・ツールの説明・エラー文を変えて、また採点してください。");
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  // プロバイダを作る前に設定する。ollama プロバイダはこの環境変数から待ち時間を読む
  if (opts.timeoutSec !== undefined) {
    process.env.ORIGIN_OLLAMA_TIMEOUT_MS = String(Math.round(opts.timeoutSec * 1000));
  }
  const timeoutSec = Number(process.env.ORIGIN_OLLAMA_TIMEOUT_MS ?? 120_000) / 1000;
  const provider = await resolveProvider(opts.provider, opts.model);
  if (provider.name === "rule") {
    throw new Error("採点には言語モデルが要ります。ollama を起動してから実行してください。");
  }

  const selected = allTasks.filter((task) => {
    if (opts.only.length > 0) {
      if (!opts.only.includes(task.id)) return false;
    } else if ((task.holdout === true) !== opts.holdout) return false;
    if (opts.offline && task.network === true) return false;
    return true;
  });
  if (selected.length === 0) throw new Error("走らせる課題がありません。--only の指定を確認してください。");

  const previous = opts.compare === undefined
    ? undefined
    : (JSON.parse(await readFile(opts.compare, "utf8")) as Report);
  if (previous?.completed === false) throw new Error("比較対象は途中の採点結果です。完了した結果を指定してください。");

  console.log(`頭脳: ${provider.name}（応答待ち上限 ${timeoutSec}秒）`);
  console.log(`課題 ${selected.length}件 × ${opts.repeat}回 = ${selected.length * opts.repeat}回の試行`);
  if (previous) {
    console.log(`比較対象: ${previous.provider}（${previous.passed}/${previous.total}）`);
    if (previous.timeoutSec !== undefined && previous.timeoutSec !== timeoutSec) {
      console.log(`  ! 比較対象の応答待ち上限は ${previous.timeoutSec}秒でした。条件が違います。`);
    }
  }
  console.log("");

  const report: Report = {
    startedAt: new Date().toISOString(),
    completed: false,
    provider: provider.name,
    repeat: opts.repeat,
    timeoutSec,
    passed: 0,
    total: 0,
    tasks: [],
  };

  let index = 0;
  const totalRuns = selected.length * opts.repeat;
  for (const task of selected) {
    const attempts: Attempt[] = [];
    for (let round = 1; round <= opts.repeat; round++) {
      index++;
      // holdout はどの課題が落ちたかを見せない。見ると、それを通す規則を書いてしまう
      process.stdout.write(opts.holdout ? `[${String(index).padStart(2)}/${totalRuns}] holdout … ` : `[${String(index).padStart(2)}/${totalRuns}] ${task.id} #${round} … `);
      const attempt = await runOnce(task, provider);
      attempts.push(attempt);
      if (opts.holdout) console.log(`${(attempt.ms / 1000).toFixed(1)}秒`);
      else console.log(`${attempt.ok ? "✓" : "✗"} ${(attempt.ms / 1000).toFixed(1)}秒${attempt.ok ? "" : `  ${oneLine(attempt.reason ?? "理由不明")}`}`);
    }
    const passed = attempts.filter((a) => a.ok).length;
    report.tasks.push({
      id: task.id,
      title: task.title,
      passed,
      total: attempts.length,
      meanMs: Math.round(attempts.reduce((sum, a) => sum + a.ms, 0) / attempts.length),
      failures: attempts.flatMap((a) => (a.reason === undefined ? [] : [a.reason])),
      tools: allTools.filter((tool) => (task.tools === undefined || task.tools.includes(tool.name))
        && (task.mode === "code" || tool.name.startsWith("web_"))).map((tool) => tool.name),
      attempts,
    });
    report.passed += passed;
    report.total += attempts.length;
    // 長い採点の途中でも、終わった課題の経過と失敗理由を残す。
    if (opts.out !== undefined) await writeFile(opts.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  report.completed = true;
  if (opts.holdout) {
    const before = previous ? `（比較対象 ${previous.passed}/${previous.total}）` : "";
    console.log(`
holdout 合計 ${report.passed}/${report.total}${before}`);
    console.log("課題ごとの内訳は表示しません。落ちた課題を直すなら、その課題は tune に移してください。");
  } else printTable(report, previous);

  if (opts.out !== undefined) {
    await writeFile(opts.out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`\n結果を保存しました: ${opts.out}`);
  }

  const rate = report.total === 0 ? 0 : report.passed / report.total;
  if (rate < opts.min) {
    console.error(`\n成功率 ${(rate * 100).toFixed(0)}% が下限 ${(opts.min * 100).toFixed(0)}% を下回りました。`);
    process.exitCode = 1;
  }
}

await main();
