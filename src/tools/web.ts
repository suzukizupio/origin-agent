// URL の中身を取ってきて、本文テキストとして頭脳に渡すツール。
//
// 「インターネットから学ばせる」の現実的な正体はこれ。
// モデルの重みを鍛えるのではなく、必要な情報をその都度取りに行かせる。
// 学習と違って即座に効き、間違っていればその場で直せる。

import type { Tool } from "../types.ts";
import { isIP } from "node:net";

const TIMEOUT_MS = 20_000;
const DEFAULT_MAX_CHARS = 8_000;

function publicWebUrl(url: URL): void {
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || !hostname
    || hostname === "localhost" || hostname.endsWith(".localhost")
    || hostname.endsWith(".local") || hostname.endsWith(".internal")
    || !hostname.includes(".") || isIP(hostname)) {
    throw new Error("公開された http/https のドメインだけ取得できます。ローカルアドレス・IPアドレス・認証情報付きURLは扱いません。");
  }
}

export async function fetchWebPage(url: URL): Promise<Response> {
  let current = url;
  for (let redirects = 0; redirects <= 5; redirects++) {
    publicWebUrl(current);
    let response: Response | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await fetch(current, {
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { "user-agent": "origin-agent/0.2 (+local learning project)" },
        });
        break;
      } catch (error) {
        // 一時的な接続切断だけ1回再試行する。HTTPエラーや認証画面は再試行しない。
        if (attempt === 0 && error instanceof TypeError) continue;
        const reason = error instanceof Error && error.name === "TimeoutError" ? "タイムアウト" : "接続失敗";
        throw new Error(`Webへの${reason}で取得できませんでした。通信状態を確認し、時間を置いて試してください。`);
      }
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("転送先がないため取得できませんでした。");
    current = new URL(location, current);
  }
  throw new Error("転送が多すぎるため取得を中断しました。");
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return code > 0x10ffff || Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return code > 0x10ffff || Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** 巨大なページでメモリを使い切らないよう、受信時点で上限を設ける。 */
export async function readWebText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2_000_000) throw new Error("ページが大きすぎます（上限2MB）。別のページを指定してください。");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

/** HTML をざっくり本文テキストに落とす。整形の正確さより、頭脳が読めることを優先する */
export function htmlToText(html: string): { title: string | null; text: string } {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  // 長い共通メニューで文字数上限を使い切らず、本文の事実をモデルに渡す。
  // main がないページは従来どおり全体を読み、明示的なナビゲーションだけ除く。
  const visible = html.replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const body = visible.match(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/i)?.[1] ?? visible;

  const text = decodeEntities(
    body
      .replace(/<(rt|rp)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<\/?(?:ruby|rb)\b[^>]*>/gi, "")
      .replace(/<sup\b[^>]*>\s*2\s*<\/sup\s*>/gi, "²")
      // 図の代替テキストにしか書かれていない数値も、資料として残す。
      .replace(/<img\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/gi, (_tag, attrs: string) => {
        const alt = attrs.match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
        return alt ? `\n${(alt[1] ?? alt[2] ?? "").slice(0, 1000)}\n` : " ";
      })
      .replace(/<(nav|footer)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li|h[1-6]|tr|section|article|pre)\s*>/gi, "\n")
      // 引用符内の > をタグの終わりと誤認して、HTML属性を本文へ漏らさない。
      .replace(/<(?:[^"'<>]|"[^"]*"|'[^']*')*>/g, " "),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { title: title === undefined ? null : decodeEntities(title).trim(), text };
}

export const webFetchTool: Tool = {
  name: "web_fetch",
  description: "URL の内容を取得し、本文テキストとして返す。ドキュメントやエラーの調査に使う",
  destructive: false,
  params: [
    { name: "url", type: "string", required: true, description: "http/https の URL" },
    {
      name: "max_chars",
      type: "number",
      required: false,
      description: `返す本文の最大文字数。既定は ${DEFAULT_MAX_CHARS}`,
    },
  ],
  async run(args) {
    if (typeof args.url !== "string" || args.url.trim() === "") {
      throw new Error("url は必須の文字列です");
    }

    let url: URL;
    try {
      url = new URL(args.url.trim());
    } catch {
      throw new Error(`URL として解釈できません: ${args.url}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`http/https のみ扱えます: ${url.protocol}`);
    }

    const maxChars = typeof args.max_chars === "number" ? args.max_chars : DEFAULT_MAX_CHARS;
    if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 20_000) {
      throw new Error("max_chars は 1〜20000 の整数で指定してください。");
    }

    const res = await fetchWebPage(url);

    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`HTTP ${res.status} ${res.statusText}（${url.href}）。本文は取得できませんでした。`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType && !/text\/|json|xml/i.test(contentType)) {
      await res.body?.cancel();
      throw new Error(`本文テキストとして読めない形式です: ${contentType}。HTML のページを指定してください。`);
    }
    const raw = await readWebText(res);
    const sourceUrl = res.url || url.href;

    let body: string;
    let header: string;
    if (contentType.includes("html")) {
      const { title, text } = htmlToText(raw);
      header = title === null ? sourceUrl : `${title}\n${sourceUrl}`;
      body = text;
    } else {
      header = `${sourceUrl}（${contentType || "種類不明"}）`;
      body = raw;
    }

    const clipped = body.length > maxChars;
    const shown = clipped ? `${body.slice(0, maxChars)}\n\n… ${body.length - maxChars} 文字を省略しました` : body;
    return `取得日時: ${new Date().toISOString()}\n${header}\n\n[Webページの参考資料]\n${shown}`;
  },
};
