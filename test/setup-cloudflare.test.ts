import { describe, expect, it, vi } from "vitest";
import { CloudflareApi } from "../scripts/setup/cloudflare-api";
import { createSetupPlan, describeConflicts, recommendedDeployment } from "../scripts/setup/plan";
import {
  isProfileBoundTo,
  parseWranglerProfiles,
  withWranglerProfile,
} from "../scripts/setup/profiles";

const zone = {
  account: { id: "account-id", name: "Example Account" },
  id: "zone-id",
  name: "example.com",
  status: "active",
};

function jsonResponse(result: unknown, options?: { status?: number; success?: boolean }): Response {
  return Response.json(
    {
      errors: options?.success === false ? [{ code: 1000, message: "not allowed" }] : [],
      result,
      success: options?.success ?? true,
    },
    { status: options?.status ?? 200 },
  );
}

describe("Cloudflare setup plan", () => {
  it("uses safe dedicated subdomains by default", () => {
    expect(recommendedDeployment(zone)).toMatchObject({
      emailDomain: "mail.example.com",
      mcpHostname: "mailbox.example.com",
      workerName: "agent-mailbox-example-com",
      zoneName: "example.com",
    });
  });

  it("uses an isolated Worker for each zone", () => {
    const first = recommendedDeployment(zone).workerName;
    const second = recommendedDeployment({
      ...zone,
      id: "other-zone",
      name: "example.net",
    }).workerName;

    expect(first).not.toBe(second);
  });

  it("keeps deterministic Worker names within Wrangler's workers.dev limit", () => {
    const longZone = {
      ...zone,
      name: `${"a".repeat(63)}.${"b".repeat(63)}.example.com`,
    };
    const first = recommendedDeployment(longZone).workerName;
    const second = recommendedDeployment(longZone).workerName;

    expect(first).toBe(second);
    expect(first.length).toBeLessThanOrEqual(63);
    expect(first).toMatch(/^agent-mailbox-[a-z0-9-]+$/u);
  });

  it("rejects apex, unrelated, and overlapping hostnames", () => {
    expect(() =>
      createSetupPlan(zone, {
        emailDomain: "example.com",
        mcpHostname: "mailbox.example.com",
      }),
    ).toThrow("dedicated subdomain");
    expect(() =>
      createSetupPlan(zone, {
        emailDomain: "mail.example.net",
        mcpHostname: "mailbox.example.com",
      }),
    ).toThrow("dedicated subdomain");
    expect(() =>
      createSetupPlan(zone, {
        emailDomain: "mail.example.com",
        mcpHostname: "mail.example.com",
      }),
    ).toThrow("must be different");
  });

  it("describes unsafe DNS conflicts", () => {
    expect(
      describeConflicts(
        [{ name: "mail.example.com", type: "MX", content: "mx.example.net" }],
        [{ name: "mailbox.example.com", type: "A", content: "192.0.2.1" }],
      ),
    ).toEqual([
      "mail.example.com already has a MX record",
      "mailbox.example.com already has a A record",
    ]);
  });
});

describe("Wrangler profiles", () => {
  const output = `\u001b[33mWrangler profiles\u001b[0m
┌──────────┬──────────────────────┐
│ Profile  │ Bound Directories    │
├──────────┼──────────────────────┤
│ work     │ /projects/work       │
├──────────┼──────────────────────┤
│ default  │ -                    │
└──────────┴──────────────────────┘`;

  it("parses profile names and directory bindings from Wrangler's table", () => {
    expect(parseWranglerProfiles(output)).toEqual([
      { boundDirectories: ["/projects/work"], name: "work" },
      { boundDirectories: [], name: "default" },
    ]);
  });

  it("handles an empty profile store but fails closed if Wrangler changes its output", () => {
    expect(
      parseWranglerProfiles("No profiles found. Run `wrangler login` to get started."),
    ).toEqual([]);
    expect(() => parseWranglerProfiles("Wrangler returned an unfamiliar format")).toThrow(
      "pass --profile explicitly",
    );
  });

  it("detects inherited directory bindings and appends explicit profile flags", () => {
    const [work] = parseWranglerProfiles(output);
    expect(work && isProfileBoundTo(work, "/projects/work/agent-mailbox")).toBe(true);
    expect(withWranglerProfile(["deploy"], "work")).toEqual(["deploy", "--profile", "work"]);
    expect(withWranglerProfile(["deploy"])).toEqual(["deploy"]);
  });
});

