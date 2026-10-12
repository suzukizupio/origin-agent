/** The browser supplies a zone, never the current date or system instructions. */
export function conversationTimeZone(value: unknown = "UTC"): string {
  if (typeof value !== "string" || value.length > 100 || !/^[A-Za-z0-9_+./-]+$/.test(value)) {
    throw new Error("タイムゾーンが不正です。ページを開き直してください。");
  }
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    throw new Error("タイムゾーンが不正です。ページを開き直してください。");
  }
}

/** Shift calendar days, not 24 hours in the user's zone (which breaks at DST). */
export function conversationCalendar(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const part = (name: string) => Number(parts.find((p) => p.type === name)!.value);
  const day = new Date(Date.UTC(part("year"), part("month") - 1, part("day")));
  const label = (offset: number) => {
    const shifted = new Date(day);
    shifted.setUTCDate(day.getUTCDate() + offset);
    return new Intl.DateTimeFormat("ja-JP", {
      timeZone: "UTC", year: "numeric", month: "long", day: "numeric", weekday: "long",
    }).format(shifted);
  };
  return [
    "Current calendar from the server clock (authoritative, refreshed for this request).",
    `User time zone: ${timeZone}.`,
    `Today / 今日: ${label(0)}.`,
    `Yesterday / 昨日: ${label(-1)}.`,
    `Tomorrow / 明日: ${label(1)}.`,
    "For the current date or weekday, use this calendar exactly. Old dates in conversation history are not today's date. Do not guess. This clock does not provide live weather, news, or other current facts.",
  ].join("\n");
}
