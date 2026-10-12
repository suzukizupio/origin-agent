import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { Agent } from "../src/agent.ts";
import { createOriginProvider } from "../src/providers/origin.ts";
import { CONVERSATION_MODEL, conversationHost, createOriginConversationProvider } from "../src/providers/origin-conversation.ts";
import { runPractice, recipe } from "./model-curriculum.ts";
import { runRecovery } from "./recovery-curriculum.ts";
import type { AgentEvent, Message, Provider } from "../src/types.ts";

type Job = { id: string; kind: "chat" | "ordinary" | "recovery"; variant: "baseline" | "candidate";
  status: "running" | "completed" | "failed"; started: number; events: AgentEvent[]; input: string;
  model: string; before?: string; after?: string; ok?: boolean; answer?: string; reason?: string; durationMs?: number };

export function createMobileServer(token: string, providerFactory: (variant: string, kind: Job["kind"]) => Provider = (variant, kind) => kind === "chat" ? createOriginConversationProvider() : createOriginProvider({ variant })) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("A 256-bit access token is required");
  const jobs = new Map<string, Job>();
  let active = false;
  let nextSeed = 3000;
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(body));
  };
  const authorized = (req: IncomingMessage): boolean => {
    const provided = Buffer.from(String(req.headers.authorization ?? ""));
    const expected = Buffer.from(`Bearer ${token}`);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  };
  return createServer(async (req, res) => {
    if (!authorized(req)) { send(res, 401, { error: "認証が必要です。" }); return; }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      const readHealth = async (host: string) => {
        try {
          const response = await fetch(host + "/health", { signal: AbortSignal.timeout(3000) });
          const data = await response.json() as { ready?: boolean; base_repository?: string; base_sha256?: string; adapter_sha256?: string | null };
          return { ready: response.ok && data.ready === true, base_repository: data.base_repository,
            base_sha256: data.base_sha256, adapter_sha256: data.adapter_sha256 };
        } catch { return { ready: false }; }
      };
      const [code, chat] = await Promise.all([readHealth("http://127.0.0.1:18080"), readHealth(conversationHost())]);
      code.ready = code.ready && typeof code.adapter_sha256 === "string";
      chat.ready = chat.ready && chat.base_repository === CONVERSATION_MODEL && chat.adapter_sha256 === null;
      send(res, 200, { ready: code.ready && chat.ready, busy: active, model: "Origin Pocket",
        adapter_sha256: code.adapter_sha256, models: { code: { ...code, model: "Origin-Coder recovery" }, chat: { ...chat, model: CONVERSATION_MODEL } } });
      return;
    }
    if (req.method === "GET" && /^\/jobs\/[a-f0-9-]{36}$/.test(url.pathname)) {
      const job = jobs.get(url.pathname.slice(6));
      send(res, job ? 200 : 404, job ?? { error: "この実行記録は期限切れです。" }); return;
    }
    if (req.method !== "POST" || url.pathname !== "/jobs") { send(res, 404, { error: "Not found" }); return; }
    let size = 0; const chunks: Buffer[] = [];
    try {
      for await (const chunk of req) { size += chunk.length; if (size > 12000) throw new Error("入力が長すぎます。"); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { kind?: string; variant?: string; input?: string; history?: Message[] };
      if (!["chat", "ordinary", "recovery"].includes(body.kind ?? "") || !["baseline", "candidate"].includes(body.variant ?? "")) throw new Error("課題とモデルを選んでください。");
      if (body.kind === "chat" && (typeof body.input !== "string" || !body.input.trim() || body.input.length > 1000)) throw new Error("メッセージは1〜1000文字です。");
      if (body.history !== undefined && (!Array.isArray(body.history) || body.history.length > 8 || body.history.some((m) =>
        !["user", "assistant"].includes(m.role) || typeof m.content !== "string" || m.content.length > 1000))) throw new Error("会話履歴が不正です。");
      if (active) { send(res, 409, { error: "ほかの実行が終わるまでお待ちください。" }); return; }
      for (const [id, job] of jobs) if (Date.now() - job.started > 1800000) jobs.delete(id);
      while (jobs.size >= 20) jobs.delete(jobs.keys().next().value!);
      const seed = nextSeed++; if (nextSeed > 9999) nextSeed = 3000;
      const task = recipe(seed);
      const job: Job = { id: randomUUID(), kind: body.kind as Job["kind"], variant: body.kind === "chat" ? "baseline" : body.variant as Job["variant"],
        model: body.kind === "chat" ? CONVERSATION_MODEL : "Origin-Coder recovery",
        status: "running", started: Date.now(), events: [], input: body.kind === "chat" ? body.input! : task.input,
        before: body.kind === "chat" ? undefined : task.before };
      jobs.set(job.id, job); active = true;
      send(res, 202, { id: job.id });
      void (async () => {
        const emit = (event: AgentEvent) => { if (job.events.length < 120) job.events.push(event); };
        try {
          const provider = providerFactory(job.variant, job.kind);
          if (job.kind === "chat") {
            const agent = new Agent({ provider, mode: "chat", tools: [], maxSteps: 1,
              ctx: { root: "", confirm: async () => false } });
            agent.messages = (body.history ?? []).map((message) => ({ role: message.role, content: message.content }));
            await agent.run(job.input, emit);
            job.answer = job.events.filter((e): e is Extract<AgentEvent, { type: "assistant" }> => e.type === "assistant").map((e) => e.text).join("\n").trim();
            const done = job.events.at(-1);
            job.ok = done?.type === "done" && done.reason === "answered" && !!job.answer;
            if (!job.ok) job.reason = "モデルが文章の回答を返せませんでした。会話をリセットして、もう一度お試しください。";
          } else {
            const result = job.kind === "recovery" ? await runRecovery(seed, provider, "tune", emit) : await runPractice(seed, provider, "tune", emit);
            job.ok = result.ok; job.reason = result.reason; job.after = result.sourceAfter;
          }
          job.status = job.ok ? "completed" : "failed";
        } catch { job.status = "failed"; job.reason = "モデルの実行に失敗しました。少し待って、もう一度お試しください。"; }
        finally { active = false; job.durationMs = Date.now() - job.started; }
      })();
    } catch (error) { send(res, 400, { error: error instanceof Error ? error.message : "入力が不正です。" }); }
  });
}

async function main() {
  const lines = createInterface({ input: process.stdin, terminal: false });
  console.log("Ready for access token JSON on stdin");
  const [line] = await new Promise<string[]>((done) => lines.once("line", (line) => done([line])));
  lines.close();
  const { token } = JSON.parse(line!) as { token: string };
  const server = createMobileServer(token);
  server.listen(18081, "127.0.0.1", () => console.log("Mobile verification API ready on 127.0.0.1:18081"));
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main();
