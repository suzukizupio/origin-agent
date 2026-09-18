import { test } from "node:test";
import assert from "node:assert/strict";
import { focusEvidence, locationEvidence, rankSources, searchExcerpts } from "../src/retrieval.ts";
import { htmlToText } from "../src/tools/web.ts";

test("retrieval: 公式の総合一覧より、対象と項目を説明するページを優先する", () => {
  const output = "1. 全国の面積調\nURL: https://example.go.jp/index.html\n抜粋: 全国の統計一覧\n2. 秋田の概要\nURL: https://example.lg.jp/about.html\n抜粋: 秋田の面積について\n3. PDF 秋田の面積\nURL: https://example.lg.jp/a.pdf\n抜粋: 秋田の面積";
  assert.deepEqual(rankSources(output, "秋田県 面積 公式"), ["https://example.lg.jp/about.html", "https://example.go.jp/index.html"]);
});

test("retrieval: 本文の後半の関連箇所と前後の数値を抜き出し、省略を明示する", () => {
  const text = "案内の長い文章です。\n".repeat(500) + "2025年の統計\n市の面積\n1234.5平方キロメートル\n" + "連絡先です。\n".repeat(400);
  const excerpt = focusEvidence(text, ["面積"]);
  assert.match(excerpt, /市の面積\n1234\.5平方キロメートル/);
  assert.match(excerpt, /2025年の統計/);
  assert.match(excerpt, /省略/);
  assert.ok(excerpt.length < 2500);
  assert.equal(focusEvidence("短い本文", ["面積"]), "短い本文");
});

test("retrieval: ふりがなを数値に混ぜず、平方キロメートルの上付き文字を保つ", () => {
  const { text } = htmlToText('<p><ruby>秋田<rt>あきた</rt></ruby>県の<ruby>面積<rt>めんせき</rt></ruby>は1<ruby>万<rt>まん</rt></ruby>1,637km<sup>2</sup>です。</p>');
  assert.equal(text, "秋田県の面積は1万1,637km²です。");
  const image = htmlToText('<img data-extra=\'"<br />"\' alt="県の面積は15,275.04平方キロメートル。"><p data-extra=\'{"text":"<br />"}\'>実際の本文</p>').text;
  assert.match(image, /面積は15,275\.04平方キロメートル/);
  assert.match(image, /実際の本文/);
  assert.doesNotMatch(image, /data-extra|text|br/);
});

test("retrieval: 明記された所在地の一文だけを抜き出し、別の対象や否定文は使わない", () => {
  const page = { url: "https://example.com/place", text: "大阪府 （おおさかふ）は、 日本 の 近畿地方 に位置する 府 。人口は掲載していません。" };
  assert.equal(locationEvidence("大阪", [page]), "大阪府（おおさかふ）は、日本の近畿地方に位置する府。\n\n[出典](https://example.com/place)");
  assert.equal(locationEvidence("秋田", [page]), undefined);
  assert.equal(locationEvidence("大阪", [{ ...page, text: "大阪府は近畿地方に位置しない。" }]), undefined);
  assert.equal(locationEvidence("大阪", [{ ...page, text: "大阪市長は日本の中心にある施設を訪れました。" }]), undefined);
  assert.deepEqual(searchExcerpts("検索語: 大阪\n1. 概要\nURL: https://example.com/place\n抜粋: 大阪府は近畿地方に位置します。"), [{ url: page.url, text: "大阪府は近畿地方に位置します。" }]);
});
