import type {
  CloudflareApi,
  CloudflareEmailRoutingRule,
  CloudflareWorkerBinding,
  CloudflareZone,
} from "../setup/cloudflare-api.ts";
import type { DnsRecord } from "../setup/dns.ts";
import { credentialsMatch, type LocalCredentials } from "./credentials.ts";

export type CloudflareAccount = {
  id: string;
  name: string;
};

export type AgentMailboxInstance = {
  accountId: string;
  accountName: string;
  bindings: CloudflareWorkerBinding[];
  configuredEmailDomain?: string;
  configuredMcpHostname?: string;
  domainId?: string;
  emailDomain?: string;
  health: "healthy" | "unreachable" | "unknown";
  hasLocalCredentials: boolean;
  mcpHostname?: string;
  workerName: string;
  zoneId?: string;
  zoneName?: string;
};

export type Diagnostic = {
  detail: string;
  label: string;
  status: "pass" | "warn" | "fail";
};

const expectedBindings = new Map([
  ["MAILBOXES", "durable_object_namespace"],
  ["EMAIL", "send_email"],
  ["ATTACHMENTS", "r2_bucket"],
  ["AGENT_API_KEY", "secret_text"],
  ["EMAIL_DOMAIN", "plain_text"],
  ["MCP_HOSTNAME", "plain_text"],
]);

export function accountsFromZones(zones: CloudflareZone[]): CloudflareAccount[] {
  return [...new Map(zones.map((zone) => [zone.account.id, zone.account])).values()].toSorted(
    (left, right) => left.name.localeCompare(right.name),
  );
}

function isAgentMailboxWorker(name: string): boolean {
  return name === "agent-mailbox" || name.startsWith("agent-mailbox-");
}

function textBinding(bindings: CloudflareWorkerBinding[], name: string): string | undefined {
  return bindings.find((binding) => binding.name === name && binding.type === "plain_text")?.text;
}

function routedEmailDomains(rules: CloudflareEmailRoutingRule[], workerName: string): string[] {
  const domains = rules.flatMap((rule) => {
    const routesToWorker =
      rule.enabled !== false &&
      rule.actions.some((action) => action.type === "worker" && action.value?.includes(workerName));
    if (!routesToWorker) return [];
    return rule.matchers.flatMap((matcher) => {
      if (matcher.field !== "to" || !matcher.value) return [];
      const [localPart, domain, ...extra] = matcher.value.toLowerCase().split("@");
      return localPart === "inbox" && domain && extra.length === 0 ? [domain] : [];
    });
  });
  return [...new Set(domains)].toSorted();
}

