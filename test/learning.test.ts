import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LearningStore } from "../src/learning.ts";
import { temporaryDirectory } from "./helpers.ts";

test("memory: 再作成したストアでも保存内容を読み、同じ項目は更新できる", async (t) => {
  const directory = await temporaryDirectory(t);
  await new LearningStore(directory).remember("名前", "ハル");
  const reopened = new LearningStore(directory);
  assert.deepEqual((await reopened.read()).memories.map(({ key, value }) => ({ key, value })), [{ key: "呼び方", value: "ハル" }]);
  await reopened.remember("呼び方", "ソラ");
  assert.deepEqual((await new LearningStore(directory).read()).memories.map((m) => m.value), ["ソラ"]);
});

test("memory: 別インスタンスの同時保存でも片方の更新を失わない", async (t) => {
  const directory = await temporaryDirectory(t);
  await Promise.all([
    new LearningStore(directory).remember("呼び方", "ハル"),
    new LearningStore(directory).remember("話し方", "簡潔に"),
  ]);
  assert.equal((await new LearningStore(directory).read()).memories.length, 2);
});

test("memory: 壊れたファイルを空の記憶として上書きしない", async (t) => {
  const directory = await temporaryDirectory(t);
  const file = join(directory, "learning.json");
  await writeFile(file, '{"version":1,"memories":');
  await assert.rejects(() => new LearningStore(directory).remember("名前", "ハル"), /上書きしていません/);
  assert.equal(await readFile(file, "utf8"), '{"version":1,"memories":');
});

test("feedback: 関連する指摘だけを読み戻し、以前の誤答はモデルへ渡さない", async (t) => {
  const store = new LearningStore(await temporaryDirectory(t));
  await store.addFeedback({ question: "TypeScriptとは", answer: "これは誤った回答", rating: "bad", note: "短く、具体例を1つ添えてほしい", provider: "test", mode: "chat" });
  const related = await store.context("TypeScriptを説明して", "chat");
  assert.equal(related.feedbackCount, 1);
  assert.match(related.text, /具体例/);
  assert.doesNotMatch(related.text, /これは誤った回答/);
  assert.equal((await store.context("Pythonとは", "chat")).feedbackCount, 0);
  assert.equal((await store.context("TypeScriptとは", "code")).feedbackCount, 0);
});

test("memory: 忘れた内容を含む過去の感想も消し、他の記憶は残す", async (t) => {
  const directory = await temporaryDirectory(t);
  const store = new LearningStore(directory);
  await store.remember("名前", "ハル");
  await store.remember("話し方", "短く答える");
  await store.addFeedback({ question: "私の名前は？", answer: "ハルさんです", rating: "good", note: "覚えていた", provider: "test", mode: "chat" });
  assert.equal(await store.forget("名前"), true);
  assert.doesNotMatch(await readFile(join(directory, "learning.json"), "utf8"), /ハル/);
  assert.equal((await store.read()).memories[0]?.key, "話し方");
});

test("feedback: IDを指定して削除した感想は次の回答へ渡らない", async (t) => {
  const store = new LearningStore(await temporaryDirectory(t));
  const item = await store.addFeedback({ question: "JavaScriptとは", answer: "説明", rating: "bad", note: "簡単にして", provider: "test", mode: "chat" });
  assert.equal(await store.deleteFeedback(item.id), true);
  assert.equal((await store.context("JavaScriptとは", "chat")).feedbackCount, 0);
});
