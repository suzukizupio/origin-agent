import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { Agent } from "../src/agent.ts";
import { Assistant } from "../src/assistant.ts";
import { LearningStore } from "../src/learning.ts";
import { isReplyRewrite, researchRoute } from "../src/routing.ts";
import { formatToolCall } from "../src/protocol.ts";
import type { AgentEvent, Provider, Tool } from "../src/types.ts";
import { temporaryDirectory } from "./helpers.ts";

const unused: Provider = { name: "unused", complete: async () => { throw new Error("モデルは使わない"); } };
function session(directory: string, provider = unused, tools: Tool[] = []) {
  return new Assistant(new Agent({ provider, tools, mode: "chat", ctx: { root: directory, confirm: async () => true } }), new LearningStore(directory));
}
async function ask(assistant: Assistant, input: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  await assistant.run(input, (e) => events.push(e));
  return events;
}
const output = (events: AgentEvent[]) => events.filter((e): e is Extract<AgentEvent, { type: "assistant" }> => e.type === "assistant").map((e) => e.text).join("\n");

test("assistant: 名前が未登録なら捏造せず、自然な指示で保存・再起動・削除できる", async (t) => {
  const directory = await temporaryDirectory(t);
  const first = session(directory);
  assert.match(output(await ask(first, "私の名前は何ですか？")), /分かりません/);
  await ask(first, "私のことはハルと呼んで。覚えておいて。");
  const next = session(directory);
  assert.match(output(await ask(next, "私の名前は何でしたか？")), /ハル/);
  await ask(next, "/remember 名前 ソラ");
  assert.match(output(await ask(next, "私の名前は何ですか？")), /ソラ/);
  await ask(next, "名前を忘れて");
  assert.match(output(await ask(session(directory), "私の名前は何ですか？")), /分かりません/);
});

test("assistant: 普通の自己紹介は会話中だけ参照し、勝手に永続保存しない", async (t) => {
  const directory = await temporaryDirectory(t);
  const first = session(directory, { name: "test", complete: async () => "こんにちは" });
  await ask(first, "私の名前はハルです。");
  assert.match(output(await ask(first, "私の名前は何でしたか？")), /ハル/);
  assert.equal((await new LearningStore(directory).read()).memories.length, 0);
  assert.match(output(await ask(session(directory), "私の名前は何ですか？")), /分かりません/);
});

test("assistant: 保存した好みと、直前の回答に付けた感想を次の関連質問へ渡す", async (t) => {
  const directory = await temporaryDirectory(t);
  let context = "";
  const assistant = session(directory, { name: "test", complete: async (_messages, _tools, env) => { context = env.knowledge ?? ""; return "TypeScriptの説明"; } });
  await ask(assistant, "/remember 話し方 短く答えて");
  await ask(assistant, "TypeScriptとは");
  assert.match(context, /短く答えて/);
  await ask(assistant, "/feedback bad 具体例を一つ添えてほしい");
  assistant.reset();
  const events = await ask(assistant, "TypeScriptを説明して");
  assert.match(context, /具体例/);
  assert.ok(events.some((e) => e.type === "notice" && /感想 1 件/.test(e.message)));
  const feedback = (await new LearningStore(directory).read()).feedback[0]!;
  assert.equal(feedback.question, "TypeScriptとは");
  assert.equal(feedback.answer, "TypeScriptの説明");
});

test("research: 時刻表や地名の普通の質問でも、モデルより先に検索する", async (t) => {
  const directory = await temporaryDirectory(t);
  const order: string[] = [];
  const search: Tool = { name: "web_search", description: "test", params: [], run: async (args) => { order.push("search"); assert.match(String(args.query), /みらい平駅/); return "URL: https://example.com/station\n平日と休日、方面で時刻表が分かれます。"; } };
  const assistant = session(directory, { name: "test", complete: async (_messages, _tools, env) => { assert.equal(env.research, true); order.push("answer"); return "どちら方面の時刻表ですか？"; } }, [search]);
  const events = await ask(assistant, "みらい平駅の時刻表を教えてください。");
  assert.deepEqual(order, ["search", "answer"]);
  assert.match(output(events), /https:\/\/example.com\/station/);
  assert.equal(researchRoute("つくばみらい市ってどこですか？", "chat").firstCall?.name, "web_search");
  assert.equal(researchRoute("松本市は何県ですか？", "chat").firstCall?.name, "web_search");
});

