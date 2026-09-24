import type { Tool } from "../types.ts";
import { decodeEntities, fetchWebPage, htmlToText, readWebText } from "./web.ts";

export type SearchResult = { title: string; url: string; snippet: string };

function attribute(tag: string, name: string): string {
  return decodeEntities(tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"))?.[2] ?? "");
}

/** DuckDuckGo の公開 HTML 版。取得先と解析を分けて、画面変更をテストで追えるようにする。 */
export function parseSearchResults(html: string, limit = 5): SearchResult[] {
  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
  const titles = anchors.filter((match) => attribute(match[1] ?? "", "class").split(/\s+/).includes("result__a"));
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < titles.length && results.length < limit; i++) {
    const match = titles[i]!;
    try {
      const link = new URL(attribute(match[1] ?? "", "href"), "https://duckduckgo.com");
      const redirect = link.hostname === "duckduckgo.com" ? link.searchParams.get("uddg") : null;
      const url = redirect === null ? link : new URL(redirect);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || seen.has(url.href)) continue;
      const segment = html.slice(match.index! + match[0].length, titles[i + 1]?.index ?? html.length);
      const snippet = [...segment.matchAll(/<(?:a|div)\b([^>]*)>([\s\S]*?)<\/(?:a|div)>/gi)]
        .find((item) => attribute(item[1] ?? "", "class").split(/\s+/).includes("result__snippet"));
      const title = htmlToText(match[2] ?? "").text;
      if (!title) continue;
      results.push({ title, url: url.href, snippet: htmlToText(snippet?.[2] ?? "").text.slice(0, 800) });
      seen.add(url.href);
    } catch {
      // 不正なリンクは結果に含めない。
    }
  }
  return results;
}

export const webSearchTool: Tool = {
  name: "web_search",
  description: "インターネットをキーワードで検索し、ページ名・URL・抜粋を返す。最新情報や調べものに使う",
  destructive: false,
  params: [
    { name: "query", type: "string", required: true, description: "検索キーワード。日本語も使える" },
    { name: "limit", type: "number", required: false, description: "結果の件数（1〜5、既定3）" },
  ],
  async run(args, ctx) {
    if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 500) {
      throw new Error("query は 1〜500 文字の検索キーワードで指定してください。");
    }
    const query = args.query.trim();
    const limit = args.limit ?? 3;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 5) {
      throw new Error("limit は 1〜5 の整数で指定してください。");
    }
    // 公開情報の検索は自動で進める。個人情報やローカルパスらしい語だけ確認する。
    if (/(?:[A-Z]:\\|\\\\|\/Users\/|\/home\/|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:api[_ -]?key|access[_ -]?token|password|パスワード)\s*[:：=])/i.test(query)
      && !await ctx.confirm(`検索語に個人情報や秘密情報が含まれる可能性があります: ${query}\nDuckDuckGo に送信してよろしいですか？`)) {
      return "ユーザーが検索語の送信を拒否しました。検索は実行していません。";
    }
    const url = new URL("https://html.duckduckgo.com/html/");
    url.searchParams.set("q", query);
    const response = await fetchWebPage(url);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`検索サービスが HTTP ${response.status} を返しました。時間を置くか、URL を web_fetch で読んでください。`);
    }
    const html = await readWebText(response);
    if (/anomaly-modal|anomaly\.js|id=["']challenge-form/i.test(html)) {
      throw new Error("検索サービスの認証画面で停止しました。検索結果は取得できていません。URL が分かる場合は web_fetch を使えます。");
    }
    const results = parseSearchResults(html, limit);
    if (results.length === 0) {
      if (/no-results|No results found/i.test(html)) return `「${query}」に一致する検索結果はありません。検索語を短く変えてください。`;
      throw new Error("検索結果を読み取れませんでした。検索ページの形式が変わった可能性があります。取得済みの結果はありません。");
    }
    return [
      `検索語: ${query}`,
      `取得日時: ${new Date().toISOString()}`,
      "以下は検索結果の抜粋です。本文を読むには web_fetch を使ってください。回答に参照元の URL を付けてください。",
      ...results.map((item, index) => `\n${index + 1}. ${item.title}\nURL: ${item.url}\n抜粋: ${item.snippet || "なし"}`),
    ].join("\n");
  },
};
