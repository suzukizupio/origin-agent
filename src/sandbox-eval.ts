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
};

export type EvaluationReport = {
  baseCommit: string;
  patchSha256: string;
  changed: string[];
  baseline: SandboxResult;
  candidate: SandboxResult;
  verdict: "improved_checks" | "checks_pass_no_gain_measured" | "regression" | "checks_still_fail";
  adopted: false;
};

export type SandboxRunner = (worktree: string, phase: "baseline" | "candidate") => Promise<SandboxResult>;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await runFile("git", args, {
    cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 8_000_000, windowsHide: true,
  });
  return stdout;
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
    await git(safeWorktree, "apply", "--check", "--index", "--", patchPath);
    const baseline = await options.runSandbox(safeWorktree, "baseline");
    if ((await git(safeWorktree, "status", "--porcelain")).trim()) {
      throw new Error("基準側の検査で作業コピーが変更されました。結果を採用しません。");
    }
    await git(safeWorktree, "apply", "--index", "--", patchPath);
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
    const candidate = await options.runSandbox(safeWorktree, "candidate");
    const verdict = baseline.ok
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
}): string[] {
  if (!/^origin-agent-check-[a-z0-9-]+$/.test(options.name)) throw new Error("不正なコンテナ名です。");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(options.image)) throw new Error("不正なイメージ名です。");
  if (options.worktree.includes(",") || options.nodeModules.includes(",")) throw new Error("マウント先にカンマを含む場合は評価できません。");
  return [
    "run", "--rm", "--name", options.name, "--pull", "never",
    "--network", "none", "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--pids-limit", "128",
    "--memory", "3g", "--memory-swap", "3g", "--cpus", "2",
    "--user", "65534:65534", "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m",
    "--mount", `type=bind,source=${options.worktree},target=/work,readonly`,
    "--mount", `type=bind,source=${options.nodeModules},target=/work/node_modules,readonly`,
    "--workdir", "/work", "--env", "HOME=/tmp", "--env", "TMPDIR=/tmp",
    options.image, "sh", "-c",
    "node --test --test-concurrency=1 test/*.test.ts && node node_modules/typescript/bin/tsc --noEmit",
  ];
}
