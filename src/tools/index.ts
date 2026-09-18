import { readFileTool, listFilesTool, writeFileTool } from "./fs.ts";
import { searchTool } from "./search.ts";
import { editFileTool, replaceLinesTool } from "./edit.ts";
import { editJsonTool } from "./json.ts";
import { runShellTool } from "./shell.ts";
import { webFetchTool } from "./web.ts";
import { webSearchTool } from "./web-search.ts";
import type { Tool } from "../types.ts";

/**
 * ここに足すだけでエージェントの能力が増える。「賢くする」の主戦場その1。
 * 並び順はそのままシステムプロンプトでの提示順になるので、
 * 「まず探す → 読む → 直す」という使ってほしい順に並べてある。
 */
export const allTools: Tool[] = [
  listFilesTool,
  searchTool,
  readFileTool,
  editJsonTool,
  editFileTool,
  replaceLinesTool,
  writeFileTool,
  runShellTool,
  webFetchTool,
  webSearchTool,
];
