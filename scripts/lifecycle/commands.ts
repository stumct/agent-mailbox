import * as p from "@clack/prompts";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { listDnsRecords } from "../setup/dns.ts";
import { chooseWranglerProfile, connectCloudflare } from "../setup/session.ts";
import { readDeploymentValues } from "../wrangler-config.ts";
import { readLocalCredentials, credentialsMatch } from "./credentials.ts";
import {
  accountsFromZones,
  buildDiagnostics,
  checkMcp,
  configurationMismatches,
  discoverAgentMailboxInstances,
  selectInstance,
  type AgentMailboxInstance,
} from "./instances.ts";

export type FleetOptions = {
  json: boolean;
  profile?: string;
  yes: boolean;
};

function parseFleetOptions(
  args: string[],
  allowInstance: boolean,
): {
  instance?: string;
  options: FleetOptions;
  help: boolean;
} {
  const { positionals, values } = parseArgs({
    allowPositionals: allowInstance,
    args,
    options: {
      help: { type: "boolean", short: "h", default: false },
      json: { type: "boolean", default: false },
      profile: { type: "string" },
      yes: { type: "boolean", short: "y", default: false },
    },
    strict: true,
  });
  return {
    ...(positionals[0] ? { instance: positionals[0] } : {}),
    options: {
      json: values.json,
      ...(values.profile ? { profile: values.profile } : {}),
      yes: values.yes,
    },
    help: values.help,
  };
}

export async function loadFleet(
  projectRoot: string,
  options: FleetOptions,
): Promise<{
  api: Awaited<ReturnType<typeof connectCloudflare>>;
  instances: AgentMailboxInstance[];
  profile?: string;
}> {
  const profile = await chooseWranglerProfile(projectRoot, options);
  if (profile && !options.json) p.log.info(`Using Wrangler profile: ${profile}`);
  const session = { ...options, ...(profile ? { profile } : {}) };
  const api = await connectCloudflare(projectRoot, session);
  const [zones, credentials] = await Promise.all([
    api.listZones(),
    readLocalCredentials(projectRoot),
  ]);
  const instances = await discoverAgentMailboxInstances({
    accounts: accountsFromZones(zones),
    api,
    credentials,
    zones,
  });
  return { api, instances, ...(profile ? { profile } : {}) };
}

function printableInstance(instance: AgentMailboxInstance): object {
  return {
    worker: instance.workerName,
    account: instance.accountName,
    configuration: configurationMismatches(instance).length === 0 ? "consistent" : "mismatch",
    emailDomain: instance.emailDomain ?? null,
    mcpUrl: instance.mcpHostname ? `https://${instance.mcpHostname}/mcp` : null,
    health: instance.health,
    localCredentials: instance.hasLocalCredentials,
  };
}

export async function runList(args: string[], projectRoot = process.cwd()): Promise<void> {
  const parsed = parseFleetOptions(args, false);
  if (parsed.help) {
    console.log(`List Agent Mailbox deployments in a Wrangler account

Usage:
  pnpm run list [--profile <name>] [--json]
  pnpm mailbox list [--profile <name>] [--json]
`);
    return;
  }
  if (!parsed.options.json) p.intro("Agent Mailbox · deployments");
  const { instances } = await loadFleet(projectRoot, parsed.options);
  if (parsed.options.json) {
    console.log(JSON.stringify(instances.map(printableInstance), null, 2));
    return;
  }
  if (instances.length === 0) {
    p.outro("No Agent Mailbox Workers were found in this Wrangler account.");
    return;
  }
  for (const instance of instances) {
    p.note(
      [
        `Account: ${instance.accountName}`,
        `Email: ${instance.emailDomain ?? "not detected"}`,
        `MCP: ${instance.mcpHostname ? `https://${instance.mcpHostname}/mcp` : "not detected"}`,
        `Health: ${instance.health}`,
        `Credentials: ${instance.hasLocalCredentials ? "available in this checkout" : "not available here"}`,
      ].join("\n"),
      instance.workerName,
    );
  }
  p.outro(`${instances.length} deployment${instances.length === 1 ? "" : "s"} found.`);
}

export async function runDoctor(args: string[], projectRoot = process.cwd()): Promise<void> {
  const parsed = parseFleetOptions(args, true);
  if (parsed.help) {
    console.log(`Inspect a deployed Agent Mailbox

Usage:
  pnpm run doctor [worker-name|domain] [--profile <name>] [--json]
  pnpm mailbox doctor [worker-name|domain] [--profile <name>] [--json]
`);
    return;
  }
  if (!parsed.options.json) p.intro("Agent Mailbox · doctor");
  const config = readDeploymentValues(
    await readFile(resolve(projectRoot, "wrangler.jsonc"), "utf8"),
  );
  const credentials = await readLocalCredentials(projectRoot);
  const { api, instances } = await loadFleet(projectRoot, parsed.options);
  const instance = selectInstance(instances, parsed.instance, config.workerName);
  const [routingRules, dnsRecords] = await Promise.all([
    instance.zoneId ? api.listEmailRoutingRules(instance.zoneId) : Promise.resolve([]),
    instance.emailDomain
      ? listDnsRecords(instance.emailDomain, { types: ["MX"] })
      : Promise.resolve([]),
  ]);
  const matchingCredentials = credentialsMatch(credentials, instance) ? credentials : undefined;
  const diagnostics = buildDiagnostics({
    ...(matchingCredentials ? { credentials: matchingCredentials } : {}),
    dnsRecords,
    instance,
    ...(matchingCredentials ? { mcpReachable: await checkMcp(matchingCredentials) } : {}),
    routingRules,
  });

  if (parsed.options.json) {
    console.log(JSON.stringify({ instance: printableInstance(instance), diagnostics }, null, 2));
  } else {
    for (const diagnostic of diagnostics) {
      const message = `${diagnostic.label}: ${diagnostic.detail}`;
      if (diagnostic.status === "pass") p.log.success(message);
      else if (diagnostic.status === "warn") p.log.warn(message);
      else p.log.error(message);
    }
    const failures = diagnostics.filter((diagnostic) => diagnostic.status === "fail").length;
    p.outro(
      failures === 0
        ? "No deployment problems found."
        : `${failures} deployment problem${failures === 1 ? "" : "s"} found.`,
    );
  }
  if (diagnostics.some((diagnostic) => diagnostic.status === "fail")) process.exitCode = 1;
}
