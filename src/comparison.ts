// 資料に対象名・項目・数値・単位がまとまって書かれている比較は、文章生成に大小判定を任せない。
// 複数の値、否定、換算、複雑な表、時点の違いは推測して解釈しない。
import { numericValue } from "./evidence.ts";
export type SourceDocument = { url: string; text: string };
export type Comparison = { subjects: string[]; metric: "面積" | "人口" };
type Fact = { subject: string; value: number; label: string; unit: string; url: string; date: string };
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function compareEvidence(comparison: Comparison, documents: SourceDocument[]): string | undefined {
  if (comparison.subjects.length !== 2 || comparison.subjects[0] === comparison.subjects[1]) return;
  const facts: Fact[] = [];
  for (const subject of comparison.subjects) {
    const candidates: Fact[] = [];
    for (const document of documents) {
      const normalized = document.text.normalize("NFKC");
      // 短い同一行の文のみ。名前から離れた数値を勝手に結びつけない。
      const quantity = "(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?(?:[億万千百十](?:[\\d,]+(?:\\.\\d+)?)?)*";
      const pattern = new RegExp(`${escape(subject)}(?:の)?(?:総)?${comparison.metric}(?:は|:|：|、|[ \\t])*(${quantity})[ \\t]*(平方キロメートル|km2|人)`, "g");
      for (const match of normalized.matchAll(pattern)) {
        const line = normalized.slice(0, match.index).split("\n").at(-1)! + normalized.slice(match.index).split("\n")[0]!;
        if (/ではなく|誤|未確認|不明|訂正|ではない/.test(line)) continue;
        const unit = match[2] === "人" ? "人" : "平方キロメートル";
        if (comparison.metric === "人口" ? unit !== "人" : unit === "人") continue;
        const value = numericValue(match[1]!);
        if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) continue;
        // 文に年・月・日がある場合はその表記まで一致する資料だけを比べる。
        const date = (line.match(/(?:(?:令和|平成)\d+|\d{4})年(?:\d+月(?:\d+日)?)?/g) ?? []).join("/");
        candidates.push({ subject, value, label: match[1]!, unit, url: document.url, date });
      }
    }
    const unique = new Set(candidates.map((fact) => `${fact.value}:${fact.unit}:${fact.date}`));
    if (unique.size !== 1) return;
    facts.push(candidates[0]!);
  }
  const [a, b] = facts as [Fact, Fact];
  if (a.unit !== b.unit || a.date !== b.date) return;
  const larger = a.value > b.value ? a : b;
  const conclusion = a.value === b.value ? "両方とも同じです。" : `${larger.subject}の方が${comparison.metric === "面積" ? "広い" : "多い"}です。`;
  return [
    `資料に記載された${comparison.metric}では、${conclusion}`,
    ...facts.map((fact) => `- ${fact.subject}: ${fact.label}${fact.unit} [出典](${fact.url})`),
    ...(a.date ? [`時点: ${a.date}`] : []),
  ].join("\n");
}
