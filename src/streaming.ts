/** 途中の <tool> やコードブロックは完成前に画面へ出さず、確定した本文だけを順次表示する。 */
export function createTextPreview(emit: (text: string) => void): (chunk: string) => void {
  let raw = "";
  let sent = "";
  let paused = false;
  return (chunk) => {
    if (paused) return;
    raw += chunk;
    const markup = raw.search(/[<`]/);
    const visible = (markup < 0 ? raw : raw.slice(0, markup)).trim();
    if (visible.length > sent.length) {
      emit(visible.slice(sent.length));
      sent = visible;
    }
    if (markup >= 0) paused = true;
  };
}

/** 最終回答は全文イベントとして残し、画面では先に表示した部分を重複させない。 */
export class ReplyPrinter {
  private pending = "";
  private write: (text: string) => void;
  constructor(write: (text: string) => void) { this.write = write; }
  delta(text: string): void {
    if (!this.pending) this.write("\n");
    this.write(text);
    this.pending += text;
  }
  answer(text: string): void {
    if (this.pending && text.startsWith(this.pending)) this.write(text.slice(this.pending.length) + "\n");
    else { this.finish(); this.write(`\n${text}\n`); }
    this.pending = "";
  }
  finish(): void {
    if (this.pending) this.write("\n");
    this.pending = "";
  }
}
