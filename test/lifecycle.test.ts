import { describe, expect, it, vi } from "vitest";
import { CloudflareApi } from "../scripts/setup/cloudflare-api";
import { createConnectionPlan, createDisconnectionPlan } from "../scripts/lifecycle/connect";
import { applyTeardown, createTeardownPlan } from "../scripts/lifecycle/teardown";
import {
  accountsFromZones,
  buildDiagnostics,
  checkMcp,
  discoverAgentMailboxInstances,
  selectInstance,
} from "../scripts/lifecycle/instances";

const account = { id: "account-id", name: "Example Account" };
const credentials = {
  apiKey: "local-secret",
  emailDomain: "mail.example.com",
  healthUrl: "https://mailbox.example.com/health",
  mcpUrl: "https://mailbox.example.com/mcp",
};

function envelope(result: unknown): Response {
  return Response.json({ errors: [], result, success: true });
}

const bindings = [
  { name: "MAILBOXES", type: "durable_object_namespace" },
  { name: "EMAIL", type: "send_email" },
  { bucket_name: "agent-mailbox-example-com-attachments", name: "ATTACHMENTS", type: "r2_bucket" },
  { name: "AGENT_API_KEY", type: "secret_text" },
  { name: "EMAIL_DOMAIN", text: "mail.example.com", type: "plain_text" },
  { name: "MCP_HOSTNAME", text: "mailbox.example.com", type: "plain_text" },
];

