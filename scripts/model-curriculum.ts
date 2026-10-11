// Independent, generated pilot tasks. Never imports existing tune/holdout cases.
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Agent } from "../src/agent.ts";
import { allTools } from "../src/tools/index.ts";
import { formatToolCall } from "../src/protocol.ts";
import { createOriginProvider, originMessages } from "../src/providers/origin.ts";
import type { AgentEvent, Provider } from "../src/types.ts";

export const curriculumTools = allTools.filter((tool) => ["read_file", "edit_file", "run_shell"].includes(tool.name));
export const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

export function recipe(seed: number) {
  const suffix = String(seed).padStart(4, "0");
  const factor = 2 + seed % 7;
  const offset = seed % 2 === 0 ? 1 + seed % 5 : -(1 + seed % 5);
  const path = `src/operation_${suffix}.js`;
  const fn = `transform_${suffix}`;
  const before = `export function ${fn}(value) { return value; }\nexport function neighbor(value) { return value - 1; }\n`;
  const oldString = `return value;`;
  const newString = `return value * ${factor} + (${offset});`;
  const testFile = `test/operation_${suffix}.test.js`;
  const tests = `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { ${fn}, neighbor } from '../${path}';\ntest('required behavior and preserved neighbor', () => {\n${[-9, -1, 0, 2, 11].map((value) => `  assert.equal(${fn}(${value}), ${value * factor + offset});`).join("\n")}\n  assert.equal(neighbor(7), 6);\n});\n`;
  const input = `${path} の ${fn} を、引数 value の ${factor} 倍に ${offset} を足して返す実装へ変更してください。neighbor は保持してください。先に実物を読み、変更後は node --test を実行してください。テストファイルは変更しないでください。`;
  return { seed, path, before, oldString, newString, testFile, tests, input };
}

export async function runPractice(seed: number, provider?: Provider, split: "train" | "validation" | "tune" = "tune") {
  const task = recipe(seed);
  const controlledParent = process.env.ORIGIN_PRACTICE_PARENT;
  const parent = resolve(controlledParent ?? tmpdir());
  await mkdir(parent, { recursive: true });
  // Paired evaluation recreates the same absolute workspace for both models,
  // so even the root displayed in the system prompt remains identical.
  const root = controlledParent ? join(parent, `origin-model-practice-${seed}`) : await mkdtemp(join(parent, "origin-model-practice-"));
  if (controlledParent) await mkdir(root);
  const examples: unknown[] = [];
  const events: AgentEvent[] = [];
  let step = 0;
  const scripted: Provider = { name: "curated-demonstration", complete: async (messages, tools, env) => {
    const actions = [formatToolCall("read_file", { path: task.path }),
      formatToolCall("edit_file", { path: task.path, old_string: task.oldString, new_string: task.newString }),
      formatToolCall("run_shell", { command: "node --test" }), "実装を変更し、テストが通ることを確認しました。"];
    const answer = actions[step++];
    if (answer === undefined) throw new Error("Curated demonstration did not finish as expected");
    const prompt = originMessages(messages, tools, env);
    examples.push({ version: 1, kind: "sft", id: sha(`${split}:${seed}:${step}`), split,
      task_id: `origin-practice-${seed}`, messages: [...prompt, { role: "assistant", content: answer }],
      metadata: { representation: "provider_messages", outcome: "success", source: { provider: "curated-demonstration", report_completion: "completed", recipe_sha256: sha(JSON.stringify(task)) }, cleaned: true } });
    return answer;
  } };
  const started = Date.now();
  let ok = false;
  let reason: string | undefined;
  try {
    await mkdir(join(root, "src")); await mkdir(join(root, "test"));
    await writeFile(join(root, "package.json"), '{"type":"module"}\n');
    await writeFile(join(root, task.path), task.before);
    await writeFile(join(root, task.testFile), task.tests);
    const agent = new Agent({ provider: provider ?? scripted, mode: "code", maxSteps: 5, tools: curriculumTools, ctx: { root, confirm: async (message) =>
      !message.startsWith("コマンドを実行します:") || message === "コマンドを実行します: node --test" } });
    await agent.run(task.input, (event) => events.push(event));
    if (await readFile(join(root, task.testFile), "utf8") !== task.tests) throw new Error("Test file changed");
    if (!(await readFile(join(root, task.path), "utf8")).includes("export function neighbor(value) { return value - 1; }")) throw new Error("Unrelated neighbor function changed");
    const checkEnv = { ...process.env }; delete checkEnv.NODE_TEST_CONTEXT;
    const checked = await promisify(execFile)(process.execPath, ["--test", "--test-reporter=tap"], { cwd: root, env: checkEnv, windowsHide: true, timeout: 20_000 });
    if (!/tests 1/.test(checked.stdout) || !/pass 1/.test(checked.stdout)) throw new Error("Expected test was not executed");
    if (!events.some((e) => e.type === "tool_end" && e.name === "run_shell" && e.ok)) throw new Error("Agent did not verify the change with a passing test");
    if (events.at(-1)?.type !== "done" || (events.at(-1) as Extract<AgentEvent, { type: "done" }>).reason !== "answered") throw new Error("Agent did not complete the task");
    ok = true;
  } catch (error) { reason = error instanceof Error ? error.message : String(error); }
  finally {
    const rel = relative(parent, resolve(root));
    if (isAbsolute(rel) || !rel.startsWith("origin-model-practice-") || /[\\/]/.test(rel) || rel.includes("..")) throw new Error("Unexpected temporary path");
    await rm(root, { recursive: true, force: true });
  }
  if (!provider && !ok) throw new Error(`Curated example failed verification: ${reason}`);
  return { task_id: `origin-practice-${seed}`, ok, ms: Date.now() - started, reason, events, examples };
}

