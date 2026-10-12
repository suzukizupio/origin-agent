import { createOriginProvider, originHost } from "./origin.ts";
import type { Provider } from "../types.ts";

export const CONVERSATION_MODEL = "unsloth/Qwen3-4B-Instruct-2507-GGUF";
export function conversationHost(): string {
  return originHost(process.env.ORIGIN_CHAT_MODEL_HOST ?? "http://127.0.0.1:18083");
}

/** Reject a question returned with only punctuation or a few characters changed. */
export function isQuestionEcho(question: string, answer: string): boolean {
  if (!/[?？]|何ができ|どうやって|教えて|説明して/.test(question)
    || /そのまま|復唱|繰り返して|引用して/.test(question)) return false;
  const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, "");
  const a = normalize(question), b = normalize(answer);
  if (a.length < 8 || Math.min(a.length, b.length) / Math.max(a.length, b.length) < 0.85) return false;
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1]! + 1, row[j]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]! / Math.max(a.length, b.length) <= 0.15;
}

export function createOriginConversationProvider(opts: { timeZone?: string; now?: () => Date } = {}): Provider {
  const provider = createOriginProvider({ host: conversationHost(), variant: "baseline", conversationOnly: true, ...opts });
  return {
    ...provider,
    name: `origin-chat:${CONVERSATION_MODEL}`,
    async complete(messages, tools, env, callbacks = {}) {
      const question = messages.at(-1)?.content ?? "";
      // Only publish the accepted answer, including when a retry is necessary.
      const stats = { onStats: callbacks.onStats };
      let answer = await provider.complete(messages, tools, env, stats);
      if (isQuestionEcho(question, answer)) {
        answer = await provider.complete([...messages, { role: "assistant", content: answer },
          { role: "user", content: `今の回答は質問の繰り返しです。次の質問への答えを具体的に書いてください。\n${question}` }], tools, env, stats);
        if (isQuestionEcho(question, answer)) throw new Error("モデルが質問を繰り返したため、回答を確定できませんでした。");
      }
      callbacks.onText?.(answer);
      return answer;
    },
  };
}
