import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  downloadTemplate,
  safeTargetPath,
  templateArchiveUrl,
  versionToReference,
} from "../packages/create-agent-mailbox/src/scaffold";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("create-agent-mailbox scaffold", () => {
  it("pins every package version to its matching immutable source tag", () => {
    expect(versionToReference("1.2.3")).toBe("v1.2.3");
    expect(versionToReference("1.2.3-beta.1")).toBe("v1.2.3-beta.1");
  });

  it("builds a source archive URL without using the GitHub API", () => {
    expect(templateArchiveUrl("github:example/agent-mailbox", "v1.2.3")).toBe(
      "https://codeload.github.com/example/agent-mailbox/tar.gz/refs/tags/v1.2.3",
    );
    expect(templateArchiveUrl("git+https://github.com/example/agent-mailbox.git", "main")).toBe(
      "https://codeload.github.com/example/agent-mailbox/tar.gz/refs/heads/main",
    );
  });

  it("rejects non-GitHub template locations", () => {
    expect(() => templateArchiveUrl("https://example.com/project.git", "main")).toThrow(
      "public GitHub repository",
    );
  });

  it("rejects broad destructive target directories", () => {
    expect(() => safeTargetPath("/", "/tmp/project")).toThrow("project directory");
  });

  it("does not leave a partial project when the source download fails", async () => {
    const parent = await mkdtemp(resolve(tmpdir(), "agent-mailbox-scaffold-"));
    temporaryDirectories.push(parent);
    const target = resolve(parent, "project");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));

    await expect(
      downloadTemplate(target, "github:example/agent-mailbox", "v1.2.3"),
    ).rejects.toThrow("HTTP 404");
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(parent)).resolves.toEqual([]);
  });
});
