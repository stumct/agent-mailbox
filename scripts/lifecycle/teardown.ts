import * as p from "@clack/prompts";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { readDeploymentValues } from "../wrangler-config.ts";
import { CloudflareApiError, type CloudflareApi } from "../setup/cloudflare-api.ts";
import { chooseWranglerProfile, connectCloudflare, unwrapPrompt } from "../setup/session.ts";
import { loadFleet } from "./commands.ts";
import {
  matchingRoutingRules,
  r2BucketName,
  selectInstance,
  type AgentMailboxInstance,
} from "./instances.ts";

type TeardownOptions = {
  dryRun: boolean;
  profile?: string;
  purgeData: boolean;
  yes: boolean;
};

const cleanupReceiptName = ".agent-mailbox.cleanup.json";
const cleanupReceiptSchema = z.object({
  accountId: z.string().min(1),
  accountName: z.string().min(1),
  bucketName: z.string().min(1),
  profile: z.string().min(1).optional(),
  workerName: z.string().min(1),
});

type CleanupReceipt = z.infer<typeof cleanupReceiptSchema>;

type TeardownApi = Pick<
  CloudflareApi,
  | "deleteEmailRoutingRule"
  | "deleteR2Bucket"
  | "deleteR2Object"
  | "deleteWorker"
  | "detachWorkerDomain"
  | "listR2ObjectKeys"
>;

export type TeardownPlan = {
  domainId?: string;
  instance: AgentMailboxInstance;
  purgeData: boolean;
  r2Bucket?: string;
  routingRuleIds: string[];
};

export function createTeardownPlan(
  instance: AgentMailboxInstance,
  routingRules: Parameters<typeof matchingRoutingRules>[1],
  purgeData: boolean,
): TeardownPlan {
  const r2Bucket = r2BucketName(instance);
  if (purgeData && !r2Bucket) {
    throw new Error("Cannot purge data because the deployed ATTACHMENTS bucket was not identified");
  }
  return {
    ...(instance.domainId ? { domainId: instance.domainId } : {}),
    instance,
    purgeData,
    ...(r2Bucket ? { r2Bucket } : {}),
    routingRuleIds: matchingRoutingRules(instance, routingRules).map((rule) => rule.id),
  };
}

export async function purgeR2(
  api: TeardownApi,
  accountId: string,
  bucketName: string,
): Promise<{ alreadyAbsent: boolean; deletedObjects: number }> {
  let keys: string[];
  try {
    keys = await api.listR2ObjectKeys(accountId, bucketName);
  } catch (error) {
    if (error instanceof CloudflareApiError && error.status === 404) {
      return { alreadyAbsent: true, deletedObjects: 0 };
    }
    throw error;
  }
  const batchSize = 50;
  for (let offset = 0; offset < keys.length; offset += batchSize) {
    await Promise.all(
      keys
        .slice(offset, offset + batchSize)
        .map((key) => api.deleteR2Object(accountId, bucketName, key)),
    );
  }
  await api.deleteR2Bucket(accountId, bucketName);
  return { alreadyAbsent: false, deletedObjects: keys.length };
}