test("research: 検索の失敗を、モデルの推測で埋めない", async (t) => {
  const directory = await temporaryDirectory(t);
  const search: Tool = { name: "web_search", description: "test", params: [], run: async () => { throw new Error("接続失敗"); } };
  assert.match(output(await ask(session(directory, unused, [search]), "今日の東京の天気を教えて")), /調べられませんでした/);
});

test("research: 拒否された検索を再実行しない", async (t) => {
  const directory = await temporaryDirectory(t);
  let calls = 0;
  const search: Tool = { name: "web_search", description: "test", params: [], run: async (_args, ctx) => { calls++; await ctx.confirm("検索しますか"); return "ユーザーが検索を拒否しました。"; } };
  const assistant = session(directory, unused, [search]);
  assistant.agent.ctx.confirm = async () => false;
  assert.match(output(await ask(assistant, "今日の天気を教えて")), /拒否/);
  assert.equal(calls, 1);
});

test("research: オフライン指定ではモデルが検索を要求しても実行しない", async (t) => {
  const directory = await temporaryDirectory(t);
  let calls = 0;
  const search: Tool = { name: "web_search", description: "test", params: [], run: async () => { calls++; return "結果"; } };
  const provider: Provider = { name: "test", complete: async (messages) => messages.at(-1)?.role === "tool" ? "検索せず回答します" : formatToolCall("web_search", { query: "天気" }) };
  await ask(session(directory, provider, [search]), "検索しないで、天気の仕組みを教えて");
  assert.equal(calls, 0);
  assert.equal(researchRoute("時刻表を表示するコードを書いて", "code").firstCall, undefined);
  assert.equal(researchRoute("天気とは何ですか？", "chat").firstCall, undefined);
  assert.equal(researchRoute("こんにちは", "chat").firstCall, undefined);
});

