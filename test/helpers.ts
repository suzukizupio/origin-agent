import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import type { TestContext } from "node:test";

export async function temporaryDirectory(t: TestContext): Promise<string> {
  const parent = resolve(tmpdir());
  const directory = await mkdtemp(join(parent, "origin-agent-learning-test-"));
  t.after(async () => {
    const rel = relative(parent, resolve(directory));
    if (isAbsolute(rel) || !rel.startsWith("origin-agent-learning-test-") || /[\\/]/.test(rel) || rel.includes("..")) {
      throw new Error("Unexpected temporary directory");
    }
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