async function writeCleanupReceipt(projectRoot: string, receipt: CleanupReceipt): Promise<void> {
  const path = resolve(projectRoot, cleanupReceiptName);
  await writeFile(path, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  await chmod(path, 0o600);
}

async function readCleanupReceipt(projectRoot: string): Promise<CleanupReceipt> {
  try {
    return cleanupReceiptSchema.parse(
      JSON.parse(await readFile(resolve(projectRoot, cleanupReceiptName), "utf8")),
    );
  } catch (error) {
    throw new Error(`No valid ${cleanupReceiptName} was found in this project`, { cause: error });
  }
}

export async function applyTeardown(plan: TeardownPlan, api: TeardownApi): Promise<void> {
  const { instance } = plan;
  if (!instance.zoneId && plan.routingRuleIds.length > 0) {
    throw new Error(
      "Cannot remove the Email Routing rule because its Cloudflare zone was not identified",
    );
  }

  for (const ruleId of plan.routingRuleIds) {
    await api.deleteEmailRoutingRule(instance.zoneId!, ruleId);
  }
  if (plan.routingRuleIds.length > 0) p.log.success("Inbound Email Routing rule removed");
  else p.log.info("No matching inbound Email Routing rule remains");

  if (plan.domainId) {
    await api.detachWorkerDomain(instance.accountId, plan.domainId);
    p.log.success("Custom Worker domain detached");
  } else {
    p.log.info("No custom Worker domain remains");
  }

  if (plan.purgeData && plan.r2Bucket) {
    const result = await purgeR2(api, instance.accountId, plan.r2Bucket);
    if (result.alreadyAbsent) p.log.info("R2 bucket already absent");
    else
      p.log.success(
        `R2 bucket deleted (${result.deletedObjects} object${result.deletedObjects === 1 ? "" : "s"} purged)`,
      );
  }

  // Use the discovered account ID, not the checkout's configured account, so
  // selecting an instance can never delete a same-named Worker elsewhere.
  await api.deleteWorker(instance.accountId, instance.workerName);
  p.log.success("Worker and Durable Object namespace deleted");
}

export async function runTeardown(args: string[], projectRoot = process.cwd()): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args,
    options: {
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      profile: { type: "string" },
      "purge-data": { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(`Safely remove one Agent Mailbox deployment

Usage:
  pnpm run teardown [worker-name|domain] [options]
  pnpm mailbox teardown [worker-name|domain] [options]

Options:
  --dry-run                      Show the exact removal plan without changing anything
  --purge-data                   Permanently delete the attachment bucket and its objects
  --profile <name>               Use a Wrangler authentication profile
  -y, --yes                      Apply without typed confirmation (requires an instance)
  -h, --help                     Show this help

The Worker and its Durable Object data are removed. R2 attachments are retained
unless --purge-data is supplied. Zone-wide Email Routing DNS, subaddressing, and
Email Sending remain unchanged because other deployments may share them.
`);
    return;
  }

  const requested = positionals[0];
  if (values.yes && !requested) throw new Error("Choose an instance explicitly when using --yes");
  const options: TeardownOptions = {
    dryRun: values["dry-run"],
    ...(values.profile ? { profile: values.profile } : {}),
    purgeData: values["purge-data"],
    yes: values.yes,
  };

  p.intro("Agent Mailbox · teardown");
  const config = readDeploymentValues(
    await readFile(resolve(projectRoot, "wrangler.jsonc"), "utf8"),
  );
  const { api, instances, profile } = await loadFleet(projectRoot, {
    json: false,
    ...(options.profile ? { profile: options.profile } : {}),
    yes: options.yes,
  });
  const instance = selectInstance(instances, requested, config.workerName);
  const routingRules = instance.zoneId ? await api.listEmailRoutingRules(instance.zoneId) : [];
  const plan = createTeardownPlan(instance, routingRules, options.purgeData);

  p.note(
    [
      `Cloudflare account: ${instance.accountName}`,
      `Worker: ${instance.workerName}`,
      `Email route: ${plan.routingRuleIds.length === 0 ? "already absent" : `remove inbox@${instance.configuredEmailDomain ?? instance.emailDomain}`}`,
      `Custom domain: ${instance.mcpHostname ?? instance.configuredMcpHostname ?? "already absent"}`,
      `Durable Object data: permanently delete with Worker`,
      `R2 attachments: ${plan.purgeData ? `permanently delete ${plan.r2Bucket}` : `retain ${plan.r2Bucket ?? "attached bucket"}`}`,
      "Shared zone email settings and other Agent Mailbox deployments: unchanged",
    ].join("\n"),
    options.purgeData ? "Permanent removal plan" : "Removal plan",
  );

  if (options.dryRun) {
    p.outro("Dry run complete. No local files or Cloudflare resources were changed.");
    return;
  }

  if (!options.yes) {
    const confirmation = unwrapPrompt(
      await p.text({
        message: `Type ${instance.workerName} to confirm removal`,
        validate: (value) =>
          value === instance.workerName ? undefined : `Enter ${instance.workerName} exactly`,
      }),
    );
    if (confirmation !== instance.workerName) return;
  }

  await applyTeardown(plan, api);
  if (!plan.purgeData && plan.r2Bucket) {
    await writeCleanupReceipt(projectRoot, {
      accountId: instance.accountId,
      accountName: instance.accountName,
      bucketName: plan.r2Bucket,
      ...(profile ? { profile } : {}),
      workerName: instance.workerName,
    });
    p.log.info(`Preserved R2 bucket: ${plan.r2Bucket}`);
    p.log.info("Run purge-data from this project later to empty and remove it.");
  } else if (plan.purgeData) {
    await rm(resolve(projectRoot, cleanupReceiptName), { force: true });
  }
  p.outro("Agent Mailbox deployment removed. Run disconnect to clean up local MCP clients.");
}

export async function runPurgeData(args: string[], projectRoot = process.cwd()): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args,
    options: {
      help: { type: "boolean", short: "h", default: false },
      profile: { type: "string" },
      yes: { type: "boolean", short: "y", default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(`Permanently remove an attachment bucket retained by teardown

Usage:
  pnpm mailbox purge-data [bucket-name] [options]

Options:
  --profile <name>               Use a Wrangler authentication profile
  -y, --yes                      Apply without typed confirmation (requires bucket-name)
  -h, --help                     Show this help

The exact account and bucket are read from this project's ignored cleanup
receipt. Unknown buckets cannot be targeted by this command.
`);
    return;
  }

  const receipt = await readCleanupReceipt(projectRoot);
  const requestedBucket = positionals[0];
  if (requestedBucket && requestedBucket !== receipt.bucketName) {
    throw new Error(`Cleanup receipt is for ${receipt.bucketName}, not ${requestedBucket}`);
  }
  if (values.yes && requestedBucket !== receipt.bucketName) {
    throw new Error(`Pass ${receipt.bucketName} explicitly when using --yes`);
  }

  p.intro("Agent Mailbox · retained data cleanup");
  p.note(
    [
      `Cloudflare account: ${receipt.accountName}`,
      `Former Worker: ${receipt.workerName}`,
      `R2 bucket: ${receipt.bucketName}`,
      "Contents: permanently empty and delete",
    ].join("\n"),
    "Permanent cleanup plan",
  );

  if (!values.yes) {
    const confirmation = unwrapPrompt(
      await p.text({
        message: `Type ${receipt.bucketName} to confirm permanent deletion`,
        validate: (value) =>
          value === receipt.bucketName ? undefined : `Enter ${receipt.bucketName} exactly`,
      }),
    );
    if (confirmation !== receipt.bucketName) return;
  }

  const sessionOptions = {
    ...((values.profile ?? receipt.profile) ? { profile: values.profile ?? receipt.profile } : {}),
    yes: values.yes,
  };
  const profile = await chooseWranglerProfile(projectRoot, sessionOptions);
  const api = await connectCloudflare(projectRoot, {
    ...sessionOptions,
    ...(profile ? { profile } : {}),
  });
  const accounts = new Set((await api.listZones()).map((zone) => zone.account.id));
  if (!accounts.has(receipt.accountId)) {
    throw new Error("The selected Wrangler profile cannot access the cleanup receipt's account");
  }

  const result = await purgeR2(api, receipt.accountId, receipt.bucketName);
  await rm(resolve(projectRoot, cleanupReceiptName), { force: true });
  if (result.alreadyAbsent) p.log.info("R2 bucket was already absent; cleanup receipt removed");
  else
    p.log.success(
      `R2 bucket deleted (${result.deletedObjects} object${result.deletedObjects === 1 ? "" : "s"} purged)`,
    );
  p.outro("Retained Agent Mailbox data removed.");
}
