// 保存済みの自己改修案を、ローカルDocker内の固定テストで比較する。
// Dockerが使えない場合は候補コードを実行せずに終了する。

import { execFile } from "node:child_process";
import { access, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { dockerRunArgs, evaluatePatch, parseCheckSummary } from "../src/sandbox-eval.ts";
import type { SandboxResult } from "../src/sandbox-eval.ts";

const runFile = promisify(execFile);
const IMAGE = "node:24-bookworm";
const MAX_OUTPUT = 2_000_000;
const CHECK_TIMEOUT_MS = 5 * 60_000;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await runFile("git", args, { cwd, encoding: "utf8", timeout: 30_000, windowsHide: true });
  return stdout.trim();
}

function usage(): never {
  console.log("使い方: node scripts/evaluate-proposal.ts --patch .origin-agent/proposals/<name>.patch");
  console.log(`ローカルDockerイメージ ${IMAGE} が必要です。ネットワークからの取得や修正案の適用は行いません。`);
  process.exit(0);
}

async function dockerPreflight(): Promise<string> {
  try {
    const { stdout: serverOs } = await runFile("docker", ["version", "--format", "{{.Server.Os}}"], {
      encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    if (serverOs.trim() !== "linux") throw new Error("Linuxコンテナが必要です。");
    const { stdout } = await runFile("docker", ["image", "inspect", "--format", "{{.Id}}", IMAGE], {
      encoding: "utf8", timeout: 10_000, windowsHide: true, maxBuffer: 1_000_000,
    });
    const imageId = stdout.trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error("イメージIDを確認できません。");
    return imageId;
  } catch {
    throw new Error(`Linux版Dockerまたはローカルイメージ ${IMAGE} が利用できません。Dockerを起動し、事前にイメージを用意してください。候補コードは実行していません。`);
  }
}

async function sandboxRun(worktree: string, nodeModules: string, imageId: string): Promise<SandboxResult> {
  const name = `origin-agent-check-${randomUUID()}`;
  const args = dockerRunArgs({ name, image: imageId, worktree, nodeModules });
  try {
    const { stdout, stderr } = await runFile("docker", args, {
      encoding: "utf8", timeout: CHECK_TIMEOUT_MS, maxBuffer: MAX_OUTPUT, windowsHide: true,
    });
    return { ok: true, exitCode: 0, timedOut: false, stdout, stderr, checks: parseCheckSummary(stdout) };
  } catch (error) {
    const failure = error as Error & { code?: number | string; killed?: boolean; stdout?: string; stderr?: string };
    if (failure.killed || failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      // 子プロセスの停止後もコンテナが残る場合があるため、同じ固定名だけを片付ける。
      await runFile("docker", ["rm", "-f", name], { timeout: 10_000, windowsHide: true }).catch(() => undefined);
      throw new Error("隔離テストが時間または出力の上限に達しました。評価を中止します。");
    }
    if (typeof failure.code !== "number" || failure.code >= 125) {
      throw new Error(`Dockerによる隔離テストを実行できませんでした: ${failure.message}`);
    }
    return {
      ok: false, exitCode: failure.code, timedOut: false,
      stdout: failure.stdout ?? "", stderr: failure.stderr ?? "",
      checks: parseCheckSummary(failure.stdout ?? ""),
    };
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") usage();
  if (args.length !== 2 || args[0] !== "--patch") throw new Error("--patch <保存済み.patch> を指定してください。");
  const repo = await realpath(await git(process.cwd(), "rev-parse", "--show-toplevel"));
  const proposalDir = join(repo, ".origin-agent", "proposals");
  const patchPath = await realpath(resolve(args[1]!));
  const inside = relative(await realpath(proposalDir), patchPath);
  if (!inside || inside.startsWith("..") || inside.includes(sep) || !basename(patchPath).endsWith(".patch")) {
    throw new Error(".origin-agent/proposals/ 直下の保存済み.patchを指定してください。");
  }
  const reportPath = join(dirname(patchPath), `${basename(patchPath, ".patch")}.json`);
  const metadata = JSON.parse(await readFile(reportPath, "utf8")) as { status?: unknown; baseCommit?: unknown };
  if (metadata.status !== "未検証" || typeof metadata.baseCommit !== "string") {
    throw new Error("未検証の修正案と、生成時のbaseCommitが必要です。古い修正案は再生成してください。");
  }
  const nodeModules = await realpath(join(repo, "node_modules"));
  await access(join(nodeModules, "typescript", "bin", "tsc"));
  if (nodeModules.includes(",")) throw new Error("依存ライブラリのパスにカンマを含む場合は評価できません。");
  const imageId = await dockerPreflight();
  console.log(`基準版 ${metadata.baseCommit} と候補をローカルDocker内で検査します。`);
  const evaluation = await evaluatePatch({
    repo, patchPath, baseCommit: metadata.baseCommit,
    runSandbox: (worktree) => sandboxRun(worktree, nodeModules, imageId),
  });
  const resultPath = join(dirname(patchPath), `${basename(patchPath, ".patch")}.evaluation.json`);
  await writeFile(resultPath, `${JSON.stringify({ ...evaluation, imageId }, null, 2)}\n`, "utf8");
  console.log(`結果: ${evaluation.verdict}。記録: ${resultPath}`);
  console.log("パッチは元の作業場所に適用していません。");
  if (evaluation.verdict === "invalid_checks") {
    console.error("テスト未完了・件数不一致・スキップ等のため、改善とは判定できません。記録を確認してください。");
    process.exitCode = 1;
  }
}

await main().catch((error: unknown) => {
  console.error(`エラー: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
