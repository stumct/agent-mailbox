#!/usr/bin/env node

import * as p from "@clack/prompts";
import { pathToFileURL } from "node:url";
import { runDeploy } from "./setup.ts";
import { runConnect, runDisconnect } from "./lifecycle/connect.ts";
import { runDoctor, runList } from "./lifecycle/commands.ts";
import { runPurgeData, runTeardown } from "./lifecycle/teardown.ts";

function printHelp(): void {
  console.log(`Manage self-hosted Agent Mailbox deployments

Usage:
  pnpm mailbox <command> [options]

Commands:
  deploy                         Configure and deploy an isolated instance
  list                           List instances in a Wrangler account
  doctor [instance]              Check Cloudflare, DNS, credentials, and MCP
  connect [instance]             Configure an MCP client and install the skill
  disconnect [instance]          Remove local MCP client configuration
  teardown [instance]            Safely remove one Cloudflare deployment
  purge-data [bucket]            Delete data retained by an earlier teardown

Run pnpm mailbox <command> --help for command-specific options.

Convenience scripts:
  pnpm run list
  pnpm run doctor [instance]
  pnpm run connect [instance]
  pnpm run disconnect [instance]
  pnpm run teardown [instance]
`);
}

export async function runCli(args = process.argv.slice(2)): Promise<void> {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  const [command, ...rest] = normalizedArgs;
  const commandArgs = rest[0] === "--" ? rest.slice(1) : rest;
  switch (command) {
    case "deploy":
    case "setup":
      await runDeploy(commandArgs);
      return;
    case "list":
      await runList(commandArgs);
      return;
    case "doctor":
      await runDoctor(commandArgs);
      return;
    case "connect":
      await runConnect(commandArgs);
      return;
    case "disconnect":
      await runDisconnect(commandArgs);
      return;
    case "teardown":
    case "remove":
      await runTeardown(commandArgs);
      return;
    case "purge-data":
      await runPurgeData(commandArgs);
      return;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  runCli().catch((error: unknown) => {
    p.log.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
