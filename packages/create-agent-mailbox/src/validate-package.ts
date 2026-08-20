import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { templateArchiveUrl } from "./scaffold.ts";

const packageJson: unknown = JSON.parse(await readFile(resolve("package.json"), "utf8"));
const repositoryValue =
  typeof packageJson === "object" && packageJson !== null && "repository" in packageJson
    ? packageJson.repository
    : undefined;
const repository =
  typeof repositoryValue === "string"
    ? repositoryValue
    : typeof repositoryValue === "object" && repositoryValue !== null && "url" in repositoryValue
      ? repositoryValue.url
      : undefined;

if (typeof repository !== "string") {
  throw new Error("Add the clean public repository URL before publishing create-agent-mailbox");
}

templateArchiveUrl(repository, "main");
