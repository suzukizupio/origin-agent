// 「検索に回すか」の判定を、モデルもネットも使わずに採点する。数ミリ秒で終わる。
//
//   npm run eval:route               … tune だけ。判定を直している間はこれだけを走らせる
//   npm run eval:route -- --holdout  … holdout だけ。直し終わってから1回
//
// 失敗は2種類に分けて数える。重さが違うため。
//   取りこぼし … 検索すべき質問を検索しなかった。モデルの記憶で答えるので捏造の危険がある
//   過検索     … 検索しなくてよい質問を検索した。遅くなるだけで、嘘にはならない

import { researchRoute } from "../src/routing.ts";
import { holdout, tune } from "./route-cases.ts";
import type { RouteCase } from "./route-cases.ts";

const args = process.argv.slice(2);
for (const arg of args) {
  if (arg !== "--holdout") throw new Error(`不明なオプション: ${arg}`);
}
const useHoldout = args.includes("--holdout");
const name = useHoldout ? "holdout" : "tune";
const cases: RouteCase[] = useHoldout ? holdout : tune;

type Verdict = { item: RouteCase; ok: boolean; actual: "search" | "direct"; detail: string };

function judge(item: RouteCase): Verdict {
  const route = researchRoute(item.input, item.mode);
  const actual: Verdict["actual"] = route.firstCall === undefined ? "direct" : "search";
  const query = String(route.firstCall?.args.query ?? route.firstCall?.args.url ?? "");

  if (actual !== item.expect) {
    const detail = item.expect === "search" ? "取りこぼし（記憶で答えてしまう）" : `過検索（検索語: ${query}）`;
    return { item, ok: false, actual, detail };
  }
  if (item.expect === "search" && item.queryIncludes !== undefined && !query.includes(item.queryIncludes)) {
    return { item, ok: false, actual, detail: `検索語「${query}」に「${item.queryIncludes}」が入っていない` };
  }
  return { item, ok: true, actual, detail: actual === "search" ? `検索語: ${query}` : "" };
}

const verdicts = cases.map(judge);

console.log(`判定の採点: ${name}（${cases.length}問）\n`);
for (const mode of ["chat", "code"] as const) {
  const group = verdicts.filter((v) => v.item.mode === mode);
  if (group.length === 0) continue;
  console.log(`[${mode}]`);
  for (const v of group) {
    const mark = v.ok ? "✓" : "✗";
    const expect = v.item.expect === "search" ? "検索" : "直接";
    console.log(`  ${mark} ${expect}  ${v.item.input}${v.detail ? `  … ${v.detail}` : ""}`);
  }
  console.log("");
}

const passed = verdicts.filter((v) => v.ok).length;
const missed = verdicts.filter((v) => !v.ok && v.item.expect === "search").length;
const extra = verdicts.filter((v) => !v.ok && v.item.expect === "direct").length;
console.log(`合計 ${passed}/${verdicts.length}  取りこぼし ${missed}  過検索 ${extra}`);
if (!useHoldout) {
  console.log("\n判定を直し終わったら、holdout を1回だけ走らせてください: npm run eval:route -- --holdout");
}
