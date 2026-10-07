// Verified response distillation. Teacher sees only generated train/validation tasks.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Agent } from "../src/agent.ts";
import { formatToolCall } from "../src/protocol.ts";
import { createOriginProvider, originMessages, originHost } from "../src/providers/origin.ts";
import { curriculumTools } from "./model-curriculum.ts";
import type { AgentEvent, Provider } from "../src/types.ts";

export type DistillTask = { id: string; split: "train" | "validation" | "tune" | "holdout"; family: "clamp" | "threshold"; a: number; b: number; path: string; fn: string; before: string; testFile: string; tests: string; input: string };
export const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function makeTask(split: DistillTask["split"], family: DistillTask["family"], index: number, a: number, b: number): DistillTask {
  if (!["train", "validation", "tune", "holdout"].includes(split) || !["clamp", "threshold"].includes(family) || index < 0 || ![a, b, index].every(Number.isSafeInteger) || (family === "clamp" && a >= b)) throw new Error("Invalid task parameters");
  const id = `origin-distill-${split}-${family}-${index}`;
  const path = `src/${family}_${index}.js`; const fn = `${family}_${index}`;
  const before = `export function ${fn}(value) { return value; }\nexport function neighbor(value) { return value - 1; }\n`;
  const testFile = `test/${family}_${index}.test.js`;
  const values = [...new Set([a - 7, a - 1, a, a + 1, b - 1, b, b + 1, b + 8, 0, -1, 1])];
  const expected = (value: number) => family === "clamp" ? Math.max(a, Math.min(b, value)) : value >= a;
  const tests = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { ${fn}, neighbor } from '../${path}';\ntest('required behavior and neighbor', () => {\n${values.map((value) => `  assert.equal(${fn}(${value}), ${expected(value)});`).join("\n")}\n  assert.equal(neighbor(7), 6);\n  assert.equal(neighbor(-2), -3);\n});\n`;
  const behavior = family === "clamp" ? `${a} 未満なら ${a}、${b} より大きければ ${b}、範囲内なら元の value を返す` : `value が ${a} 以上なら true、それ未満なら false を返す`;
  const input = `${path} の ${fn} を、${behavior}実装に直してください。neighbor は保持してください。先に実物を読み、変更後は node --test を実行してください。テストファイルは変更しないでください。`;
  return { id, split, family, a, b, path, fn, before, testFile, tests, input };
}

export function developmentTasks(split: "train" | "validation" | "tune"): DistillTask[] {
  const params = split === "train" ? [["clamp", -7, 5], ["clamp", 0, 11], ["threshold", 0, 0], ["threshold", 5, 0]]
    : split === "validation" ? [["clamp", -2, 8], ["threshold", -3, 0]] : [["clamp", -6, 10], ["threshold", 9, 0]];
  const start = split === "train" ? 300 : split === "validation" ? 400 : 500;
  return params.map(([family, a, b], i) => makeTask(split, family as DistillTask["family"], start + i, a as number, b as number));
}

export function heldoutTasks(nonce: number): DistillTask[] {
  if (!Number.isSafeInteger(nonce) || nonce < 1) throw new Error("Frozen evaluation nonce required");
  return [makeTask("holdout", "clamp", 600, -25 - nonce % 17, 15 + nonce % 13), makeTask("holdout", "clamp", 601, -60 - nonce % 11, 45 + nonce % 7),
    makeTask("holdout", "threshold", 602, 20 + nonce % 19, 0), makeTask("holdout", "threshold", 603, -20 - nonce % 23, 0)];
}

export function validateTeacherPatch(value: unknown, task: DistillTask): { path: string; old_string: string; new_string: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Teacher patch must be an object");
  const patch = value as Record<string, unknown>;
  if (Object.keys(patch).sort().join(",") !== "new_string,old_string,path" || patch.path !== task.path || typeof patch.old_string !== "string" || !patch.old_string.trim()
    || patch.old_string !== "return value;" || typeof patch.new_string !== "string" || patch.new_string.length > 1200) throw new Error("Teacher patch is invalid or addresses another file");
  // Teacher-generated code is executed only within this bounded expression language.
  // No imports, assignments, loops, property access to process, or arbitrary calls.
  if (!/^return [\w\s.,()<>=?:+*\-!&|]+;$/.test(patch.new_string) || patch.new_string.replace(/===|!==|==|!=|>=|<=/g, "").includes("=") || /\+\+|--/.test(patch.new_string) || [...patch.new_string.matchAll(/[A-Za-z_$][\w$]*/g)].some(([word]) => !["return", "value", "Math", "min", "max", "true", "false"].includes(word))) throw new Error("Teacher patch contains unsupported executable code");
  return patch as { path: string; old_string: string; new_string: string };
}

async function requestPatch(task: DistillTask, identity: { name: string; digest: string }, host: string) {
  if (!["train", "validation"].includes(task.split)) throw new Error("Teacher must never receive tune or held-out tasks");
  const prompt = [{ role: "system", content: 'You repair one JavaScript return statement. Return JSON only with exactly path, old_string, new_string. old_string must be "return value;". new_string must be one return statement using only value, numbers, Math.min/Math.max, comparison or ternary operators. Preserve neighbor. No test changes or explanation.' },
    { role: "user", content: `${task.input}\n\n実際のファイル ${task.path}:\n${task.before}` }];
  const options = { temperature: 0, seed: 42, num_ctx: 4096, num_predict: 384, num_thread: 4 };
  const response = await fetch(`${host}/api/chat`, { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(300_000),
    body: JSON.stringify({ model: identity.name, stream: false, format: "json", messages: prompt, options, keep_alive: "5m" }) });
  if (!response.ok) throw new Error(`Teacher HTTP ${response.status}`);
  const raw = await response.json() as { model?: string; done?: boolean; done_reason?: string; message?: { content?: string } };
  if (raw.model !== identity.name || raw.done !== true || raw.done_reason !== "stop" || typeof raw.message?.content !== "string") throw new Error("Teacher returned an incomplete or mismatched response");
  const patch = validateTeacherPatch(JSON.parse(raw.message.content), task);
  return { patch, provenance: { ...identity, prompt_sha256: hash(prompt), response_sha256: hash(raw.message.content), options, raw_response: raw.message.content } };
}

export async function runDistillTask(task: DistillTask, provider: Provider, recordTarget?: (messages: ReturnType<typeof originMessages>, answer: string) => void) {
  const parent = resolve(process.env.ORIGIN_DISTILL_PARENT ?? tmpdir()); await mkdir(parent, { recursive: true });
  const controlled = process.env.ORIGIN_DISTILL_PARENT !== undefined;
  const root = controlled ? join(parent, `origin-distill-work-${task.id}`) : await mkdtemp(join(parent, "origin-distill-work-"));
  if (controlled) await mkdir(root);
  const events: AgentEvent[] = [];
  const started = Date.now(); let ok = false; let reason: string | undefined;
  const capture: Provider = { ...provider, complete: async (messages, tools, env, callbacks) => {
    const answer = await provider.complete(messages, tools, env, callbacks);
    recordTarget?.(originMessages(messages, tools, env), answer); return answer;
  } };
  try {
    await mkdir(join(root, "src")); await mkdir(join(root, "test"));
    await writeFile(join(root, "package.json"), '{"type":"module"}\n');
    await writeFile(join(root, task.path), task.before); await writeFile(join(root, task.testFile), task.tests);
    let sourceRead = false;
    const boundedTools = curriculumTools.map((tool) => ({ ...tool, run: async (args: Record<string, unknown>, ctx: Parameters<typeof tool.run>[1]) => {
      if (tool.name === "edit_file") {
        if (!sourceRead) throw new Error("Read the source before editing");
        return tool.run(validateTeacherPatch(args, task), ctx);
      }
      const result = await tool.run(args, ctx);
      if (tool.name === "read_file" && args.path === task.path) sourceRead = true;
      return result;
    } }));
    const agent = new Agent({ provider: capture, tools: boundedTools, mode: "code", maxSteps: 5, ctx: { root, confirm: async (message) =>
      !message.startsWith("コマンドを実行します:") || message === "コマンドを実行します: node --test" } });
    await agent.run(task.input, (event) => events.push(event));
    if (await readFile(join(root, task.testFile), "utf8") !== task.tests) throw new Error("Test file changed");
    if (!(await readFile(join(root, task.path), "utf8")).includes("export function neighbor(value) { return value - 1; }")) throw new Error("Neighbor changed");
    const checkEnv = { ...process.env }; delete checkEnv.NODE_TEST_CONTEXT;
    const checked = await promisify(execFile)(process.execPath, ["--test", "--test-reporter=tap"], { cwd: root, env: checkEnv, windowsHide: true, timeout: 20_000 });
    if (!/tests 1/.test(checked.stdout) || !/pass 1/.test(checked.stdout)) throw new Error("Fixed test did not run");
    if (!events.some((event) => event.type === "tool_end" && event.name === "run_shell" && event.ok)) throw new Error("Agent did not run a passing test");
    const last = events.at(-1); if (last?.type !== "done" || last.reason !== "answered") throw new Error("Agent did not finish");
    ok = true;
  } catch (error) { reason = error instanceof Error ? error.message : String(error); }
  finally {
    const rel = relative(parent, resolve(root));
    if (isAbsolute(rel) || !rel.startsWith("origin-distill-work-") || /[\\/]/.test(rel) || rel.includes("..")) throw new Error("Unexpected workspace path");
    await rm(root, { recursive: true, force: true });
  }
  return { task_id: task.id, ok, reason, ms: Date.now() - started, events };
}

async function generate(output: string) {
  const host = originHost(process.env.ORIGIN_TEACHER_HOST ?? "http://127.0.0.1:11434");
  const name = process.env.ORIGIN_TEACHER_MODEL ?? "qwen2.5-coder:7b";
  const tags = async () => {
    const response = await fetch(`${host}/api/tags`, { redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("Cannot identify the local teacher");
    const data = await response.json() as { models: Array<{ name: string; digest: string }> };
    const identity = data.models.find((model) => model.name === name);
    if (!identity || !/^[a-f0-9]{64}$/.test(identity.digest)) throw new Error("Teacher must already be installed and identified by digest");
    return { name: identity.name, digest: identity.digest };
  };
  const identity = await tags(); await mkdir(output, { recursive: false });
  const records: Record<"train" | "validation", unknown[]> = { train: [], validation: [] }; const attempts = [];
  for (const split of ["train", "validation"] as const) for (const task of developmentTasks(split)) {
    let accepted = false;
    for (let retry = 0; retry < 2 && !accepted; retry++) {
      try {
        if (hash(await tags()) !== hash(identity)) throw new Error("Teacher changed during generation");
        const generated = await requestPatch(task, identity, host); let step = 0; let sample: unknown;
        const scripted: Provider = { name: `distillation:${name}`, complete: async () => [formatToolCall("read_file", { path: task.path }), formatToolCall("edit_file", generated.patch), formatToolCall("run_shell", { command: "node --test" }), "実装を変更し、テストが通ることを確認しました。"][step++] ?? "未完了です。" };
        const result = await runDistillTask(task, scripted, (messages, answer) => {
          if (step === 2) sample = { version: 1, kind: "sft", id: hash({ task: task.id, response: generated.provenance.response_sha256 }), task_id: task.id, split,
            messages: [...messages, { role: "assistant", content: answer }], metadata: { representation: "provider_messages", outcome: "success", cleaned: true,
              source: { provider: `ollama:${name}`, report_completion: "completed", split, task_family: task.family, recipe_sha256: hash(task), teacher: generated.provenance, target_origin: "teacher_patch" } } };
        });
        attempts.push({ task_id: task.id, split, retry, ok: result.ok, reason: result.reason, events: result.events, teacher: generated.provenance });
        if (result.ok && sample) { records[split].push(sample); accepted = true; }
      } catch (error) { attempts.push({ task_id: task.id, split, retry, ok: false, reason: error instanceof Error ? error.message : String(error) }); }
    }
    console.log(JSON.stringify({ teacher_task: task.id, split, accepted }));
  }
  if (hash(await tags()) !== hash(identity)) throw new Error("Teacher changed during generation");
  await writeFile(join(output, "teacher-attempts.json"), JSON.stringify({ completed: true, teacher: identity, attempts }, null, 2) + "\n", { flag: "wx" });
  if (records.train.length !== 4 || records.validation.length !== 2) throw new Error("Some teacher tasks failed; failed responses were not published as SFT");
  for (const split of ["train", "validation"] as const) await writeFile(join(output, `${split}.jsonl`), records[split].map((r) => JSON.stringify(r)).join("\n") + "\n", { flag: "wx" });
  console.log(JSON.stringify({ verified_teacher_targets: records.train.length, validation_targets: records.validation.length, teacher: identity }));
}

async function main() {
  const [mode, output, variant, split, spec] = process.argv.slice(2);
  if (!output) throw new Error("Output is required");
  if (mode === "generate") { await generate(output); return; }
  if (mode === "freeze-holdout") {
    const tasks = heldoutTasks(Number(variant));
    await writeFile(output, JSON.stringify(tasks) + "\n", { flag: "wx" }); return;
  }
  if (mode !== "evaluate" || !["tune", "holdout"].includes(split ?? "")) throw new Error("Usage: distill-curriculum.ts generate <new-dir> | evaluate <report> <variant> tune|holdout [private-spec]");
  const tasks = split === "tune" ? developmentTasks("tune") : JSON.parse(await readFile(spec ?? "", "utf8")) as DistillTask[];
  if (!Array.isArray(tasks) || !tasks.length || tasks.some((task) => task.split !== split || !task.id.startsWith(`origin-distill-${split}-`))) throw new Error("Unexpected evaluation partition");
  const provider = createOriginProvider({ variant }); const attempts = [];
  for (const task of tasks) {
    const result = await runDistillTask(task, provider); attempts.push(result);
    if (split === "tune") console.log(JSON.stringify({ task_id: task.id, ok: result.ok, ms: result.ms }));
  }
  await writeFile(output, JSON.stringify({ completed: true, split, variant, tools: curriculumTools.map((t) => t.name), max_steps: 5, recipe_sha256: hash(tasks), passed: attempts.filter((a) => a.ok).length, total: attempts.length, attempts }, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ split, variant, passed: attempts.filter((a) => a.ok).length, total: attempts.length }));
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
