#!/usr/bin/env node

import * as p from "@clack/prompts";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { downloadTemplate, safeTargetPath, versionToReference } from "./scaffold.ts";

async function run(command: string, args: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) resolvePromise();
      else reject(new Error(`${command} exited with code ${exitCode ?? "unknown"}`));
    });
  });
}

type PackageMetadata = {
  repository?: string;
  version: string;
};

async function packageMetadata(): Promise<PackageMetadata> {
  const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), "../package.json");
  const packageJson: unknown = JSON.parse(await readFile(packagePath, "utf8"));
  if (typeof packageJson !== "object" || packageJson === null) {
    throw new Error("create-agent-mailbox package metadata is missing");
  }
  const version = "version" in packageJson ? packageJson.version : undefined;
  const repositoryValue = "repository" in packageJson ? packageJson.repository : undefined;
  const repository =
    typeof repositoryValue === "string"
      ? repositoryValue
      : typeof repositoryValue === "object" && repositoryValue !== null && "url" in repositoryValue
        ? repositoryValue.url
        : undefined;
  if (typeof version !== "string") {
    throw new Error("The published package is missing its version metadata");
  }
  return {
    ...(typeof repository === "string" ? { repository } : {}),
    version,
  };
}

function printHelp(): void {
  console.log(`Create and deploy Agent Mailbox

Usage:
  npx create-agent-mailbox@latest [directory] [options]

Options:
  --ref <git-ref>                 Template branch or version tag
  --repository <GitHub URL>       Override the source repository
  --zone <domain>                 Preselect a Cloudflare zone
  --email-domain <hostname>       Override the recommended email subdomain
  --hostname <hostname>           Override the recommended Worker hostname
  --profile <name>                Preselect a Wrangler authentication profile
  --no-deploy                     Create and install the project without running setup
  -y, --yes                       Accept the displayed deployment plan
  -h, --help                      Show this help
`);
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      "email-domain": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      hostname: { type: "string" },
      "no-deploy": { type: "boolean", default: false },
      profile: { type: "string" },
      ref: { type: "string" },
      repository: { type: "string" },
      yes: { type: "boolean", short: "y", default: false },
      zone: { type: "string" },
    },
    strict: true,
  });
  if (values.help) {
    printHelp();
    return;
  }

  const target = safeTargetPath(positionals[0] ?? "agent-mailbox");
  const metadata = await packageMetadata();
  const reference = values.ref ?? versionToReference(metadata.version);
  const repository = values.repository ?? metadata.repository;
  if (!repository) {
    throw new Error("The published package is missing its public repository metadata");
  }
  p.intro("Create Agent Mailbox");

  const downloadSpinner = p.spinner();
  downloadSpinner.start(`Downloading Agent Mailbox ${reference}`);
  try {
    await downloadTemplate(target, repository, reference);
    downloadSpinner.stop(`Source created at ${target}`);
  } catch (error) {
    downloadSpinner.error("Could not download Agent Mailbox");
    throw error;
  }

  p.log.step("Installing locked dependencies with pnpm");
  await run("corepack", ["pnpm", "install", "--frozen-lockfile"], target);
  p.log.success("Dependencies installed");

  if (values["no-deploy"]) {
    p.note(
      [`Project: ${target}`, `Deploy: cd ${target} && corepack pnpm run setup`].join("\n"),
      "Source ready",
    );
    return;
  }

  const setupArgs = [
    ...(values.zone ? ["--zone", values.zone] : []),
    ...(values["email-domain"] ? ["--email-domain", values["email-domain"]] : []),
    ...(values.hostname ? ["--hostname", values.hostname] : []),
    ...(values.profile ? ["--profile", values.profile] : []),
    ...(values.yes ? ["--yes"] : []),
  ];
  await run("corepack", ["pnpm", "run", "setup", ...setupArgs], target);
  p.note(
    [`Project: ${target}`, `Manage: cd ${target} && corepack pnpm mailbox <command>`].join("\n"),
    "Local checkout",
  );
}

main().catch((error: unknown) => {
  p.log.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
