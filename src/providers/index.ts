import { createRuleProvider } from "./rule.ts";
import { createOllamaProvider, DEFAULT_MODEL, installedModels } from "./ollama.ts";
import type { Provider } from "../types.ts";

export const providerNames = ["rule", "ollama"] as const;

export async function resolveProvider(name: string, model?: string): Promise<Provider> {
  if (name !== "auto") return createProvider(name, model);
  if (model !== undefined) return createOllamaProvider({ model });
  try {
    const models = await installedModels();
    const selected = models.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : models[0];
    if (selected !== undefined) return createOllamaProvider({ model: selected });
  } catch {
    // オフラインでも定型応答の入口は使える。CLI で制限を表示する。
  }
  return createRuleProvider();
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
    default:
      throw new Error(`未知のプロバイダ: ${name}（使えるのは ${providerNames.join(", ")}）`);
  }
}
