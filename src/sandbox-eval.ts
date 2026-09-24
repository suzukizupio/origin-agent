// 自己改修パッチを固定したテストで比較する。候補コードを実行するのは呼び出し元が
// 用意した隔離コンテナ内だけ。ここでは元の作業ツリーへパッチを適用しない。

import { execFile } from "node:child_process";
import { access, lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { isEditableSourcePath } from "./self-improve.ts";

const runFile = promisify(execFile);
const TEMP_PREFIX = "origin-agent-check-";
const MAX_PATCH_BYTES = 100_000;

export type SandboxResult = {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  checks?: CheckSummary;
};

export type EvaluationReport = {
  baseCommit: string;
  patchSha256: string;
  changed: string[];
  baseline: SandboxResult;
  candidate: SandboxResult;
  verdict: "improved_checks" | "checks_pass_no_gain_measured" | "regression" | "checks_still_fail" | "invalid_checks";
  adopted: false;
};

export type SandboxRunner = (worktree: string, phase: "baseline" | "candidate") => Promise<SandboxResult>;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await runFile("git", args, {
    cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 8_000_000, windowsHide: true,
  });
  return stdout;
}

/** 固定コマンドが完了した証拠。候補コードの悪意ある出力偽装を完全に防ぐものではない。 */
export type CheckSummary = { tests: number; passed: number; failed: number; skipped: number; todo: number; cancelled: number; testExit: number; typecheckExit: number };
export function parseCheckSummary(stdout: string): CheckSummary | undefined {
  const value = (name: string): number | undefined => {
    const matches = [...stdout.matchAll(new RegExp(`^# ${name} (\\d+)\\r?$`, "gm"))];
    if (matches.length !== 1) return undefined;
    const n = Number(matches[0]![1]);
    return Number.isSafeInteger(n) ? n : undefined;
  };
  const tests = value("tests"), passed = value("pass"), failed = value("fail");
  const skipped = value("skipped"), todo = value("todo"), cancelled = value("cancelled");
  const markers = [...stdout.matchAll(/^ORIGIN_CHECK_EXIT (\d+) (\d+)\r?$/gm)];
  if (tests === undefined || passed === undefined || failed === undefined || skipped === undefined || todo === undefined || cancelled === undefined || markers.length !== 1) return;
  const testExit = Number(markers[0]![1]), typecheckExit = Number(markers[0]![2]);
  if (tests < 1 || tests !== passed + failed + skipped + todo + cancelled || ![0, 1].includes(testExit) || ![0, 1, 2].includes(typecheckExit)) return;
  if ((testExit === 0) !== (failed === 0 && cancelled === 0)) return;
  return { tests, passed, failed, skipped, todo, cancelled, testExit, typecheckExit };
}

function completeChecks(result: SandboxResult): boolean {
  const c = result.checks;
  return !!c && !result.timedOut && Object.values(c).every((n) => Number.isSafeInteger(n) && n >= 0)
    && c.tests > 0 && c.tests === c.passed + c.failed + c.skipped + c.todo + c.cancelled
    && [0, 1].includes(c.testExit) && [0, 1, 2].includes(c.typecheckExit)
    && (c.testExit === 0) === (c.failed === 0 && c.cancelled === 0)
    && c.skipped === 0 && c.todo === 0 && c.cancelled === 0
    && result.ok === (c.testExit === 0 && c.typecheckExit === 0)
    && result.exitCode === (result.ok ? 0 : 1);
}

/** 読み取ってハッシュ化したバイト列そのものを使う。パッチパスは再読込しない。 */
async function applyPatch(cwd: string, patch: Buffer, check = false): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = execFile("git", ["apply", ...(check ? ["--check"] : []), "--index", "-"],
      { cwd, timeout: 30_000, maxBuffer: 8_000_000, windowsHide: true },
      (error) => error ? reject(error) : resolve());
    child.stdin?.on("error", () => { /* gitの終了エラーをコールバックで受け取る */ });
    child.stdin?.end(patch);
  });
}

function changedPaths(raw: string): string[] {
  const fields = raw.split("\0").filter(Boolean);
  const changed: string[] = [];
  for (let i = 0; i < fields.length;) {
    const field = fields[i++]!;
    const tab = field.indexOf("\t");
    const status = tab < 0 ? field : field.slice(0, tab);
    const path = tab < 0 ? fields[i++] : field.slice(tab + 1);
    if (status !== "M" || !isEditableSourcePath(path)) {
      throw new Error(`候補には src/ の既存ファイルの通常変更だけを許可します: ${status} ${path ?? ""}`);
    }
    changed.push(path);
  }
  if (changed.length === 0 || changed.length > 5) {
    throw new Error(`変更ファイル数は1〜5件に限ります（現在 ${changed.length} 件）。`);
  }
  return changed;
}

async function checkedTemporaryPath(path: string): Promise<string> {
  const parent = await realpath(tmpdir());
  const actual = await realpath(path);
  const name = relative(parent, actual);
  if (!name.startsWith(TEMP_PREFIX) || name.includes(sep) || name.includes("..")) {
    throw new Error(`予期しない一時作業コピーなので削除しません: ${actual}`);
  }
  return actual;
}

