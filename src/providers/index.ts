import { createRuleProvider } from "./rule.ts";
import { createOllamaProvider, DEFAULT_MODEL, installedModels } from "./ollama.ts";
import { createOriginProvider } from "./origin.ts";
import { createClaudeProvider, hasClaudeCredentials } from "./claude.ts";
import type { Provider } from "../types.ts";

export const providerNames = ["rule", "ollama", "origin", "claude"] as const;
export const REPAIR_MODEL = "qwen2.5-coder:7b";

export type ProviderSelection = { provider: Provider; repairProvider?: Provider };

export async function resolveProvider(name: string, model?: string, env: NodeJS.ProcessEnv = process.env): Promise<Provider> {
  return (await resolveProviderSelection(name, model, env)).provider;
}

/**
 * 自動選択。Claude の認証情報が環境変数にあれば Claude を、なければローカルの Ollama を使う。
 * ローカルを選んだときだけ、インストール済みの修正用モデルを併せて用意する。
 */
export async function resolveProviderSelection(name: string, model?: string, env: NodeJS.ProcessEnv = process.env): Promise<ProviderSelection> {
  if (name !== "auto") return { provider: createProvider(name, model) };
  if (model?.startsWith("claude-") || (model === undefined && hasClaudeCredentials(env))) {
    return { provider: createClaudeProvider(model === undefined ? {} : { model }) };
  }
  if (model !== undefined) return { provider: createOllamaProvider({ model }) };
  try {
    const models = await installedModels();
    const selected = models.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : models[0];
    if (selected !== undefined) return {
      provider: createOllamaProvider({ model: selected }),
      repairProvider: models.includes(REPAIR_MODEL) && selected !== REPAIR_MODEL
        ? createOllamaProvider({ model: REPAIR_MODEL }) : undefined,
    };
  } catch {
    // オフラインでも定型応答の入口は使える。CLI で制限を表示する。
  }
  return { provider: createRuleProvider() };
}

/**
 * 頭脳を名前で選ぶ。将来ここに "own"（自作モデル）が並ぶ。
 * エージェント側のコードは一行も変わらない。
 */
export function createProvider(name: string, model?: string): Provider {
  switch (name) {
    case "rule":
      return createRuleProvider();
    case "ollama":
      return createOllamaProvider(model === undefined ? {} : { model });
    case "origin":
      return createOriginProvider(model === undefined ? {} : { variant: model });
    case "claude":
      return createClaudeProvider(model === undefined ? {} : { model });
    default:
      throw new Error(`未知のプロバイダ: ${name}（使えるのは ${providerNames.join(", ")}）`);
  }
}
