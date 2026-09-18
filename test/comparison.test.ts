import { test } from "node:test";
import assert from "node:assert/strict";
import { compareEvidence } from "../src/comparison.ts";
const comparison = { subjects: ["青葉市", "白波市"], metric: "面積" as const };
const pages = (a: string, b: string) => [{ url: "https://example.com/a", text: a }, { url: "https://example.com/b", text: b }];

test("comparison: 大小・同値・対象の順序を計算し、両方の数値と出典を示す", () => {
  const documents = pages("青葉市の面積は1,234.5平方キロメートルです。", "白波市の面積は2,345.6km²です。");
  const result = compareEvidence(comparison, documents)!;
  assert.match(result, /白波市の方が広い/);
  assert.match(result, /1,234\.5/);
  assert.match(result, /2,345\.6/);
  assert.match(result, /example\.com\/a/);
  assert.match(result, /example\.com\/b/);
  assert.match(compareEvidence({ ...comparison, subjects: ["白波市", "青葉市"] }, documents)!, /白波市の方が広い/);
  assert.match(compareEvidence(comparison, pages("青葉市の面積は3000km²です。", "白波市の面積は2000km²です。"))!, /青葉市の方が広い/);
  assert.match(compareEvidence(comparison, pages("青葉市の面積は2000km²です。", "白波市の面積は2000km²です。"))!, /同じ/);
  assert.match(compareEvidence(comparison, pages("青葉市の面積は、1万1,637平方キロメートルです。", "白波市の面積は15,275.04平方キロメートルです。"))!, /白波市の方が広い/);
});

test("comparison: 不足・否定・食い違い・違う項目や単位を勝手に比べない", () => {
  for (const documents of [
    pages("青葉市の面積は1,234.5km²です。", "白波市は人口を掲載していません。"),
    pages("青葉市の面積は1234.5km²という記載は誤りです。", "白波市の面積は2345.6km²です。"),
    pages("青葉市の面積は1234.5km²です。\n青葉市の面積は3000km²です。", "白波市の面積は2345.6km²です。"),
    pages("青葉市の面積は1234.5平方メートルです。", "白波市の面積は2345.6km²です。"),
    pages("青葉市の人口は1234人です。", "白波市の面積は2345.6km²です。"),
    pages("面積は1234.5km²です。", "白波市の面積は2345.6km²です。"),
  ]) assert.equal(compareEvidence(comparison, documents), undefined);
});

test("comparison: 人口の明示された時点が違えば計算せず、一致すれば示す", () => {
  const population = { ...comparison, metric: "人口" as const };
  assert.equal(compareEvidence(population, pages("青葉市の人口は100人です（2020年）。", "白波市の人口は200人です（2025年）。")), undefined);
  assert.equal(compareEvidence(population, pages("青葉市の人口は100人です。", "白波市の人口は200人です（2025年）。")), undefined);
  const result = compareEvidence(population, pages("青葉市の人口は100人です（2025年）。", "白波市の人口は200人です（2025年）。"))!;
  assert.match(result, /白波市の方が多い/);
  assert.match(result, /時点: 2025年/);
});