describe("Agent Mailbox fleet discovery", () => {
  it("deduplicates Cloudflare accounts represented by multiple zones", () => {
    expect(
      accountsFromZones([
        { account, id: "zone-1", name: "example.com", status: "active" },
        { account, id: "zone-2", name: "example.net", status: "active" },
      ]),
    ).toEqual([account]);
  });

  it("discovers isolated Workers, bindings, custom domains, health, and local credentials", async () => {
    const fetchMock: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "mailbox.example.com") return Response.json({ ok: true });
      if (url.pathname.endsWith("/workers/scripts")) {
        return envelope([{ id: "agent-mailbox-example-com" }, { id: "unrelated-worker" }]);
      }
      if (url.pathname.endsWith("/workers/domains")) {
        return envelope([
          {
            id: "domain-id",
            hostname: "mailbox.example.com",
            service: "agent-mailbox-example-com",
            zone_id: "zone-id",
            zone_name: "example.com",
          },
        ]);
      }
      if (url.pathname.endsWith("/agent-mailbox-example-com/deployments")) {
        return envelope({
          deployments: [{ versions: [{ percentage: 100, version_id: "active-version" }] }],
        });
      }
      if (url.pathname.endsWith("/agent-mailbox-example-com/versions/active-version")) {
        return envelope({ resources: { bindings } });
      }
      if (url.pathname.includes("/email/routing/rules")) {
        return envelope([
          {
            actions: [{ type: "worker", value: ["agent-mailbox-example-com"] }],
            enabled: true,
            id: "rule-id",
            matchers: [{ field: "to", type: "literal", value: "inbox@mail.example.com" }],
          },
        ]);
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    const api = new CloudflareApi({ auth: { type: "oauth", token: "token" }, fetch: fetchMock });

    const instances = await discoverAgentMailboxInstances({
      accounts: [account],
      api,
      credentials,
      fetch: fetchMock,
    });

    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({
      emailDomain: "mail.example.com",
      configuredEmailDomain: "mail.example.com",
      configuredMcpHostname: "mailbox.example.com",
      domainId: "domain-id",
      hasLocalCredentials: true,
      health: "healthy",
      mcpHostname: "mailbox.example.com",
      workerName: "agent-mailbox-example-com",
      zoneId: "zone-id",
    });
    expect(selectInstance(instances, "mail.example.com")).toBe(instances[0]);
  });

  it("uses the active deployment instead of stale uploaded Worker settings", async () => {
    const deployedBindings = bindings.map((binding) => {
      if (binding.name === "EMAIL_DOMAIN") return { ...binding, text: "agents.example.com" };
      if (binding.name === "MCP_HOSTNAME")
        return { ...binding, text: "mailbox.agents.example.com" };
      return binding;
    });
    const fetchMock: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "mailbox.agents.example.com") return Response.json({ ok: true });
      if (url.pathname.endsWith("/workers/scripts")) {
        return envelope([{ id: "agent-mailbox" }]);
      }
      if (url.pathname.endsWith("/workers/domains")) {
        return envelope([
          {
            id: "domain-id",
            hostname: "mailbox.agents.example.com",
            service: "agent-mailbox",
            zone_id: "zone-id",
            zone_name: "example.com",
          },
        ]);
      }
      if (url.pathname.endsWith("/agent-mailbox/settings")) {
        // This endpoint exposes the latest upload, which may not be deployed.
        return envelope({ bindings });
      }
      if (url.pathname.endsWith("/agent-mailbox/deployments")) {
        return envelope({
          deployments: [{ versions: [{ percentage: 100, version_id: "active-version" }] }],
        });
      }
      if (url.pathname.endsWith("/agent-mailbox/versions/active-version")) {
        return envelope({ resources: { bindings: deployedBindings } });
      }
      if (url.pathname.includes("/email/routing/rules")) {
        return envelope([
          {
            actions: [{ type: "worker", value: ["agent-mailbox"] }],
            enabled: true,
            id: "rule-id",
            matchers: [{ field: "to", type: "literal", value: "inbox@agents.example.com" }],
          },
        ]);
      }
      throw new Error(`Unexpected request: ${url}`);
    };
    const api = new CloudflareApi({ auth: { type: "oauth", token: "token" }, fetch: fetchMock });

    const [instance] = await discoverAgentMailboxInstances({
      accounts: [account],
      api,
      credentials,
      fetch: fetchMock,
    });

    expect(instance).toMatchObject({
      configuredEmailDomain: "agents.example.com",
      configuredMcpHostname: "mailbox.agents.example.com",
      emailDomain: "agents.example.com",
      hasLocalCredentials: false,
      health: "healthy",
      mcpHostname: "mailbox.agents.example.com",
      workerName: "agent-mailbox",
    });
  });

  it("keeps a partially torn-down Worker discoverable for a safe retry", async () => {
    const fetchMock: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/workers/scripts")) {
        return envelope([{ id: "agent-mailbox-example-com" }]);
      }
      if (url.pathname.endsWith("/workers/domains")) return envelope([]);
      if (url.pathname.endsWith("/agent-mailbox-example-com/deployments")) {
        return envelope({
          deployments: [{ versions: [{ percentage: 100, version_id: "active-version" }] }],
        });
      }
      if (url.pathname.endsWith("/agent-mailbox-example-com/versions/active-version")) {
        return envelope({ resources: { bindings } });
      }
      if (url.pathname.includes("/email/routing/rules")) return envelope([]);
      throw new Error(`Unexpected request: ${url}`);
    };
    const api = new CloudflareApi({ auth: { type: "oauth", token: "token" }, fetch: fetchMock });

    const [instance] = await discoverAgentMailboxInstances({
      accounts: [account],
      api,
      fetch: fetchMock,
      zones: [{ account, id: "zone-id", name: "example.com", status: "active" }],
    });

    expect(instance).toMatchObject({
      configuredEmailDomain: "mail.example.com",
      emailDomain: "mail.example.com",
      health: "unknown",
      workerName: "agent-mailbox-example-com",
      zoneId: "zone-id",
      zoneName: "example.com",
    });
    expect(instance).not.toHaveProperty("domainId");
  });
});

describe("Agent Mailbox doctor", () => {
  const instance = {
    accountId: account.id,
    accountName: account.name,
    bindings,
    configuredEmailDomain: "mail.example.com",
    configuredMcpHostname: "mailbox.example.com",
    emailDomain: "mail.example.com",
    hasLocalCredentials: true,
    health: "healthy" as const,
    mcpHostname: "mailbox.example.com",
    workerName: "agent-mailbox-example-com",
    zoneId: "zone-id",
    zoneName: "example.com",
  };

  it("reports a complete healthy deployment", () => {
    const diagnostics = buildDiagnostics({
      credentials,
      dnsRecords: [{ content: "route.mx.cloudflare.net", name: "mail.example.com", type: "MX" }],
      instance,
      mcpReachable: true,
      routingRules: [
        {
          actions: [{ type: "worker", value: [instance.workerName] }],
          enabled: true,
          id: "rule-id",
          matchers: [{ field: "to", type: "literal", value: "inbox@mail.example.com" }],
          source: "wrangler",
        },
      ],
    });

    expect(diagnostics.every((diagnostic) => diagnostic.status === "pass")).toBe(true);
  });

  it("authenticates an MCP initialize request without putting the key in the URL", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));

    await expect(checkMcp(credentials, fetchMock)).resolves.toBe(true);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(credentials.mcpUrl);
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("Authorization")).toBe("Bearer local-secret");
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("local-secret");
  });
});

