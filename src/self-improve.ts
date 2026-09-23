// 無人の自己改修で使う道具の境界。モデルは隔離したコピーの src/ だけを編集できる。
// 候補コードの実行・採点・採用はこのモジュールでは行わない。

import { isAbsolute } from "node:path";
import { Agent } from "./agent.ts";
import { editFileTool, replaceLinesTool } from "./tools/edit.ts";
import { readFileTool, listFilesTool } from "./tools/fs.ts";
import { searchTool } from "./tools/search.ts";
import type { AgentEvent, Provider, Tool } from "./types.ts";

export function isEditableSourcePath(path: unknown): path is string {
  if (typeof path !== "string" || path.includes("\0") || isAbsolute(path)) return false;
  const parts = path.replaceAll("\\", "/").split("/");
  return parts.length >= 2 && parts[0] === "src"
    && parts.every((part) => part !== "" && part !== "." && part !== "..");
}

function sourceOnly(tool: Tool): Tool {
  return {
    ...tool,
    async run(args, ctx) {
      if (!isEditableSourcePath(args.path)) {
        throw new Error("自己改修の候補では src/ 内の既存ファイルだけを編集できます。テスト・採点器・設定は変更できません。");
      }
      return await tool.run(args, ctx);
    },
  };
}

export const proposalTools: Tool[] = [
  listFilesTool,
  searchTool,
  readFileTool,
  sourceOnly(editFileTool),
  sourceOnly(replaceLinesTool),
];

export async function proposeSelfChange(
  root: string,
  goal: string,
  provider: Provider,
  emit: (event: AgentEvent) => void,
): Promise<void> {
  const agent = new Agent({
    provider,
    tools: proposalTools,
    mode: "code",
    maxSteps: 12,
    ctx: { root, confirm: async () => true },
  });
  await agent.run([
    "これは origin-agent の使い捨て作業コピーです。次の問題を一般的に改善する小さな修正案を作ってください。",
    goal,
    "実物を読んでから src/ 内の既存ファイルだけを編集してください。テストや採点器は変更しません。",
    "シェルとネット接続は使えません。変更できなければ理由を答えてください。",
  ].join("\n\n"), emit);
}
