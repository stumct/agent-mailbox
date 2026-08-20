import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { skillState } from "../scripts/lifecycle/connect";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(resolve(tmpdir(), "agent-mailbox-skill-"));
  temporaryDirectories.push(path);
  return path;
}

async function writeSkill(root: string, extra = "safe: true\n"): Promise<void> {
  await mkdir(resolve(root, "agents"), { recursive: true });
  await Promise.all([
    writeFile(resolve(root, "SKILL.md"), "# Agent Mailbox\n"),
    writeFile(resolve(root, "agents/openai.yaml"), extra),
  ]);
}

describe("installed Agent Mailbox skill verification", () => {
  it("compares every installed skill artifact", async () => {
    const source = await temporaryDirectory();
    const target = await temporaryDirectory();
    await Promise.all([writeSkill(source), writeSkill(target)]);

    await expect(skillState(source, target)).resolves.toBe("current");
    await writeFile(resolve(target, "agents/openai.yaml"), "safe: false\n");
    await expect(skillState(source, target)).rejects.toThrow("different Agent Mailbox skill");
  });

  it("refuses an installed directory containing unknown files", async () => {
    const source = await temporaryDirectory();
    const target = await temporaryDirectory();
    await Promise.all([writeSkill(source), writeSkill(target)]);
    await writeFile(resolve(target, "unexpected.txt"), "local content\n");

    await expect(skillState(source, target)).rejects.toThrow("different Agent Mailbox skill");
  });
});
