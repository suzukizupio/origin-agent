import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { dockerRunArgs, evaluatePatch } from "../src/sandbox-eval.ts";
import type { SandboxResult } from "../src/sandbox-eval.ts";
import { temporaryDirectory } from "./helpers.ts";

const runFile = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await runFile("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return stdout.trim();
}

async function fixture(t: Parameters<typeof temporaryDirectory>[0]): Promise<{ root: string; baseCommit: string }> {
  const root = await temporaryDirectory(t);
  await mkdir(join(root, "src"));
  await mkdir(join(root, "test"));
  await writeFile(join(root, "src", "a.js"), "export const value = 1;\n");
  await writeFile(join(root, "test", "a.test.js"), "const expected = 2;\n");
  await git(root, "init");
  await git(root, "add", ".");
  await git(root, "-c", "user.name=Origin Test", "-c", "user.email=origin@example.invalid", "commit", "-m", "base");
  return { root, baseCommit: await git(root, "rev-parse", "HEAD") };
}

function result(ok: boolean): SandboxResult {
  return { ok, exitCode: ok ? 0 : 1, timedOut: false, stdout: ok ? "pass" : "fail", stderr: "" };
}

test("候補を一時作業コピーで比較し、元の作業ツリーを変更しない", async (t) => {
  const { root, baseCommit } = await fixture(t);
  await writeFile(join(root, "src", "a.js"), "export const value = 2;\n");
  const patchPath = join(root, "candidate.patch");
  await writeFile(patchPath, `${await git(root, "diff", "--binary")}\n`);
  await git(root, "restore", "src/a.js");
  const phases: string[] = [];
  const report = await evaluatePatch({
    repo: root, patchPath, baseCommit,
    runSandbox: async (worktree, phase) => {
      phases.push(phase);
      return result((await readFile(join(worktree, "src", "a.js"), "utf8")).includes("value = 2"));
    },
  });
  assert.deepEqual(phases, ["baseline", "candidate"]);
  assert.equal(report.verdict, "improved_checks");
  assert.deepEqual(report.changed, ["src/a.js"]);
  assert.equal(report.adopted, false);
  assert.equal((await readFile(join(root, "src", "a.js"), "utf8")).replaceAll("\r\n", "\n"), "export const value = 1;\n");
  assert.equal((await git(root, "worktree", "list", "--porcelain")).match(/^worktree /gm)?.length, 1);
});

test("テストファイルを変更するパッチは候補として実行しない", async (t) => {
  const { root, baseCommit } = await fixture(t);
  await writeFile(join(root, "test", "a.test.js"), "const expected = 1;\n");
  const patchPath = join(root, "bad.patch");
  await writeFile(patchPath, `${await git(root, "diff", "--binary")}\n`);
  await git(root, "restore", "test/a.test.js");
  const phases: string[] = [];
  await assert.rejects(() => evaluatePatch({
    repo: root, patchPath, baseCommit,
    runSandbox: async (_worktree, phase) => { phases.push(phase); return result(true); },
  }), /src\/ の既存ファイル/);
  assert.deepEqual(phases, ["baseline"]);
  assert.equal((await git(root, "worktree", "list", "--porcelain")).match(/^worktree /gm)?.length, 1);
});

test("Docker起動引数はネットワーク・書き込み・権限を制限する", () => {
  const args = dockerRunArgs({ name: "origin-agent-check-test", image: "node:24-bookworm", worktree: "/tmp/work", nodeModules: "/tmp/modules" });
  assert.deepEqual(args.slice(0, 2), ["run", "--rm"]);
  for (const flag of ["--pull", "--network", "--read-only", "--cap-drop", "--security-opt", "--pids-limit", "--memory", "--cpus", "--user", "--tmpfs"]) {
    assert.ok(args.includes(flag), flag);
  }
  assert.equal(args[args.indexOf("--pull") + 1], "never");
  assert.equal(args[args.indexOf("--network") + 1], "none");
  assert.equal(args[args.indexOf("--user") + 1], "65534:65534");
  assert.ok(args.filter((value) => value === "--mount").length === 2);
  assert.ok(args.includes("type=bind,source=/tmp/work,target=/work,readonly"));
  assert.throws(() => dockerRunArgs({ name: "bad name", image: "node:24", worktree: "/tmp", nodeModules: "/tmp/modules" }));
});
