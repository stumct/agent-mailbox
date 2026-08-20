#!/usr/bin/env node

import * as p from "@clack/prompts";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { type CloudflareZone } from "./setup/cloudflare-api.ts";
import { detectPackageManager, runCommand, runWrangler } from "./setup/process.ts";
import { withWranglerProfile } from "./setup/profiles.ts";
import { chooseWranglerProfile, connectCloudflare, unwrapPrompt } from "./setup/session.ts";
import {
  createSetupPlan,
  describeConflicts,
  recommendedDeployment,
  type SetupPlan,
} from "./setup/plan.ts";
import { listDnsRecords } from "./setup/dns.ts";
import { withSpinner } from "./setup/progress.ts";
import { configureWrangler, readDeploymentValues } from "./wrangler-config.ts";
import { runConnect } from "./lifecycle/connect.ts";
import { credentialsMatch, readLocalCredentials } from "./lifecycle/credentials.ts";

const configName = "wrangler.jsonc";
const credentialsName = ".agent-mailbox.credentials.json";

type CliOptions = {
  check: boolean;
  emailDomain?: string;
  help: boolean;
  hostname?: string;
  plan: boolean;
  profile?: string;
  rotateCredentials: boolean;
  yes: boolean;
  zone?: string;
};

function parseOptions(args: string[]): CliOptions {
  const { values } = parseArgs({
    args,
    options: {
      check: { type: "boolean", default: false },
      "email-domain": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      hostname: { type: "string" },
      plan: { type: "boolean", default: false },
      profile: { type: "string" },
      "rotate-credentials": { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      zone: { type: "string" },
    },
    strict: true,
  });

  return {
    check: values.check,
    ...(values["email-domain"] === undefined ? {} : { emailDomain: values["email-domain"] }),
    help: values.help,
    ...(values.hostname === undefined ? {} : { hostname: values.hostname }),
    plan: values.plan,
    ...(values.profile === undefined ? {} : { profile: values.profile }),
    rotateCredentials: values["rotate-credentials"],
    yes: values.yes,
    ...(values.zone === undefined ? {} : { zone: values.zone }),
  };
}

function printHelp(): void {
  console.log(`Set up and deploy Agent Mailbox

Usage:
  pnpm mailbox deploy [options]
  pnpm run setup [options]       Compatibility alias

Options:
  --plan                         Show the proposed Cloudflare changes only
  --check                        Validate the CLI and Worker configuration locally
  --zone <domain>                Preselect a Cloudflare DNS zone
  --email-domain <hostname>      Override the recommended receiving subdomain
  --hostname <hostname>          Override the recommended Worker hostname
  --profile <name>               Use a Wrangler authentication profile
  --rotate-credentials           Replace the deployment's master API key
  -y, --yes                      Apply the displayed plan without confirmation
  -h, --help                     Show this help
`);
}

async function chooseZone(zones: CloudflareZone[], options: CliOptions): Promise<CloudflareZone> {
  if (zones.length === 0)
    throw new Error("No active Cloudflare DNS zones are available to this login");
  if (options.zone) {
    const requested = options.zone.toLowerCase();
    const zone = zones.find((candidate) => candidate.name === requested);
    if (!zone) throw new Error(`Cloudflare zone ${requested} is not active or not accessible`);
    return zone;
  }
  if (options.yes) throw new Error("--zone is required when using --yes");

  return unwrapPrompt(
    await p.select({
      message: "Which Cloudflare zone should host Agent Mailbox?",
      options: zones.map((zone) => ({
        hint: zone.account.name,
        label: zone.name,
        value: zone,
      })),
    }),
  );
}

async function choosePlan(zone: CloudflareZone, options: CliOptions): Promise<SetupPlan> {
  const recommended = recommendedDeployment(zone);
  if (options.yes || options.emailDomain || options.hostname) {
    return createSetupPlan(zone, {
      emailDomain: options.emailDomain ?? recommended.emailDomain,
      mcpHostname: options.hostname ?? recommended.mcpHostname,
    });
  }

  const useRecommended = unwrapPrompt(
    await p.confirm({
      initialValue: true,
      message: `Use ${recommended.emailDomain} for email and ${recommended.mcpHostname} for MCP?`,
    }),
  );
  if (useRecommended) return recommended;

  const emailDomain = unwrapPrompt(
    await p.text({
      initialValue: recommended.emailDomain,
      message: "Receiving email subdomain",
      validate: (value) => validatePlanValue(zone, value ?? "", recommended.mcpHostname, "email"),
    }),
  );
  const mcpHostname = unwrapPrompt(
    await p.text({
      initialValue: recommended.mcpHostname,
      message: "Public API and MCP hostname",
      validate: (value) => validatePlanValue(zone, emailDomain, value ?? "", "hostname"),
    }),
  );
  return createSetupPlan(zone, { emailDomain, mcpHostname });
}

function validatePlanValue(
  zone: CloudflareZone,
  emailDomain: string,
  mcpHostname: string,
  field: "email" | "hostname",
): string | undefined {
  try {
    createSetupPlan(zone, { emailDomain, mcpHostname });
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid hostname";
    if (field === "email" && message.includes("Public Worker")) return undefined;
    return message;
  }
}

async function writeConfiguration(projectRoot: string, plan: SetupPlan): Promise<void> {
  const configPath = resolve(projectRoot, configName);
  const source = await readFile(configPath, "utf8");
  const configured = configureWrangler(source, plan);
  if (configured === source) return;

  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, configured, "utf8");
    await rename(temporaryPath, configPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function writeCredentials(
  projectRoot: string,
  plan: SetupPlan,
  apiKey: string,
): Promise<void> {
  const credentialsPath = resolve(projectRoot, credentialsName);
  await writeFile(
    credentialsPath,
    JSON.stringify(
      {
        apiKey,
        emailDomain: plan.emailDomain,
        healthUrl: `https://${plan.mcpHostname}/health`,
        mcpUrl: `https://${plan.mcpHostname}/mcp`,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  await chmod(credentialsPath, 0o600);
}

async function healthCheck(url: string): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // A new custom hostname commonly needs a few seconds to become reachable.
    }
    await delay(2_000);
  }
  return false;
}

async function runChecks(projectRoot: string): Promise<void> {
  const packageManager = detectPackageManager();
  await runCommand(packageManager, ["run", "check"], { cwd: projectRoot, quiet: true });
}

export async function runDeploy(args = process.argv.slice(2)): Promise<void> {
  const options = parseOptions(args);
  if (options.help) {
    printHelp();
    return;
  }
  const projectRoot = process.cwd();
  const configPath = resolve(projectRoot, configName);
  const source = await readFile(configPath, "utf8");

  if (options.check) {
    const current = readDeploymentValues(source);
    if (configureWrangler(source, current) !== source) {
      throw new Error("Deployment hostnames in wrangler.jsonc are inconsistent");
    }
    console.log(
      "TypeScript setup CLI and wrangler.jsonc are valid. No Cloudflare resources were changed.",
    );
    return;
  }

  p.intro("Agent Mailbox · Cloudflare setup");
  p.log.info("Wrangler handles OAuth. Credentials stay in its keyring and are never written here.");

  const profile = await chooseWranglerProfile(projectRoot, options);
  options.profile = profile;
  if (profile) p.log.info(`Using Wrangler profile: ${profile}`);

  p.log.step("Checking the local Wrangler login");
  const api = await connectCloudflare(projectRoot, options);
  const zones = await withSpinner({
    failure: "Could not load Cloudflare zones",
    run: () => api.listZones(),
    start: "Loading Cloudflare zones",
    success: (availableZones) =>
      `Connected · ${availableZones.length} active zone${availableZones.length === 1 ? "" : "s"}`,
  });

  const zone = await chooseZone(zones, options);
  const plan = await choosePlan(zone, options);
  const current = readDeploymentValues(source);
  const isRerun =
    current.emailDomain === plan.emailDomain && current.mcpHostname === plan.mcpHostname;
  const localCredentials = await readLocalCredentials(projectRoot);
  const reusableCredentials = credentialsMatch(localCredentials, plan)
    ? localCredentials
    : undefined;

  if (isRerun && !reusableCredentials && !options.rotateCredentials && !options.plan) {
    if (options.yes) {
      throw new Error(
        "This deployment has no matching local API key. Pass --rotate-credentials to replace it explicitly.",
      );
    }
    options.rotateCredentials = unwrapPrompt(
      await p.confirm({
        initialValue: false,
        message: "No matching local API key is available. Replace the deployed key with a new one?",
      }),
    );
    if (!options.rotateCredentials) {
      p.outro("No credentials or Cloudflare resources were changed.");
      return;
    }
  }
  const reuseApiKey = reusableCredentials !== undefined && !options.rotateCredentials;
  const credentialPlan = reuseApiKey
    ? "reuse the existing local key"
    : isRerun && options.plan && !options.rotateCredentials
      ? "requires explicit rotation because no matching local key is available"
      : isRerun
        ? "replace with a new key"
        : "generate a new key";

  await withSpinner({
    failure: "Could not check DNS names",
    run: async () => {
      const [emailRecords, hostnameRecords] = await Promise.all([
        listDnsRecords(plan.emailDomain, { types: ["MX", "CNAME"] }),
        listDnsRecords(plan.mcpHostname, { types: ["A", "AAAA", "CNAME", "NS"] }),
      ]);
      const conflicts = isRerun ? [] : describeConflicts(emailRecords, hostnameRecords);
      if (conflicts.length > 0) {
        throw new Error(`${conflicts.join("; ")}. Choose unused dedicated subdomains.`);
      }
    },
    start: "Checking DNS names",
    success: "DNS names are available",
  });

  p.note(
    [
      `Cloudflare account: ${plan.accountName}`,
      `Worker instance: ${plan.workerName}`,
      `Receiving addresses: inbox+…@${plan.emailDomain}`,
      `MCP endpoint: https://${plan.mcpHostname}/mcp`,
      `Master API key: ${credentialPlan}`,
      "Existing Agent Mailbox domains use separate Workers and remain unchanged.",
      "Changes: email DNS, routing, subaddressing, sending domain, isolated Worker deployment",
    ].join("\n"),
    "Deployment plan",
  );

  if (options.plan) {
    p.outro("Plan complete. No local files or Cloudflare resources were changed.");
    return;
  }

  if (!options.yes) {
    const approved = unwrapPrompt(
      await p.confirm({
        initialValue: false,
        message: "Apply these Cloudflare and DNS changes, then deploy?",
      }),
    );
    if (!approved) {
      p.outro("No changes were made.");
      return;
    }
  }

  await withSpinner({
    failure: "Could not update the Worker configuration",
    run: async () => {
      await writeConfiguration(projectRoot, plan);
      await runWrangler(projectRoot, withWranglerProfile(["types"], profile), { quiet: true });
    },
    start: "Writing Worker configuration",
    success: "Worker configuration updated",
  });

  await withSpinner({
    failure: "Could not provision Cloudflare Email Service",
    run: async () => {
      await api.enableEmailRouting(plan.zoneId, plan.emailDomain);
      await api.enableSubaddressing(plan.zoneId);
      await api.enableEmailSending(plan.zoneId, plan.emailDomain);
    },
    start: "Provisioning Cloudflare Email Service",
    success: "Email routing, subaddressing, and sending are ready",
  });

  await withSpinner({
    failure: "Local checks failed",
    run: () => runChecks(projectRoot),
    start: "Running tests and deployment dry run",
    success: "Local checks passed",
  });

  // Wrangler owns conflict confirmation for custom domains. Preserve its TTY so
  // it never interprets captured output as permission to replace DNS records.
  p.log.step("Deploying Worker and managed resources");
  await runWrangler(projectRoot, withWranglerProfile(["deploy"], profile));
  p.log.success("Worker deployed");

  const apiKey = reuseApiKey ? reusableCredentials.apiKey : randomBytes(32).toString("base64url");
  await withSpinner({
    failure: "Could not install the generated master API key",
    run: async () => {
      await runWrangler(
        projectRoot,
        withWranglerProfile(["secret", "put", "AGENT_API_KEY"], profile),
        {
          input: `${apiKey}\n`,
          quiet: true,
        },
      );
      await writeCredentials(projectRoot, plan, apiKey);
    },
    start: reuseApiKey
      ? "Restoring the existing master API key"
      : "Installing a new master API key",
    success: reuseApiKey
      ? `Existing credentials preserved in ${credentialsName}`
      : `Credentials saved to ${credentialsName} with mode 0600`,
  });

  const healthUrl = `https://${plan.mcpHostname}/health`;
  await withSpinner({
    failure: "Could not check the public health endpoint",
    run: () => healthCheck(healthUrl),
    start: "Waiting for the public health endpoint",
    success: (healthy) =>
      healthy ? "Deployment is healthy" : "DNS is still propagating; retry the health URL shortly",
  });

  p.note(
    [
      `MCP URL: https://${plan.mcpHostname}/mcp`,
      `Credentials: ${credentialsName}`,
      `Health: ${healthUrl}`,
    ].join("\n"),
    "Ready",
  );

  if (!options.yes) {
    const shouldConnect = unwrapPrompt(
      await p.confirm({
        initialValue: true,
        message: "Connect this deployment to an AI coding client now?",
      }),
    );
    if (shouldConnect) {
      await runConnect([], projectRoot);
      return;
    }
  }
  p.outro("Agent Mailbox is deployed.");
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  runDeploy().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    p.log.error(message);
    process.exitCode = 1;
  });
}
