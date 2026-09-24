// ローカルモデルが隔離コピーに自己改修の「候補」を作る。
// 候補コードは実行・採点・採用しない。安全な実行環境がないPCでも提案だけ保存できる。

import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { spawn } from "node:child_process";
import { createOllamaProvider } from "../src/providers/ollama.ts";
import { proposeSelfChange } from "../src/self-improve.ts";
import type { AgentEvent, Provider } from "../src/types.ts";

const runFile = promisify(execFile);
const LOCAL_OLLAMA = "http://127.0.0.1:11434";
const TEMP_PREFIX = "origin-agent-self-";

type Options = { goal?: string; goalFile?: string; model: string; attempts: number; minutes: number };

function parseArgs(args: string[]): Options {
  const options: Options = { model: "qwen2.5-coder:7b", attempts: 1, minutes: 30 };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--help") {
      console.log([
        "使い方: node scripts/self-improve.ts --goal <改善したい問題> [オプション]",
        "  --goal-file <path>  改善したい問題をファイルから読む（--goal と併用不可）",
        "  --model <name>     導入済みのローカルOllamaモデル。既定は qwen2.5-coder:7b",
        "  --attempts <1..5>  独立した候補を作る回数。既定は1",
        "  --minutes <1..480> 全体の待ち時間の上限。既定は30分",
        "候補は .origin-agent/proposals/ に保存。実行・採点・適用・プッシュは行いません。",
      ].join("\n"));
      process.exit(0);
    }
    const value = args[++i];
    if (value === undefined) throw new Error(`${flag} に値が必要です。`);
    if (flag === "--goal") options.goal = value;
    else if (flag === "--goal-file") options.goalFile = value;
    else if (flag === "--model") options.model = value;
    else if (flag === "--attempts") options.attempts = Number(value);
    else if (flag === "--minutes") options.minutes = Number(value);
    else throw new Error(`不明なオプション: ${flag}`);
  }
  if ((options.goal === undefined) === (options.goalFile === undefined)) {
    throw new Error("--goal または --goal-file のどちらか1つを指定してください。");
  }
  if (!Number.isInteger(options.attempts) || options.attempts < 1 || options.attempts > 5) {
    throw new Error("--attempts は1〜5の整数です。");
  }
  if (!Number.isInteger(options.minutes) || options.minutes < 1 || options.minutes > 480) {
    throw new Error("--minutes は1〜480の整数です。");
  }
  return options;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await runFile("git", args, { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 8_000_000, windowsHide: true });
  return stdout.trim();
}