describe("Cloudflare setup API", () => {
  it("accepts null errors in successful Cloudflare response envelopes", async () => {
    const api = new CloudflareApi({
      auth: { type: "oauth", token: "wrangler-token" },
      fetch: async () =>
        Response.json({
          errors: null,
          result: [{ id: "agent-mailbox-example-com" }],
          success: true,
        }),
    });

    await expect(api.listWorkers("account-id")).resolves.toEqual([
      { id: "agent-mailbox-example-com" },
    ]);
  });

  it("lists active zones using the Wrangler bearer token", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        errors: [],
        result: [zone],
        result_info: { total_pages: 1 },
        success: true,
      }),
    );
    const api = new CloudflareApi({
      auth: { type: "oauth", token: "wrangler-token" },
      fetch: fetchMock,
    });

    await expect(api.listZones()).resolves.toEqual([zone]);
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("Authorization")).toBe("Bearer wrangler-token");
  });

  it("provisions routing, subaddressing, and a sending subdomain idempotently", async () => {
    const requests: Array<{ method: string; pathname: string }> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      requests.push({ method: init?.method ?? "GET", pathname: url.pathname });

      if (url.pathname.endsWith("/email/routing/dns") && init?.method !== "POST") {
        return jsonResponse({ errors: [{ code: "mx.missing" }], records: [{}] });
      }
      if (url.pathname.endsWith("/email/sending/subdomains") && init?.method !== "POST") {
        return jsonResponse([]);
      }
      if (url.pathname.endsWith("/email/sending/subdomains")) {
        return jsonResponse({ enabled: true, name: "mail.example.com", tag: "sending-id" });
      }
      return jsonResponse({});
    };
    const api = new CloudflareApi({
      auth: { type: "api_token", token: "test-token" },
      fetch: fetchMock,
    });

    await api.enableEmailRouting(zone.id, "mail.example.com");
    await api.enableSubaddressing(zone.id);
    await api.enableEmailSending(zone.id, "mail.example.com");

    expect(requests).toEqual([
      { method: "GET", pathname: "/client/v4/zones/zone-id/email/routing/dns" },
      { method: "POST", pathname: "/client/v4/zones/zone-id/email/routing/dns" },
      { method: "PATCH", pathname: "/client/v4/zones/zone-id/email/routing" },
      { method: "GET", pathname: "/client/v4/zones/zone-id/email/sending/subdomains" },
      { method: "POST", pathname: "/client/v4/zones/zone-id/email/sending/subdomains" },
    ]);
  });

  it("recognises existing Email Routing DNS returned by Cloudflare", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        errors: null,
        records: [{ name: "mail.example.com", type: "MX" }],
      }),
    );
    const api = new CloudflareApi({
      auth: { type: "oauth", token: "wrangler-token" },
      fetch: fetchMock,
    });

    await api.enableEmailRouting(zone.id, "mail.example.com");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
  });

  it("surfaces Cloudflare API errors without leaking credentials", async () => {
    const api = new CloudflareApi({
      auth: { type: "api_token", token: "secret-token" },
      fetch: async () => jsonResponse(null, { status: 403, success: false }),
    });

    await expect(api.listZones()).rejects.toMatchObject({
      message: "not allowed",
      status: 403,
    });
    await expect(api.listZones()).rejects.not.toThrow("secret-token");
  });

  it("deletes only explicitly identified routing, domain, and R2 resources", async () => {
    const requests: Array<{ method: string; pathname: string; search: string }> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      requests.push({ method: init?.method ?? "GET", pathname: url.pathname, search: url.search });
      if (url.pathname.endsWith("/objects")) {
        return Response.json({
          errors: [],
          result: [{ key: "mailbox/message attachment.txt" }],
          success: true,
        });
      }
      if (url.pathname.endsWith("/workers/scripts/agent-mailbox-example-com")) {
        return new Response(null, { status: 204 });
      }
      return jsonResponse(null);
    };
    const api = new CloudflareApi({ auth: { type: "oauth", token: "token" }, fetch: fetchMock });

    await api.deleteEmailRoutingRule("zone-id", "rule-id");
    await api.detachWorkerDomain("account-id", "domain-id");
    await expect(api.listR2ObjectKeys("account-id", "bucket-name")).resolves.toEqual([
      "mailbox/message attachment.txt",
    ]);
    await api.deleteR2Object("account-id", "bucket-name", "mailbox/message attachment.txt");
    await api.deleteR2Bucket("account-id", "bucket-name");
    await api.deleteWorker("account-id", "agent-mailbox-example-com");

    expect(requests).toEqual([
      {
        method: "DELETE",
        pathname: "/client/v4/zones/zone-id/email/routing/rules/rule-id",
        search: "",
      },
      {
        method: "DELETE",
        pathname: "/client/v4/accounts/account-id/workers/domains/domain-id",
        search: "",
      },
      {
        method: "GET",
        pathname: "/client/v4/accounts/account-id/r2/buckets/bucket-name/objects",
        search: "?per_page=1000",
      },
      {
        method: "DELETE",
        pathname:
          "/client/v4/accounts/account-id/r2/buckets/bucket-name/objects/mailbox/message%20attachment.txt",
        search: "",
      },
      {
        method: "DELETE",
        pathname: "/client/v4/accounts/account-id/r2/buckets/bucket-name",
        search: "",
      },
      {
        method: "DELETE",
        pathname: "/client/v4/accounts/account-id/workers/scripts/agent-mailbox-example-com",
        search: "?force=true",
      },
    ]);
  });
});
