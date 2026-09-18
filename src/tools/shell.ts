import { spawn } from "node:child_process";
import type { Tool } from "../types.ts";

const TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 30_000;

function clip(text: string): string {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… 出力が長いため打ち切りました` : text;
}

export const runShellTool: Tool = {
  name: "run_shell",
  description: "シェルコマンドを作業ルートで実行し、標準出力と標準エラーを返す",
  destructive: true,
  params: [{ name: "command", type: "string", required: true, description: "実行するコマンド" }],
  async run(args, ctx) {
    if (typeof args.command !== "string" || args.command.trim() === "") {
      throw new Error("command は必須の文字列です");
    }
    const command = args.command.trim();

    const ok = await ctx.confirm(`コマンドを実行します: ${command}`);
    if (!ok) return "ユーザーが実行を拒否しました。";

    const isWindows = process.platform === "win32";
    const file = isWindows ? "powershell.exe" : "/bin/sh";
    const argv = isWindows ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-c", command];

    return await new Promise<string>((done) => {
      const child = spawn(file, argv, { cwd: ctx.root, windowsHide: true });
      let stdout = "";
      let stderr = "";
      let finished = false;

      const timer = setTimeout(() => {
        child.kill();
        finish(`${TIMEOUT_MS / 1000} 秒を超えたため中断しました。\n${stdout}${stderr}`);
      }, TIMEOUT_MS);

      function finish(text: string): void {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        done(clip(text));
      }

      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.on("error", (e: Error) => finish(`起動に失敗しました: ${e.message}`));
      child.on("close", (code) => {
        const parts = [`(終了コード ${code})`];
        if (stdout.trim()) parts.push(`--- stdout ---\n${stdout.trim()}`);
        if (stderr.trim()) parts.push(`--- stderr ---\n${stderr.trim()}`);
        if (!stdout.trim() && !stderr.trim()) parts.push("(出力なし)");
        finish(parts.join("\n"));
      });
    });
  },
};