async function main() {
  const [mode, output, variant = "baseline", countText = "2"] = process.argv.slice(2);
  if (!output || !["generate", "evaluate"].includes(mode ?? "")) throw new Error("Usage: node scripts/model-curriculum.ts generate <directory> | evaluate <report.json> baseline|candidate [task-count]");
  if (mode === "generate") {
    const train: unknown[] = []; const validation: unknown[] = [];
    for (const [split, seeds, target] of [["train", [0, 1, 2, 3, 4, 5], train], ["validation", [100, 101], validation]] as const) {
      for (const seed of seeds) {
        const result = await runPractice(seed, undefined, split);
        target.push(...result.examples);
        console.log(JSON.stringify({ verified_task: seed, split }));
      }
    }
    await mkdir(join(output, "sft"), { recursive: true }); await mkdir(join(output, "validation"), { recursive: true });
    await writeFile(join(output, "sft/practice-train.jsonl"), train.map((r) => JSON.stringify(r)).join("\n") + "\n", { flag: "wx" });
    await writeFile(join(output, "validation/practice-validation.jsonl"), validation.map((r) => JSON.stringify(r)).join("\n") + "\n", { flag: "wx" });
    console.log(JSON.stringify({ train_examples: train.length, validation_examples: validation.length }));
  } else {
    const count = Number(countText);
    if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error("Task count must be 1..20");
    const provider = createOriginProvider({ variant });
    const attempts = [];
    for (let index = 0; index < count; index++) {
      const result = await runPractice(200 + index, provider);
      const { examples: _examples, ...attempt } = result;
      attempts.push(attempt);
      console.log(JSON.stringify({ variant, index, ok: attempt.ok, ms: attempt.ms }));
    }
    await mkdir(resolve(output, ".."), { recursive: true });
    await writeFile(output, JSON.stringify({ version: 1, completed: true, split: "tune", variant, tools: curriculumTools.map((t) => t.name), max_steps: 5, recipe_sha256: sha(JSON.stringify(Array.from({ length: count }, (_, i) => recipe(200 + i)))), passed: attempts.filter((a) => a.ok).length, total: count, attempts }, null, 2) + "\n", { flag: "wx" });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