describe("MCP client connection plan", () => {
  it("uses a unique instance name and the credential-reading bridge", () => {
    const plan = createConnectionPlan({
      clients: ["codex", "claude"],
      projectRoot: "/projects/agent-mailbox",
      workerName: "agent-mailbox-example-com",
    });

    expect(plan.connectionName).toBe("agent-mailbox-example-com");
    expect(plan.bridgePath).toBe("/projects/agent-mailbox/bin/agent-mailbox-mcp");
    expect(plan.clients.map((client) => client.adapter.command)).toEqual(["codex", "claude"]);
    expect(
      plan.clients.every((client) => client.skillTarget.endsWith("/skills/agent-mailbox")),
    ).toBe(true);
  });

  it("plans explicit local cleanup without removing shared state by default", () => {
    const plan = createDisconnectionPlan({
      clients: ["codex"],
      projectRoot: "/projects/agent-mailbox",
      removeCredentials: false,
      removeSkill: false,
      workerName: "agent-mailbox-example-com",
    });

    expect(plan).toMatchObject({
      connectionName: "agent-mailbox-example-com",
      removeCredentials: false,
      removeSkill: false,
    });
  });
});

describe("Agent Mailbox teardown plan", () => {
  const instance = {
    accountId: account.id,
    accountName: account.name,
    bindings,
    configuredEmailDomain: "mail.example.com",
    configuredMcpHostname: "mailbox.example.com",
    domainId: "domain-id",
    emailDomain: "mail.example.com",
    hasLocalCredentials: true,
    health: "healthy" as const,
    mcpHostname: "mailbox.example.com",
    workerName: "agent-mailbox-example-com",
    zoneId: "zone-id",
    zoneName: "example.com",
  };
  const routingRules = [
    {
      actions: [{ type: "worker", value: [instance.workerName] }],
      enabled: true,
      id: "owned-rule",
      matchers: [{ field: "to", type: "literal", value: "inbox@mail.example.com" }],
      source: "wrangler",
    },
    {
      actions: [{ type: "worker", value: ["another-worker"] }],
      enabled: true,
      id: "unrelated-rule",
      matchers: [{ field: "to", type: "literal", value: "inbox@mail.example.com" }],
      source: "wrangler",
    },
  ];

  it("targets only the exact Worker rule and preserves R2 by default", () => {
    expect(createTeardownPlan(instance, routingRules, false)).toMatchObject({
      domainId: "domain-id",
      purgeData: false,
      r2Bucket: "agent-mailbox-example-com-attachments",
      routingRuleIds: ["owned-rule"],
    });
  });

  it("refuses a full purge when the deployed R2 bucket cannot be identified", () => {
    expect(() => createTeardownPlan({ ...instance, bindings: [] }, routingRules, true)).toThrow(
      "ATTACHMENTS bucket was not identified",
    );
  });

  it("deletes the Worker only after its routing and custom domain are removed", async () => {
    const calls: string[] = [];
    const api = {
      deleteEmailRoutingRule: async () => {
        calls.push("routing");
      },
      detachWorkerDomain: async () => {
        calls.push("domain");
      },
      deleteWorker: async () => {
        calls.push("worker");
      },
      listR2ObjectKeys: async () => [],
      deleteR2Object: async () => undefined,
      deleteR2Bucket: async () => undefined,
    };

    await applyTeardown(createTeardownPlan(instance, routingRules, false), api);

    expect(calls).toEqual(["routing", "domain", "worker"]);
  });

  it("does not delete the Worker after an earlier teardown mutation fails", async () => {
    const deleteWorker = vi.fn().mockResolvedValue(undefined);
    const api = {
      deleteEmailRoutingRule: vi.fn().mockResolvedValue(undefined),
      detachWorkerDomain: vi.fn().mockRejectedValue(new Error("domain detach failed")),
      deleteWorker,
      listR2ObjectKeys: async () => [],
      deleteR2Object: async () => undefined,
      deleteR2Bucket: async () => undefined,
    };

    await expect(
      applyTeardown(createTeardownPlan(instance, routingRules, false), api),
    ).rejects.toThrow("domain detach failed");
    expect(deleteWorker).not.toHaveBeenCalled();
  });
});
