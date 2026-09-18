import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSearchResults, webSearchTool } from "../src/tools/web-search.ts";
import { fetchWebPage, htmlToText, readWebText, webFetchTool } from "../src/tools/web.ts";
import type { ToolContext } from "../src/types.ts";

const ctx: ToolContext = { root: process.cwd(), confirm: async () => true };
const fixture = `<h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.typescriptlang.org%2Fdocs%2F&amp;rut=abc">TypeScript &amp; JavaScript</a></h2>
<div class="result__extras"><div><a class="result__url" href="https://www.typescriptlang.org/docs/">公式</a></div></div>
<a class="result__snippet" href="https://www.typescriptlang.org/docs/">型を持つ <b>JavaScript</b>。</a>
<a class='result__a' href='https://example.com/guide'>Guide</a><div class='result__snippet'>説明&#x3002;</div>`;

test("web_search: リダイレクトURLを解決し、タイトルと対応する抜粋を取り出す", () => {
  assert.deepEqual(parseSearchResults(fixture), [
    { title: "TypeScript & JavaScript", url: "https://www.typescriptlang.org/docs/", snippet: "型を持つ JavaScript 。" },
    { title: "Guide", url: "https://example.com/guide", snippet: "説明。" },
  ]);
});

test("web_search: 不正なURLと重複を除き、上限件数まで返す", () => {
  const bad = `<a class="result__a" href="javascript:alert(1)">bad</a><a class="result__a" href="https://user:pass@example.com/">credentials</a>`;
  assert.equal(parseSearchResults(bad + fixture + fixture).length, 2);
  assert.equal(parseSearchResults(fixture, 1).length, 1);
});

test("web_search: 拒否された場合と引数が不正な場合には通信しない", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => { throw new Error("通信してはいけない"); });
  const result = await webSearchTool.run({ query: "AI" }, { ...ctx, confirm: async () => false });
  assert.match(result, /実行していません/);
  await assert.rejects(() => webSearchTool.run({ query: " " }, ctx), /query/);
  await assert.rejects(() => webSearchTool.run({ query: "AI", limit: 99 }, ctx), /limit/);
  assert.equal(mock.mock.callCount(), 0);
});

test("web_search: 日本語の検索語を送信し、参照元を返す", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, "html.duckduckgo.com");
    assert.equal(url.searchParams.get("q"), "型とは & 入門");
    return new Response(fixture);
  });
  const result = await webSearchTool.run({ query: "型とは & 入門" }, ctx);
  assert.match(result, /https:\/\/www.typescriptlang.org\/docs\//);
  assert.match(result, /検索結果の抜粋/);
});

test("web_search: 認証画面、HTTPエラー、形式変更を成功として扱わない", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => new Response('<form id="challenge-form">captcha</form>', { status: 202 }));
  await assert.rejects(() => webSearchTool.run({ query: "AI" }, ctx), /認証画面/);
  mock.mock.mockImplementation(async () => new Response("busy", { status: 429 }));
  await assert.rejects(() => webSearchTool.run({ query: "AI" }, ctx), /HTTP 429/);
  mock.mock.mockImplementation(async () => new Response("<html>unknown layout</html>"));
  await assert.rejects(() => webSearchTool.run({ query: "AI" }, ctx), /読み取れません/);
  mock.mock.mockImplementation(async () => new Response('<div class="no-results">No results found</div>'));
  assert.match(await webSearchTool.run({ query: "AI" }, ctx), /一致する検索結果はありません/);
});

test("web_fetch: HTTP失敗や巨大なページを正常な資料として返さない", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("not found", { status: 404 }));
  await assert.rejects(() => webFetchTool.run({ url: "https://example.com" }, ctx), /HTTP 404/);
  await assert.rejects(() => readWebText(new Response("x".repeat(2_000_001))), /大きすぎ/);
  assert.doesNotThrow(() => htmlToText("&#99999999; &#xFFFFFF;"));
});

test("web: 一時的な接続切断は1回だけ再試行し、HTTPエラーは再試行しない", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => { throw new TypeError("fetch failed"); });
  await assert.rejects(() => fetchWebPage(new URL("https://example.com")), /接続失敗/);
  assert.equal(mock.mock.callCount(), 2);
  mock.mock.mockImplementation(async () => new Response("busy", { status: 429 }));
  assert.equal((await fetchWebPage(new URL("https://example.com"))).status, 429);
  assert.equal(mock.mock.callCount(), 3);
});
