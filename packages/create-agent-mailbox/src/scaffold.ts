import { access, mkdir, mkdtemp, readdir, rename, rm, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, parse, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { x } from "tar";

export function templateArchiveUrl(repository: string, reference: string): string {
  const normalized = repository
    .replace(/^github:/u, "https://github.com/")
    .replace(/^git\+/u, "")
    .replace(/^git@github\.com:/u, "https://github.com/");
  const url = new URL(normalized);
  const [owner, repositoryName, ...extra] = url.pathname.replace(/^\//u, "").split("/");
  const name = repositoryName?.replace(/\.git$/u, "");
  const safePart = /^[a-z0-9_.-]+$/iu;
  if (
    url.hostname !== "github.com" ||
    !owner ||
    !name ||
    extra.length > 0 ||
    !safePart.test(owner) ||
    !safePart.test(name)
  ) {
    throw new Error("The published package must point to a public GitHub repository");
  }

  const refPath = reference.startsWith("v") ? `refs/tags/${reference}` : `refs/heads/${reference}`;
  return `https://codeload.github.com/${owner}/${name}/tar.gz/${refPath}`;
}

export function versionToReference(version: string): string {
  return `v${version}`;
}

export function safeTargetPath(input: string, cwd = process.cwd()): string {
  const target = resolve(cwd, input);
  if (target === parse(target).root || target === homedir()) {
    throw new Error("Choose a project directory rather than a filesystem or home-directory root");
  }
  return target;
}

export async function assertEmptyTarget(target: string): Promise<void> {
  try {
    const entries = await readdir(target);
    if (entries.length > 0) throw new Error(`Target directory is not empty: ${target}`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

export async function downloadTemplate(
  target: string,
  repository: string,
  reference: string,
): Promise<void> {
  await assertEmptyTarget(target);
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const temporaryTarget = await mkdtemp(resolve(parent, `.${basename(target)}-`));

  try {
    const response = await fetch(templateArchiveUrl(repository, reference));
    if (!response.ok || !response.body) {
      throw new Error(`Could not download Agent Mailbox ${reference}: HTTP ${response.status}`);
    }

    await pipeline(Readable.from(response.body), x({ cwd: temporaryTarget, strip: 1 }));
    await Promise.all([
      access(resolve(temporaryTarget, "package.json")),
      access(resolve(temporaryTarget, "pnpm-lock.yaml")),
      access(resolve(temporaryTarget, "scripts/agent-mailbox.ts")),
      access(resolve(temporaryTarget, "wrangler.jsonc")),
    ]);

    // Preserve the old behaviour for a pre-created empty target while keeping
    // downloads and extraction out of the final path until they are complete.
    await rmdir(target).catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
    await rename(temporaryTarget, target);
  } catch (error) {
    await rm(temporaryTarget, { force: true, recursive: true });
    throw error;
  }
}
