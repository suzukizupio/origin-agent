/** 検索順位・公式ドメインだけでなく、質問の対象と項目があるページを優先する。 */
export function searchExcerpts(output: string): { url: string; text: string }[] {
  return output.split(/(?=^\d+\. )/m).flatMap((block) => {
    const url = block.match(/^URL: (https?:\/\/\S+)/m)?.[1];
    const text = block.match(/^抜粋: (.*)$/m)?.[1];
    return url && text && text !== "なし" ? [{ url, text }] : [];
  });
}

export function rankSources(output: string, query: string): string[] {
  const terms = query.split(/\s+/).map((term) => term === "何地方" ? "地方" : term).filter((term) => term && !/^(公式|概要)$/.test(term));
  const subject = terms[0]?.replace(/[都府県]$/, "") ?? "";
  const blocks = output.split(/(?=^\d+\. )/m);
  return blocks.flatMap((block, index) => {
    const url = block.match(/^(?:URL: )?(https?:\/\/\S+)/m)?.[1];
    if (!url || /\.pdf(?:[?#]|$)/i.test(url)) return [];
    let official = false;
    try { official = /\.(lg|go)\.jp$/.test(new URL(url).hostname); } catch { return []; }
    const title = block.split("\n")[0] ?? "";
    const snippet = block.match(/^抜粋: (.*)$/m)?.[1] ?? "";
    const relevant = terms.length < 2 || terms.slice(1).some((term) => title.includes(term) || snippet.includes(term));
    const score = (official ? relevant ? 6 : 1 : 0) + (subject && title.includes(subject) ? 6 : 0)
      + (subject && snippet.includes(subject) ? 4 : 0)
      + terms.slice(1).reduce((sum, term) => sum + (title.includes(term) ? 3 : 0) + (snippet.includes(term) ? 3 : 0), 0);
    return [{ url, score, index }];
  }).sort((a, b) => b.score - a.score || a.index - b.index).map((item) => item.url);
}

/** 質問に関わる箇所と前後を抜き出す。全文と抜粋を混同しないよう、省略の境界を示す。 */
export function focusEvidence(text: string, terms: string[], limit = 2400): string {
  if (text.length <= limit) return text;
  const keywords = [...new Set(terms.flatMap((term) => term === "何地方" ? ["地方", "位置"] : [term]).filter((term) => term.length > 1))];
  const windows: { start: number; end: number; score: number }[] = [];
  for (const term of keywords) {
    let offset = 0;
    for (let i = 0; i < 40; i++) {
      const found = text.indexOf(term, offset);
      if (found < 0) break;
      offset = found + term.length;
      const start = Math.max(0, text.lastIndexOf("\n", Math.max(0, found - 100)) + 1, found - 160);
      const end = Math.min(text.length, found + 420);
      const section = text.slice(start, end);
      windows.push({ start, end, score: keywords.filter((word) => section.includes(word)).length });
    }
  }
  if (!windows.length) return text.slice(0, limit) + "\n[以降省略]";
  const chosen: typeof windows = [];
  let size = 0;
  for (const window of windows.sort((a, b) => b.score - a.score || a.start - b.start)) {
    if (chosen.some((other) => other.start < window.end && other.end > window.start)) continue;
    if (size + window.end - window.start > limit) continue;
    chosen.push(window);
    size += window.end - window.start;
  }
  return "[質問に関わる箇所を抜粋。省略した箇所があります]\n" + chosen.sort((a, b) => a.start - b.start).map((window) => text.slice(window.start, window.end)).join("\n[中略]\n");
}

/** 短く明記された所在地はその文を返す。対象名だけ、否定、長い説明は推測で補わない。 */
export function locationEvidence(subject: string, documents: { url: string; text: string }[]): string | undefined {
  const escaped = subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${escaped}(?:[都道府県市])?(?:[（(][^）)\n]{1,20}[）)])?は[、,]?[^。！？\n]{1,100}。`, "g");
  for (const document of documents) {
    // HTMLのインライン要素間の空白は、日本語の語の区切りには使わない。
    const text = document.text.replace(/[ \t\u3000]+/g, "");
    for (const match of text.matchAll(pattern)) {
      const sentence = match[0];
      if (!/地方|県|日本|北部|東部|南部|西部|中央/.test(sentence) || !/位置|所在|あります|にある/.test(sentence)) continue;
      if (/ない|誤り|誤った|仮定|架空/.test(sentence) || /人口|面積/.test(sentence)) continue;
      return `${sentence}\n\n[出典](${document.url})`;
    }
  }
}

/** 要約モデルが時間切れになった場合、取得済み資料の関連文だけを引用する。 */
export function timeoutExcerpt(
  documents: { url: string; text: string }[],
  excerpts: { url: string; text: string }[],
  terms: string[],
): string | undefined {
  const sources = [
    ...documents.map((source) => ({ ...source, kind: "ページ" })),
    ...excerpts.map((source) => ({ ...source, kind: "検索結果" })),
  ];
  const keywords = [...new Set(terms.flatMap((term) => term === "何地方" ? ["地方", "位置", "県"] : [term]).filter(Boolean))];
  for (const source of sources) {
    const sentences = source.text.replace(/\s+/g, " ").match(/[^。！？]+[。！？]/g)
      ?.map((sentence) => sentence.trim()).filter((sentence) => sentence.length >= 20 && sentence.length <= 400)
      ?? [];
    // 検索結果の抜粋は句点のない短文もある。
    if (sentences.length === 0 && source.text.trim()) sentences.push(source.text.trim().slice(0, 400));
    const ranked = sentences.map((sentence, index) => ({ sentence, index,
      score: keywords.reduce((score, keyword) => score + (sentence.includes(keyword) ? 3 : 0), 0)
        + (/当市|本市/.test(sentence) ? 2 : 0),
    })).sort((a, b) => b.score - a.score || a.index - b.index);
    const chosen = ranked.filter((item) => item.score > 0).slice(0, 2);
    if (chosen.length === 0) continue;
    const quote: string[] = [];
    for (const item of chosen.sort((a, b) => a.index - b.index)) {
      if (quote.join(" ").length + item.sentence.length > 500) break;
      quote.push(item.sentence);
    }
    if (!quote.length) continue;
    return `要約が時間切れになりました。取得済みの${source.kind}から関連箇所を引用します。\n\n> ${quote.join(" ")}\n\n[出典](${source.url})`;
  }
  return undefined;
}
