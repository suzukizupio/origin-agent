// 「検索に回すか」の判定が、言い換えに対して退行していないかを普段のテストで確かめる。
//
// ここで使うのは tune だけ。holdout は判定を直し終わったときに
// `npm run eval:route -- --holdout` で1回だけ見るためのものなので、テストには入れない。

import { test } from "node:test";
import assert from "node:assert/strict";
import { researchRoute } from "../src/routing.ts";
import { tune } from "../scripts/route-cases.ts";

for (const item of tune) {
  test(`routing[${item.mode}]: ${item.input} → ${item.expect === "search" ? "検索する" : "検索しない"}`, () => {
    const route = researchRoute(item.input, item.mode);
    if (item.expect === "direct") {
      assert.equal(route.firstCall, undefined, `検索語: ${String(route.firstCall?.args.query ?? "")}`);
      return;
    }
    assert.ok(route.firstCall !== undefined, "検索に回っていない（モデルの記憶で答えてしまう）");
    if (item.queryIncludes !== undefined) {
      const query = String(route.firstCall.args.query ?? route.firstCall.args.url ?? "");
      assert.ok(query.includes(item.queryIncludes), `検索語「${query}」に「${item.queryIncludes}」が入っていない`);
    }
  });
}

test("routing: 検索しないでと言われたら、事実の質問でもネットを使わない", () => {
  const route = researchRoute("検索しないで、富士山の高さを教えて", "chat");
  assert.equal(route.allowWeb, false);
  assert.equal(route.firstCall, undefined);
});

test("routing: 個人のことを含む質問は、明示されない限り検索語にしない", () => {
  assert.equal(researchRoute("私の住んでいるつくばみらい市について教えて", "chat").firstCall, undefined);
  assert.equal(researchRoute("私の住んでいるつくばみらい市についてネットで調べて", "chat").firstCall?.name, "web_search");
});
