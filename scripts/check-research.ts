// 取得資料を固定して、実モデルの読解と会話の引き継ぎを測る。
// --live では画像の会話を実際の検索サービスで試す。資料固定と実検索を混ぜて採点しない。
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { Agent } from "../src/agent.ts";
import { Assistant } from "../src/assistant.ts";
import { LearningStore } from "../src/learning.ts";
import { resolveProvider } from "../src/providers/index.ts";
import { webSearchTool } from "../src/tools/web-search.ts";
import { webFetchTool } from "../src/tools/web.ts";
import type { AgentEvent, Tool } from "../src/types.ts";

const args = process.argv.slice(2);
const live = args.includes("--live");
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1]!.startsWith("--")) throw new Error(`${name} の値が必要です。`);
  return args[i + 1]!;
};
const repeat = Number(option("--repeat", "1"));
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10) throw new Error("--repeat は1〜10です。");
const destination = resolve(option("--out", live ? "research-live-3b.json" : "research-fixture-3b.json"));
const provider = await resolveProvider("ollama", option("--model", "qwen2.5-coder:3b"));
const pages = [
  // 2026-09-17に公式ページで確認した事実を短い検査用資料へ整形。最新統計を保証するデータセットではない。
  { name: "大阪", url: "https://www.pref.osaka.lg.jp/documents/61555/p3-420suidounofukyuujyoukyou_1.pdf", text: "大阪府は近畿地方のほぼ中央に位置します。" },
  { name: "秋田県", url: "https://common3.pref.akita.lg.jp/kigyo-rich/merit/", text: "秋田県の総面積は11,637平方キロメートルです。" },
  { name: "岩手県", url: "https://www.pref.iwate.jp/kensei/profile/1000649.html", text: "岩手県の面積は15,275.04平方キロメートルです。" },
  // 架空資料: モデルの暗記で解けない別の数値・対象も使う。
  { name: "青葉市", url: "https://example.com/aoba", text: "これは架空の市の検査用資料です。青葉市の面積は1,234.5平方キロメートルです。人口は掲載していません。" },
  { name: "白波市", url: "https://example.com/shiranami", text: "これは架空の市の検査用資料です。白波市の面積は2,345.6平方キロメートルです。人口は掲載していません。" },
];
const fixtureTools: Tool[] = [
  { ...webSearchTool, run: async (call) => {
    const found = pages.filter((p) => String(call.query).includes(p.name));
    if (!found.length) return "検索結果はありません。";
    return found.map((p, i) => `${i + 1}. ${p.name}の概要\nURL: ${p.url}\n抜粋: ${p.text}`).join("\n");
  } },
  { ...webFetchTool, run: async (call) => {
    const page = pages.find((p) => p.url === call.url);
    if (!page) throw new Error("検査資料にないURLです。");
    return `${page.name}\n${page.url}\n[Webページの参考資料]\n${page.text}`;
  } },
];
type Case = { id: string; inputs: string[]; check: (answers: string[], traces: AgentEvent[][]) => void };
const cases: Case[] = [
  { id: "screenshot", inputs: ["大阪ってどこですか？", "秋田と岩手ってどっちが大きいですか？", "面積はどうですか？"], check: (answers, traces) => {
    assert.match(answers[0]!, /近畿|関西/);
    assert.doesNotMatch(answers[0]!, /日本の中部|中部地方|2,700万|2700万/);
    assert.match(answers[1]!, /面積と人口/);
    assert.match(answers[2]!, /岩手県[^。\n]{0,30}(?:広い|大きい)/);
    assert.doesNotMatch(answers[2]!, /47,739|4万8,739|15,830/);
    for (const place of ["秋田県", "岩手県"]) {
      assert.ok(traces[2]!.some((e) => e.type === "tool_start" && e.name === "web_search" && String(e.args.query).includes(place)), `${place}も検索すること`);
    }
    assert.ok((answers[2]!.match(/https?:\/\//g) ?? []).length >= 2, "両方の根拠を表示すること");
  } },
  ...(!live ? [
    { id: "unfamiliar-comparison", inputs: ["青葉市と白波市の面積を比べてください"], check: (answers: string[]) => {
      assert.match(answers[0]!, /白波市[^。\n]{0,30}(?:広い|大きい)/);
      assert.match(answers[0]!, /1,?234\.5/);
      assert.match(answers[0]!, /2,?345\.6/);
      assert.match(answers[0]!, /example\.com\/aoba/);
      assert.match(answers[0]!, /example\.com\/shiranami/);
    } },
    { id: "missing-fact", inputs: ["青葉市の人口は何人ですか？"], check: (answers: string[]) => {
      assert.match(answers[0]!, /(?:分か|わか|確認でき|掲載されてい|記載されてい|載ってい|ありません|未確認|不明)/);
      assert.doesNotMatch(answers[0]!.replace(/https?:\/\/\S+/g, ""), /[\d,万億]+人/);
    } },
    { id: "comparison-reversed", inputs: ["白波市と青葉市の面積を比べてください"], check: (answers: string[]) => {
      assert.match(answers[0]!, /白波市の方が広い/);
      assert.match(answers[0]!, /1,?234\.5/);
      assert.match(answers[0]!, /2,?345\.6/);
    } },
  ] : []),
];
const root = await mkdtemp(join(tmpdir(), "origin-agent-research-"));
const report = { startedAt: new Date().toISOString(), provider: provider.name, source: live ? "live-web" : "fixed-fixtures", completed: false, passed: 0, total: repeat * cases.length, attempts: [] as unknown[] };
try {
  for (const item of cases) for (let trial = 1; trial <= repeat; trial++) {
    const assistant = new Assistant(new Agent({ provider, tools: live ? [webSearchTool, webFetchTool] : fixtureTools, mode: "chat", maxSteps: 8, ctx: { root, confirm: async () => true } }), new LearningStore(root));
    const started = performance.now();
    const answers: string[] = [];
    const traces: AgentEvent[][] = [];
    let error: string | undefined;
    try {
      for (const input of item.inputs) {
        console.log(`> ${input}`);
        const events: AgentEvent[] = [];
        traces.push(events);
        await assistant.run(input, (e) => { events.push(e); if (e.type === "notice") console.log(e.message); if (e.type === "tool_start") console.log(`${e.name}: ${JSON.stringify(e.args)}`); });
        assert.ok(events.some((e) => e.type === "done" && e.reason === "answered"), "回答まで完了すること");
        const answer = events.filter((e): e is Extract<AgentEvent, { type: "assistant" }> => e.type === "assistant").at(-1)?.text ?? "";
        answers.push(answer);
        console.log(answer);
      }
      item.check(answers, traces);
      report.passed++;
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    report.attempts.push({ id: item.id, trial, ok: !error, ms: performance.now() - started, error, inputs: item.inputs, answers, traces });
    await writeFile(destination, JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log(`${error ? "FAIL" : "PASS"} ${item.id} ${trial}${error ? `: ${error}` : ""}`);
  }
  report.completed = true;
  await writeFile(destination, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(`${report.passed}/${report.total} (${report.source}) → ${destination}`);
  if (report.passed !== report.total) process.exitCode = 1;
} finally {
  // この実行で作った、tmp直下の検査用ディレクトリだけを消す。
  if (dirname(resolve(root)).toLowerCase() !== resolve(tmpdir()).toLowerCase() || !basename(root).startsWith("origin-agent-research-")) throw new Error("Unexpected temporary path");
  await rm(root, { recursive: true, force: true });
}
