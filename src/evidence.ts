/** 数値の転記と出典URLの検査。文章の意味や出典の正しさまで保証するものではない。 */
function plain(text: string): string {
  return text.normalize("NFKC")
    .replace(/−/g, "-")
    .replace(/\[([^\]]*)\]\(https?:\/\/[^\s)]+\)/g, "$1")
    .replace(/https?:\/\/[^\s<>「」)]+/g, "")
    .replace(/^\s*\d+[.)、]\s+/gm, "")
    .replace(/\[\d+\]/g, "");
}

/** URL、検索語、取得日時は事実の裏付けとして使わない。 */
export function evidenceText(tool: string, output: string): string {
  if (tool === "web_fetch") return output.split("[Webページの参考資料]").slice(1).join("[Webページの参考資料]");
  return output.split("\n").filter((line) => !/^(検索語:|取得日時:|URL:|以下は検索結果|\d+\. )/.test(line)).join("\n");
}

export function numericValue(text: string): number {
  let total = 0;
  let group = 0;
  let pending = "";
  const digits: Record<string, string> = { 零: "0", 〇: "0", 一: "1", 二: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9" };
  const scales: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 1e4, 億: 1e8, 兆: 1e12 };
  for (const char of text.replaceAll(",", "")) {
    const scale = scales[char];
    if (scale === undefined) { pending += digits[char] ?? char; continue; }
    if (scale < 10000) group += Number(pending || "1") * scale;
    else { total += (group + Number(pending || (group ? "0" : "1"))) * scale; group = 0; }
    pending = "";
  }
  return total + group + Number(pending || "0");
}

function numbers(text: string): { key: string; text: string }[] {
  const input = plain(text);
  const pattern = /[+-]?(?:\d[\d,.]*|[〇零一二三四五六七八九十百千万億兆]+)(?:[兆億万千百十](?:[\d,.]+)?)*\s*(平方キロメートル|平方メートル|キロメートル|メートル|km\^?2|m\^?2|km|m|人|円|ドル|%|パーセント|年|月|日|時|分|秒|度|位|倍|件|個|本|歳)?/gi;
  const units: Record<string, string> = { 平方キロメートル: "km2", 平方メートル: "m2", キロメートル: "km", メートル: "m", パーセント: "%" };
  return [...input.matchAll(pattern)].flatMap((match) => {
    const unit = match[1] ?? "";
    // 「一方」「一般」等は数値ではない。漢数字は単位があるときだけ扱う。
    if (!unit && !/\d/.test(match[0])) return [];
    const value = numericValue(match[0].slice(0, match[0].length - unit.length).trim());
    return Number.isFinite(value) ? [{ key: `${value}:${units[unit] ?? unit.toLowerCase().replace("^", "")}`, text: match[0].trim() }] : [];
  });
}

export function unsupportedNumbers(answer: string, evidence: string[]): string[] {
  const supported = new Set(evidence.flatMap(numbers).map((item) => item.key));
  return [...new Set(numbers(answer).filter((item) => !supported.has(item.key)).map((item) => item.text))];
}

/** 会社紹介の主要な名詞が取得した本文にないとき、業種の作り話を表示しない。 */
export function unsupportedCompanyClaims(answer: string, documents: string[], company: string): string[] {
  const cleaned = answer.replace(/\[[^\]]*\]\(https?:\/\/[^\s)]+\)/g, "")
    .replace(/https?:\/\/\S+/g, "").replaceAll(company, "").normalize("NFKC");
  if (/^(?:資料からは|公開情報では)?(?:確認できません|分かりません|不明です)/.test(cleaned.trim())) return [];
  const reference = documents.join(" ").normalize("NFKC").replace(/[\s、。！？?「」『』（）()・:：]/g, "");
  const generic = new Set(["会社", "企業", "同社", "当社", "事業", "内容", "公式", "出典", "参照", "資料", "確認", "回答", "前回", "今回", "情報", "可能", "現在"]);
  const words = cleaned.match(/[\p{Script=Han}]{2,}|[\p{Script=Katakana}ー]{2,}|[A-Za-z]{3,}/gu) ?? [];
  return [...new Set(words.filter((word) => {
    if (generic.has(word) || reference.includes(word)) return false;
    const pairs = Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2));
    return pairs.filter((pair) => reference.includes(pair)).length / pairs.length < 0.7;
  }))];
}

export function unknownCitations(answer: string, sources: string[]): string[] {
  const normalize = (value: string) => { try { const url = new URL(value); url.hash = ""; return url.href; } catch { return value; } };
  const known = new Set(sources.map(normalize));
  return [...answer.matchAll(/https?:\/\/[^\s)\]<>「」]+/g)].map((match) => match[0].replace(/[。！？、）]+$/, ""))
    .filter((url) => !known.has(normalize(url)));
}
