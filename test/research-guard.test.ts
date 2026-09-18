// 調べものの途中で、頭脳が URL を捏造したり、同じページを取り直し続けたりしたときの関門。
// 台本どおりに動く偽の頭脳で、実機（qwen2.5-coder:3b）で観測した行動をそのまま再現する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../src/agent.ts";
import { Assistant } from "../src/assistant.ts";
import { LearningStore } from "../src/learning.ts";
import { formatToolCall } from "../src/protocol.ts";
import type { AgentEvent, Provider, Tool } from "../src/types.ts";
import { temporaryDirectory } from "./helpers.ts";

const OFFICIAL = "https://www.city.example.lg.jp/gyousei/shoukai/page002206.html";

/** 台本の順に返す頭脳。台本が尽きたら失敗させる */
function scripted(lines: string[]): Provider & { calls: number } {
  const provider = {
    name: "scripted",
    calls: 0,
    complete: async () => {
      const line = lines[provider.calls++];
      if (line === undefined) throw new Error("台本が尽きました");
      return line;
    },
  };
  return provider;
}

function webTools(fetchLog: string[], failing: string[] = []): Tool[] {
  const search: Tool = {
    name: "web_search",
    description: "test",
    params: [],
    run: async () => `以下は検索結果の抜粋です。\n1. 市の概要 | 公式ホームページ\nURL: ${OFFICIAL}\n`,
  };
  const fetch: Tool = {
    name: "web_fetch",
    description: "test",
    params: [],
    run: async (args) => {
      const url = String(args.url);
      fetchLog.push(url);
      if (failing.includes(url)) throw new Error(`HTTP 404 （${url}）。本文は取得できませんでした。`);
      return `市の概要 | 公式ホームページ\n${url}\n\n[Webページの参考資料]\n当市は茨城県の南西部、東京都心から40Km圏に位置しています。`;
    },
  };
  return [search, fetch];
}

async function ask(provider: Provider, tools: Tool[], directory: string, input: string) {
  const agent = new Agent({ provider, tools, mode: "chat", maxSteps: 8, ctx: { root: directory, confirm: async () => true } });
  const events: AgentEvent[] = [];
  await new Assistant(agent, new LearningStore(directory)).run(input, (e) => events.push(e));
  const answer = events.filter((e): e is Extract<AgentEvent, { type: "assistant" }> => e.type === "assistant").at(-1)?.text ?? "";
  return { events, answer };
}

test("research: 検索結果に無いURLを作って取りに行っても、実行せずに取得済みの本文から答えさせる", async (t) => {
  const directory = await temporaryDirectory(t);
  const fetchLog: string[] = [];
  const brain = scripted([
    // 実機で出た行動: 公式ページを読んだ後、番号だけ変えた実在しないURLを取りに行く
    formatToolCall("web_fetch", { url: "https://www.city.example.lg.jp/gyousei/shoukai/page002415.html" }),
    `茨城県の南西部にある市です。[市の概要](${OFFICIAL})`,
  ]);

  const { events, answer } = await ask(brain, webTools(fetchLog), directory, "つくばみらい市ってどんな場所？");

  assert.deepEqual(fetchLog, [OFFICIAL], "捏造したURLへは通信しないこと");
  const refused = events.find((e) => e.type === "tool_end" && e.name === "web_fetch" && !e.ok);
  assert.match(refused?.type === "tool_end" ? refused.result : "", /検索結果にも依頼文にもありません/);
  assert.match(answer, /茨城県/);
  assert.doesNotMatch(answer, /調べられませんでした/);
});

test("research: 取得済みのページを取り直させず、その本文から答えさせる", async (t) => {
  const directory = await temporaryDirectory(t);
  const fetchLog: string[] = [];
  const brain = scripted([
    // 実機で出た行動: 同じページを max_chars だけ変えて取り直す
    formatToolCall("web_fetch", { url: OFFICIAL, max_chars: 8000 }),
    `茨城県の南西部にある市です。[市の概要](${OFFICIAL})`,
  ]);

  const { events, answer } = await ask(brain, webTools(fetchLog), directory, "つくばみらい市ってどんな場所？");

  assert.equal(fetchLog.length, 1, "同じページへの通信は1回だけ");
  const refused = events.find((e) => e.type === "tool_end" && e.name === "web_fetch" && !e.ok);
  assert.match(refused?.type === "tool_end" ? refused.result : "", /取得済みです/);
  assert.match(answer, /茨城県/);
});

test("research: 本文を読めた後の取得失敗で、読めた資料を捨てない", async (t) => {
  const directory = await temporaryDirectory(t);
  const fetchLog: string[] = [];
  const second = "https://www.city.example.lg.jp/other.html";
  const tools = webTools(fetchLog, [second]);
  // 検索結果に2件目も載せ、関門を通ったうえで本当に404になる状況を作る
  tools[0] = { ...tools[0]!, run: async () => `1. 市の概要\nURL: ${OFFICIAL}\n2. その他\nURL: ${second}\n` };
  const brain = scripted([
    formatToolCall("web_fetch", { url: second }),
    `茨城県の南西部にある市です。[市の概要](${OFFICIAL})`,
  ]);

  const { answer } = await ask(brain, tools, directory, "つくばみらい市ってどんな場所？");

  assert.deepEqual(fetchLog, [OFFICIAL, second]);
  assert.match(answer, /茨城県/);
  assert.doesNotMatch(answer, /調べられませんでした/);
});

test("research: 何も読めていないときの取得失敗は、従来どおり推測で埋めずに打ち切る", async (t) => {
  const directory = await temporaryDirectory(t);
  const fetchLog: string[] = [];
  const brain = scripted([]); // 頭脳は呼ばれないはず
  const { answer } = await ask(brain, webTools(fetchLog, [OFFICIAL]), directory, "つくばみらい市ってどんな場所？");

  assert.match(answer, /調べられませんでした/);
  assert.equal(brain.calls, 0);
});
