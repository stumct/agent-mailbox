import { createHash } from "node:crypto";
import type { CloudflareZone } from "./cloudflare-api.ts";
import { findDnsConflicts, type DnsRecord } from "./dns.ts";
import { normalizeHostname, type DeploymentValues } from "../wrangler-config.ts";

export type SetupPlan = Omit<DeploymentValues, "accountId" | "workerName"> & {
  accountId: string;
  accountName: string;
  workerName: string;
  zoneId: string;
  zoneName: string;
};

const workerNamePrefix = "agent-mailbox-";
const workerNameMaxLength = 63;

function workerNameForZone(zoneName: string): string {
  const slug = normalizeHostname(zoneName, "Cloudflare zone").replaceAll(".", "-");
  const fullName = `${workerNamePrefix}${slug}`;
  if (fullName.length <= workerNameMaxLength) return fullName;

  const hash = createHash("sha256").update(zoneName).digest("hex").slice(0, 8);
  const slugLength = workerNameMaxLength - workerNamePrefix.length - hash.length - 1;
  const shortenedSlug = slug.slice(0, slugLength).replace(/-+$/u, "");
  return `${workerNamePrefix}${shortenedSlug}-${hash}`;
}

export function recommendedDeployment(zone: CloudflareZone): SetupPlan {
  return {
    accountId: zone.account.id,
    accountName: zone.account.name,
    emailDomain: `mail.${zone.name}`,
    mcpHostname: `mailbox.${zone.name}`,
    workerName: workerNameForZone(zone.name),
    zoneId: zone.id,
    zoneName: zone.name,
  };
}

export function createSetupPlan(
  zone: CloudflareZone,
  values: Pick<DeploymentValues, "emailDomain" | "mcpHostname">,
): SetupPlan {
  const emailDomain = normalizeSubdomain(values.emailDomain, zone.name, "Receiving email domain");
  const mcpHostname = normalizeSubdomain(values.mcpHostname, zone.name, "Public Worker hostname");

  if (emailDomain === mcpHostname) {
    throw new Error("Receiving email domain and public Worker hostname must be different");
  }

  return {
    accountId: zone.account.id,
    accountName: zone.account.name,
    emailDomain,
    mcpHostname,
    workerName: workerNameForZone(zone.name),
    zoneId: zone.id,
    zoneName: zone.name,
  };
}

export function normalizeSubdomain(input: string, zoneName: string, label: string): string {
  const hostname = normalizeHostname(input, label);
  if (hostname === zoneName || !hostname.endsWith(`.${zoneName}`)) {
    throw new Error(`${label} must be a dedicated subdomain of ${zoneName}`);
  }
  return hostname;
}

export function describeConflicts(
  emailRecords: DnsRecord[],
  hostnameRecords: DnsRecord[],
): string[] {
  const emailConflicts = findDnsConflicts(emailRecords, "email");
  const hostnameConflicts = findDnsConflicts(hostnameRecords, "hostname");

  return [
    ...emailConflicts.map((record) => `${record.name} already has a ${record.type} record`),
    ...hostnameConflicts.map((record) => `${record.name} already has a ${record.type} record`),
  ];
}