async function checkHealth(
  hostname: string | undefined,
  fetch: typeof globalThis.fetch,
): Promise<AgentMailboxInstance["health"]> {
  if (!hostname) return "unknown";
  try {
    const response = await fetch(`https://${hostname}/health`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok ? "healthy" : "unreachable";
  } catch {
    return "unreachable";
  }
}

/** Discovers every isolated deployment from Cloudflare; the checkout is not the source of truth. */
export async function discoverAgentMailboxInstances(options: {
  accounts: CloudflareAccount[];
  api: CloudflareApi;
  credentials?: LocalCredentials;
  fetch?: typeof globalThis.fetch;
  zones?: CloudflareZone[];
}): Promise<AgentMailboxInstance[]> {
  const fetch = options.fetch ?? globalThis.fetch;
  const accountInstances = await Promise.all(
    options.accounts.map(async (account) => {
      const [workers, domains] = await Promise.all([
        options.api.listWorkers(account.id),
        options.api.listWorkerDomains(account.id),
      ]);
      const candidates = workers.filter((worker) => isAgentMailboxWorker(worker.id));
      const candidateNames = new Set(candidates.map((worker) => worker.id));
      const candidateDomains = domains.filter((domain) => candidateNames.has(domain.service));
      const accountZones = options.zones?.filter((zone) => zone.account.id === account.id) ?? [];
      const bindingsByWorker = new Map(
        await Promise.all(
          candidates.map(
            async (worker) =>
              [
                worker.id,
                await options.api.getDeployedWorkerBindings(account.id, worker.id),
              ] as const,
          ),
        ),
      );
      const zoneIds = [
        ...new Set([
          ...candidateDomains.map((domain) => domain.zone_id),
          ...candidates.flatMap((worker) => {
            const configuredEmailDomain = textBinding(
              bindingsByWorker.get(worker.id) ?? [],
              "EMAIL_DOMAIN",
            );
            const zone = accountZones
              .filter(
                (candidate) =>
                  configuredEmailDomain === candidate.name ||
                  configuredEmailDomain?.endsWith(`.${candidate.name}`),
              )
              .toSorted((left, right) => right.name.length - left.name.length)[0];
            return zone ? [zone.id] : [];
          }),
        ]),
      ];
      const routingRules = new Map(
        await Promise.all(
          zoneIds.map(
            async (zoneId) => [zoneId, await options.api.listEmailRoutingRules(zoneId)] as const,
          ),
        ),
      );

      return Promise.all(
        candidates.map(async (worker) => {
          const bindings = bindingsByWorker.get(worker.id) ?? [];
          const configuredEmailDomain = textBinding(bindings, "EMAIL_DOMAIN");
          const configuredMcpHostname = textBinding(bindings, "MCP_HOSTNAME");
          const workerDomains = domains.filter((domain) => domain.service === worker.id);
          const domain =
            workerDomains.find((candidate) => candidate.hostname === configuredMcpHostname) ??
            workerDomains[0];
          const workerRules = [...routingRules.values()].flat();
          const routedDomains = routedEmailDomains(workerRules, worker.id);
          const emailDomain =
            configuredEmailDomain && routedDomains.includes(configuredEmailDomain)
              ? configuredEmailDomain
              : (routedDomains[0] ?? configuredEmailDomain);
          const mcpHostname = domain?.hostname;
          const configuredZone = accountZones
            .filter(
              (zone) =>
                configuredEmailDomain === zone.name ||
                configuredEmailDomain?.endsWith(`.${zone.name}`),
            )
            .toSorted((left, right) => right.name.length - left.name.length)[0];
          const zoneId = domain?.zone_id ?? configuredZone?.id;
          const zoneName = domain?.zone_name ?? configuredZone?.name;
          const health = await checkHealth(mcpHostname, fetch);

          return {
            accountId: account.id,
            accountName: account.name,
            bindings,
            ...(configuredEmailDomain ? { configuredEmailDomain } : {}),
            ...(configuredMcpHostname ? { configuredMcpHostname } : {}),
            ...(domain ? { domainId: domain.id } : {}),
            ...(emailDomain ? { emailDomain } : {}),
            health,
            hasLocalCredentials: credentialsMatch(options.credentials, {
              emailDomain,
              mcpHostname,
            }),
            ...(mcpHostname ? { mcpHostname } : {}),
            workerName: worker.id,
            ...(zoneId ? { zoneId } : {}),
            ...(zoneName ? { zoneName } : {}),
          } satisfies AgentMailboxInstance;
        }),
      );
    }),
  );

  return accountInstances
    .flat()
    .toSorted((left, right) => left.workerName.localeCompare(right.workerName));
}

export function configurationMismatches(instance: AgentMailboxInstance): string[] {
  return [
    ...(instance.configuredEmailDomain &&
    instance.emailDomain &&
    instance.configuredEmailDomain !== instance.emailDomain
      ? [`EMAIL_DOMAIN is ${instance.configuredEmailDomain}; routing uses ${instance.emailDomain}`]
      : []),
    ...(instance.configuredMcpHostname &&
    instance.mcpHostname &&
    instance.configuredMcpHostname !== instance.mcpHostname
      ? [
          `MCP_HOSTNAME is ${instance.configuredMcpHostname}; attached domain is ${instance.mcpHostname}`,
        ]
      : []),
  ];
}

export function selectInstance(
  instances: AgentMailboxInstance[],
  requested: string | undefined,
  currentWorkerName?: string,
): AgentMailboxInstance {
  const identifier = requested ?? currentWorkerName;
  if (!identifier) {
    if (instances.length === 1) return instances[0]!;
    throw new Error("Choose an instance by Worker name, email domain, or MCP hostname");
  }
  const instance = instances.find(
    (candidate) =>
      candidate.workerName === identifier ||
      candidate.emailDomain === identifier ||
      candidate.configuredEmailDomain === identifier ||
      candidate.mcpHostname === identifier ||
      candidate.configuredMcpHostname === identifier,
  );
  if (!instance) throw new Error(`Agent Mailbox instance not found: ${identifier}`);
  return instance;
}

export function matchingRoutingRules(
  instance: AgentMailboxInstance,
  rules: CloudflareEmailRoutingRule[],
): CloudflareEmailRoutingRule[] {
  const emailDomain = instance.configuredEmailDomain ?? instance.emailDomain;
  const address = emailDomain ? `inbox@${emailDomain}` : undefined;
  if (!address) return [];
  return rules.filter(
    (rule) =>
      rule.matchers.some((matcher) => matcher.field === "to" && matcher.value === address) &&
      rule.actions.some(
        (action) => action.type === "worker" && action.value?.includes(instance.workerName),
      ),
  );
}

export function r2BucketName(instance: AgentMailboxInstance): string | undefined {
  const binding = instance.bindings.find(
    (candidate) => candidate.name === "ATTACHMENTS" && candidate.type === "r2_bucket",
  );
  return typeof binding?.bucket_name === "string" ? binding.bucket_name : undefined;
}

function hasRoutingRule(
  instance: AgentMailboxInstance,
  rules: CloudflareEmailRoutingRule[],
): boolean {
  const address = instance.emailDomain ? `inbox@${instance.emailDomain}` : undefined;
  if (!address) return false;
  return rules.some(
    (rule) =>
      rule.enabled !== false &&
      rule.matchers.some((matcher) => matcher.field === "to" && matcher.value === address) &&
      rule.actions.some(
        (action) => action.type === "worker" && action.value?.includes(instance.workerName),
      ),
  );
}

export function buildDiagnostics(options: {
  credentials?: LocalCredentials;
  dnsRecords: DnsRecord[];
  instance: AgentMailboxInstance;
  mcpReachable?: boolean;
  routingRules: CloudflareEmailRoutingRule[];
}): Diagnostic[] {
  const { instance } = options;
  const missingBindings = [...expectedBindings]
    .filter(
      ([name, type]) =>
        !instance.bindings.some((binding) => binding.name === name && binding.type === type),
    )
    .map(([name]) => name);
  const credentialAvailable = credentialsMatch(options.credentials, instance);
  const mismatches = configurationMismatches(instance);

  return [
    { label: "Worker", status: "pass", detail: instance.workerName },
    mismatches.length === 0
      ? {
          label: "Configuration",
          status: "pass",
          detail: "Worker variables match attached Cloudflare resources",
        }
      : { label: "Configuration", status: "fail", detail: mismatches.join("; ") },
    missingBindings.length === 0
      ? {
          label: "Bindings",
          status: "pass",
          detail: "Durable Object, email, R2, variables, and secret are configured",
        }
      : {
          label: "Bindings",
          status: "fail",
          detail: `Missing or invalid: ${missingBindings.join(", ")}`,
        },
    instance.mcpHostname && instance.zoneId
      ? { label: "Custom domain", status: "pass", detail: instance.mcpHostname }
      : { label: "Custom domain", status: "fail", detail: "No custom Worker domain found" },
    hasRoutingRule(instance, options.routingRules)
      ? {
          label: "Email routing",
          status: "pass",
          detail: `inbox@${instance.emailDomain} routes to this Worker`,
        }
      : {
          label: "Email routing",
          status: "fail",
          detail: "Expected inbound Worker rule was not found",
        },
    options.dnsRecords.some((record) => record.type === "MX")
      ? {
          label: "Email DNS",
          status: "pass",
          detail: `MX records resolve for ${instance.emailDomain}`,
        }
      : {
          label: "Email DNS",
          status: "fail",
          detail: `No MX records resolve for ${instance.emailDomain ?? "the email domain"}`,
        },
    instance.health === "healthy"
      ? { label: "Health", status: "pass", detail: `https://${instance.mcpHostname}/health` }
      : { label: "Health", status: "fail", detail: "The public health endpoint is not responding" },
    credentialAvailable
      ? { label: "Credentials", status: "pass", detail: "Matching local credentials are available" }
      : { label: "Credentials", status: "warn", detail: "This checkout has no matching API key" },
    options.mcpReachable === true
      ? { label: "MCP", status: "pass", detail: "Authenticated MCP initialization succeeded" }
      : options.mcpReachable === false
        ? { label: "MCP", status: "fail", detail: "Authenticated MCP initialization failed" }
        : {
            label: "MCP",
            status: "warn",
            detail: "Skipped because matching local credentials are unavailable",
          },
  ];
}

export async function checkMcp(
  credentials: LocalCredentials,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<boolean> {
  try {
    const response = await fetch(credentials.mcpUrl, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "agent-mailbox-doctor", version: "0.1.0" },
          protocolVersion: "2025-11-25",
        },
      }),
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${credentials.apiKey}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