async function localModel(name: string): Promise<void> {
  const response = await fetch(`${LOCAL_OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`ローカルOllamaが HTTP ${response.status} を返しました。`);
  const data = await response.json() as { models?: Array<{ name?: string }> };
  if (!data.models?.some((model) => model.name === name)) {
    throw new Error(`${name} はローカルOllamaにありません。導入済みのモデルを --model で指定してください。`);
  }
}

function modelUntilDeadline(model: string, deadline: number): Provider {
  const initial = createOllamaProvider({ host: LOCAL_OLLAMA, model });
  return {
    name: initial.name,
    contextBudget: initial.contextBudget,
    complete(messages, tools, env, callbacks) {
      const remaining = deadline - Date.now();
      if (remaining < 1_000) throw new Error("自己改修の時間上限に達しました。");
      return createOllamaProvider({ host: LOCAL_OLLAMA, model, timeoutMs: Math.min(300_000, remaining) })
        .complete(messages, tools, env, callbacks);
    },
  };
}

function preventSleep(): ReturnType<typeof spawn> | undefined {
  if (process.platform !== "win32") return undefined;
  const parentId = process.pid;
  const command = [
    `$originParentPid = ${parentId}`,
    "Add-Type -Namespace Origin -Name SleepGuard -MemberDefinition '[System.Runtime.InteropServices.DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
    "try { while (Get-Process -Id $originParentPid -ErrorAction SilentlyContinue) { [Origin.SleepGuard]::SetThreadExecutionState([uint32]2147483649) | Out-Null; Start-Sleep -Seconds 20 } } finally { [Origin.SleepGuard]::SetThreadExecutionState([uint32]2147483648) | Out-Null }",
  ].join("; ");
  return spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", command],
    { stdio: "ignore", windowsHide: true });
}

async function checkedTemporaryPath(path: string): Promise<string> {
  const parent = await realpath(tmpdir());
  const actual = await realpath(path);
  const name = relative(parent, actual);
  if (!name.startsWith(TEMP_PREFIX) || name.includes(sep) || name.includes("..")) {
    throw new Error(`予期しない作業コピーの場所なので削除しません: ${actual}`);
  }
  return actual;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const goal = (options.goal ?? await readFile(resolve(options.goalFile!), "utf8")).trim();
  if (!goal || goal.length > 8_000) throw new Error("改善目標は1〜8000文字で指定してください。");
  const repo = await git(process.cwd(), "rev-parse", "--show-toplevel");
  if (await git(repo, "status", "--porcelain")) throw new Error("元の作業ツリーに変更があります。先にコミットまたは整理してください。");
  const baseCommit = await git(repo, "rev-parse", "HEAD");
  await localModel(options.model);
  const outputDir = join(repo, ".origin-agent", "proposals");
  await mkdir(outputDir, { recursive: true });
  const deadline = Date.now() + options.minutes * 60_000;
  const guard = preventSleep();
  console.log(`ローカルモデル ${options.model} で最大 ${options.attempts} 件の修正案を作ります。候補コードは実行しません。`);
  try {
    for (let attempt = 1; attempt <= options.attempts && Date.now() < deadline; attempt++) {
      const candidate = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
      const safeCandidate = await checkedTemporaryPath(candidate);
      const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${attempt}`;
      const reportPath = join(outputDir, `${name}.json`);
      const events: AgentEvent[] = [];
      let attached = false;
      try {
        await git(repo, "worktree", "add", "--detach", safeCandidate, baseCommit);
        attached = true;
        if (await git(safeCandidate, "rev-parse", "HEAD") !== baseCommit) throw new Error("候補の基準コミットが一致しません。");
        console.log(`\n候補 ${attempt}/${options.attempts} を作成中…`);
        await proposeSelfChange(safeCandidate, goal, modelUntilDeadline(options.model, deadline), (event) => {
          events.push(event);
          if (event.type === "notice") console.log(`  ${event.message}`);
          if (event.type === "tool_end") console.log(`  ${event.name}: ${event.ok ? "成功" : "失敗"}`);
        });
        const changed = (await git(safeCandidate, "diff", "--name-only")).split(/\r?\n/).filter(Boolean);
        if (changed.some((path) => !path.startsWith("src/"))) {
          throw new Error("src/ 以外に差分ができたため候補を破棄します。");
        }
        const patch = await git(safeCandidate, "diff", "--binary", "--", "src");
        if (!patch) {
          await writeFile(reportPath, `${JSON.stringify({ status: "差分なし", baseCommit, goal, model: options.model, events }, null, 2)}\n`, "utf8");
          console.log(`  差分なし。操作履歴: ${reportPath}`);
          continue;
        }
        await git(safeCandidate, "diff", "--check");
        const patchPath = join(outputDir, `${name}.patch`);
        await writeFile(patchPath, `${patch}\n`, "utf8");
        await writeFile(reportPath, `${JSON.stringify({
          status: "未検証", baseCommit, goal, model: options.model, changed, events,
          warning: "候補コードは実行・採点・採用していません。",
        }, null, 2)}\n`, "utf8");
        console.log(`  未検証の修正案: ${patchPath}`);
      } catch (error) {
        await writeFile(reportPath, `${JSON.stringify({
          status: "失敗", baseCommit, goal, model: options.model,
          error: error instanceof Error ? error.message : String(error), events,
        }, null, 2)}\n`, "utf8");
        throw error;
      } finally {
        if (attached) await git(repo, "worktree", "remove", "--force", safeCandidate);
        if (await access(safeCandidate).then(() => true, () => false)) {
          await rm(await checkedTemporaryPath(safeCandidate), { recursive: true });
        }
      }
    }
  } finally {
    guard?.kill();
  }
  console.log(`\n修正案の保存先: ${outputDir}`);
  console.log("候補の実行・採点・適用・プッシュは行っていません。");
}

await main().catch((error: unknown) => {
  console.error(`エラー: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