test("CLI: 別プロセスで記憶を再利用し、削除後は忘れる", async (t) => {
  const directory = await temporaryDirectory(t);
  const run = (input: string) => {
    const result = spawnSync(process.execPath, [resolve("src/cli.ts"), "--provider", "rule", "--data-dir", directory], { input, encoding: "utf8", timeout: 10_000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  assert.match(run("/remember 呼び方 ハル\n/exit\n"), /保存しました/);
  assert.match(run("私の名前は何ですか？\n/forget 呼び方\n/exit\n"), /ハルさん/);
  assert.match(run("私の名前は何ですか？\n/exit\n"), /分かりません/);
});


test("assistant: 名前への直接回答も次の会話に渡し、reset で消す", async (t) => {
  const directory = await temporaryDirectory(t);
  let calls = 0;
  const assistant = session(directory, { name: "test", complete: async (messages) => {
    calls++;
    assert.deepEqual(messages, [
      { role: "assistant", content: "今はお名前が分かりません。呼んでほしい名前を教えてください。" },
      { role: "user", content: "さっきの返答を短く言い換えて" },
    ]);
    assert.equal(messages.at(-1)?.content, "さっきの返答を短く言い換えて");
    return "まだお名前を知りません。";
  } });
  await ask(assistant, "私の名前は何ですか？");
  assert.equal(calls, 0);
  assert.equal(assistant.agent.messages.length, 2);
  await ask(assistant, "さっきの返答を短く言い換えて");
  assert.equal(calls, 1);
  assert.equal((await assistant.store.read()).memories.length, 0);
  assistant.reset();
  assert.deepEqual(assistant.agent.messages, []);
});

test("assistant: 名前を忘れた後は、直接回答の履歴からも再注入しない", async (t) => {
  const directory = await temporaryDirectory(t);
  const assistant = session(directory, { name: "test", complete: async (messages, _tools, env) => {
    assert.doesNotMatch(JSON.stringify(messages) + env.knowledge, /ハル/);
    return "今は分かりません。";
  } });
  await ask(assistant, "/remember 呼び方 ハル");
  await ask(assistant, "私の名前は何ですか？");
  assert.match(JSON.stringify(assistant.agent.messages), /ハル/);
  await ask(assistant, "/forget 呼び方");
  await ask(assistant, "さっき何と呼びましたか？");
});


test("rewrite: 短縮・整形だけを拾い、新しい対象・調査・条件変更は通常の会話へ残す", () => {
  for (const input of ["それを短くして", "もう少し簡潔にしてください。", "箇条書きにして", "その回答を表にしてください",
    "直前の回答を２行でまとめて", "さっきの返答を短く言い換えて", "もっとわかりやすく説明してください"]) {
    assert.equal(isReplyRewrite(input), true, input);
  }
  for (const input of ["富士山について短く説明して", "それを最新情報で調べ直して", "それを短くして、予算は3000円に変更",
    "それを短くしないで", "次の文章を短くして：資料", "箇条書きにしてから検索して", "それを詳しく説明して",
    "短く答えて。覚えておいて。", "/search それを短くして"]) {
    assert.equal(isReplyRewrite(input), false, input);
  }
});

test("rewrite: 前の回答がない・reset後・コマンド後にはモデルを呼ばず対象を確認する", async (t) => {
  const assistant = session(await temporaryDirectory(t), unused);
  assert.match(output(await ask(assistant, "それを短くして")), /文章を送って/);
  await ask(assistant, "私の名前は何ですか？");
  assistant.reset();
  assert.match(output(await ask(assistant, "箇条書きにして")), /文章を送って/);
  await ask(assistant, "私の名前は何ですか？");
  await ask(assistant, "/memory");
  assert.match(output(await ask(assistant, "それを短くして")), /文章を送って/);
});

test("rewrite: 最新の回答だけを使い、古い条件・保存した記憶・ツールは渡さない", async (t) => {
  const directory = await temporaryDirectory(t);
  let step = 0;
  let searches = 0;
  const search: Tool = { name: "web_search", description: "test", params: [], run: async () => { searches++; return "結果"; } };
  const assistant = session(directory, { name: "test", complete: async (messages, tools, env) => {
    step++;
    if (step === 1) return "予算は5000円ですね。";
    if (step === 2) return "予算は2000円に変更しました。購入はまだしません。";
    if (step === 3) {
      assert.deepEqual(messages, [
        { role: "assistant", content: "予算は2000円に変更しました。購入はまだしません。" },
        { role: "user", content: "それを短くして" },
      ]);
      assert.equal(env.replyRewrite, true);
      assert.equal(env.knowledge, undefined);
      assert.deepEqual(tools, []);
      return "予算2000円、まだ購入しません。";
    }
    if (step === 4) {
      assert.equal(messages[0]?.content, "予算2000円、まだ購入しません。");
      assert.deepEqual(tools, []);
      return "- 予算2000円\n- 未購入";
    }
    assert.equal(env.replyRewrite, false);
    assert.ok(messages.some((m) => m.content === "予算は5000円です"));
    return "別の話に答えます。";
  } }, [search]);
  await assistant.store.remember("話し方", "常に長く答えて");
  await ask(assistant, "予算は5000円です");
  await ask(assistant, "予算を2000円に変更します");
  await ask(assistant, "それを短くして");
  await ask(assistant, "箇条書きにして");
  await ask(assistant, "別の話をしましょう");
  assert.equal(searches, 0);
  assert.equal(step, 5);
});

test("rewrite: 検索回答の出典を含む表示済み本文を渡し、検索の話題は維持する", async (t) => {
  const queries: string[] = [];
  let rewriteSource = "";
  const search: Tool = { name: "web_search", description: "test", params: [], run: async (args) => {
    queries.push(String(args.query));
    return "URL: https://example.com/info\n茨城県の市です。";
  } };
  const assistant = session(await temporaryDirectory(t), { name: "test", complete: async (messages, tools, env) => {
    if (env.replyRewrite) {
      assert.deepEqual(tools, []);
      rewriteSource = messages[0]!.content;
      return "茨城県の市です。[出典](https://example.com/info)";
    }
    return "茨城県の市です。";
  } }, [search]);
  const events = await ask(assistant, "つくばみらい市について教えて");
  await ask(assistant, "それを短くして");
  assert.equal(rewriteSource, output(events));
  assert.match(rewriteSource, /https:\/\/example.com\/info/);
  assert.equal(queries.length, 1);
  await ask(assistant, "人口は？");
  assert.equal(queries.length, 2);
  assert.match(queries[1]!, /つくばみらい市 人口/);
});

test("rewrite: 明示的な調査依頼は通常の検索へ渡す", async (t) => {
  let searches = 0;
  const assistant = session(await temporaryDirectory(t), { name: "test", complete: async () => "説明です。" }, [
    { name: "web_search", description: "test", params: [], run: async () => { searches++; return "URL: https://example.com/info\n資料"; } },
  ]);
  await ask(assistant, "読書について説明して");
  await ask(assistant, "それについてネットで調べて");
  assert.equal(searches, 1);
});

test("rewrite: codeモードの依頼は言い換え専用の処理に切り替えない", async (t) => {
  const assistant = session(await temporaryDirectory(t), { name: "test", complete: async (_messages, _tools, env) => {
    assert.equal(env.replyRewrite, false);
    return "説明です。";
  } });
  assistant.agent.setMode("code");
  await ask(assistant, "それを短くして");
});