export async function evaluatePatch(options: {
  repo: string;
  patchPath: string;
  baseCommit: string;
  runSandbox: SandboxRunner;
}): Promise<EvaluationReport> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(options.baseCommit)) {
    throw new Error("baseCommit はGitの完全なコミットIDが必要です。");
  }
  const repo = await realpath(options.repo);
  const patchPath = await realpath(options.patchPath);
  if (!isAbsolute(patchPath)) throw new Error("パッチは絶対パスで指定してください。");
  const patch = await readFile(patchPath);
  if (patch.length === 0 || patch.length > MAX_PATCH_BYTES) {
    throw new Error(`パッチは1〜${MAX_PATCH_BYTES}バイトに限ります。`);
  }
  const patchSha256 = createHash("sha256").update(patch).digest("hex");
  await git(repo, "cat-file", "-e", `${options.baseCommit}^{commit}`);

  const worktree = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  const safeWorktree = await checkedTemporaryPath(worktree);
  let attached = false;
  try {
    await git(repo, "worktree", "add", "--detach", safeWorktree, options.baseCommit);
    attached = true;
    await applyPatch(safeWorktree, patch, true);
    await applyPatch(safeWorktree, patch);
    const raw = await git(safeWorktree, "diff", "--cached", "--name-status", "--no-renames", "-z");
    const changed = changedPaths(raw);
    if ((await git(safeWorktree, "diff", "--cached", "--summary")).trim()) {
      throw new Error("ファイルの追加・削除・モード変更を含む候補は評価しません。");
    }
    for (const path of changed) {
      await git(safeWorktree, "cat-file", "-e", `${options.baseCommit}:${path}`);
      if (!(await lstat(join(safeWorktree, path))).isFile()) {
        throw new Error(`通常のファイル以外は評価しません: ${path}`);
      }
    }
    // 許可外パッチを検査してから、クリーンな基準版を実行する。
    await git(safeWorktree, "reset", "--hard", options.baseCommit);
    const baseline = await options.runSandbox(safeWorktree, "baseline");
    if ((await git(safeWorktree, "status", "--porcelain")).trim()) {
      throw new Error("基準側の検査で作業コピーが変更されました。結果を採用しません。");
    }
    await applyPatch(safeWorktree, patch);
    const candidate = await options.runSandbox(safeWorktree, "candidate");
    const valid = completeChecks(baseline) && completeChecks(candidate) && baseline.checks!.tests === candidate.checks!.tests;
    const verdict = !valid ? "invalid_checks" : baseline.ok
      ? candidate.ok ? "checks_pass_no_gain_measured" : "regression"
      : candidate.ok ? "improved_checks" : "checks_still_fail";
    return { baseCommit: options.baseCommit, patchSha256, changed, baseline, candidate, verdict, adopted: false };
  } finally {
    if (attached) await git(repo, "worktree", "remove", "--force", safeWorktree);
    if (await access(safeWorktree).then(() => true, () => false)) {
      await rm(await checkedTemporaryPath(safeWorktree), { recursive: true });
    }
  }
}

/** Dockerへ渡す引数。候補の内容をシェル文字列として連結しない。 */
export function dockerRunArgs(options: {
  name: string;
  image: string;
  worktree: string;
  nodeModules: string;
  /** Linuxではホストと同じ非root UID/GIDを使い、0700の一時コピーも読めるようにする。 */
  user?: string;
}): string[] {
  if (!/^origin-agent-check-[a-z0-9-]+$/.test(options.name)) throw new Error("不正なコンテナ名です。");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(options.image)) throw new Error("不正なイメージ名です。");
  if (options.worktree.includes(",") || options.nodeModules.includes(",")) throw new Error("マウント先にカンマを含む場合は評価できません。");
  const user = options.user ?? (process.getuid && process.getgid ? `${process.getuid()}:${process.getgid()}` : "65534:65534");
  if (!/^[1-9]\d*:[1-9]\d*$/.test(user)) throw new Error("隔離評価は非rootユーザー・グループで実行してください。");
  return [
    "run", "--rm", "--name", options.name, "--pull", "never",
    "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--pids-limit", "128",
    "--memory", "3g", "--memory-swap", "3g", "--cpus", "2",
    "--user", user, "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m",
    "--mount", `type=bind,source=${options.worktree},target=/work,readonly`,
    "--mount", `type=bind,source=${options.nodeModules},target=/work/node_modules,readonly`,
    "--workdir", "/work", "--env", "HOME=/tmp", "--env", "TMPDIR=/tmp",
    options.image, "sh", "-c",
    "node --test --test-reporter=tap --test-concurrency=1 test/*.test.ts; tests=$?; " +
    "node node_modules/typescript/bin/tsc --noEmit; types=$?; " +
    `printf '\nORIGIN_CHECK_EXIT %s %s\n' "$tests" "$types"; ` +
    `[ "$tests" -eq 0 ] && [ "$types" -eq 0 ]`,
  ];
}
