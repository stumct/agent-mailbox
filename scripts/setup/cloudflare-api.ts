import { z } from "zod";

const apiErrorSchema = z.object({
  code: z.union([z.number(), z.string()]),
  message: z.string(),
});

const envelopeSchema = z.object({
  errors: z
    .array(apiErrorSchema)
    .nullish()
    .transform((errors) => errors ?? []),
  result: z.unknown().optional(),
  result_info: z
    .object({
      cursor: z
        .string()
        .nullish()
        .transform((cursor) => cursor ?? undefined),
      total_pages: z.number().optional(),
    })
    .optional(),
  success: z.boolean(),
});

const zoneSchema = z.object({
  account: z.object({ id: z.string(), name: z.string() }),
  id: z.string(),
  name: z.string(),
  status: z.string(),
});

const sendingSubdomainSchema = z.object({
  enabled: z.boolean(),
  name: z.string(),
  tag: z.string(),
});

const routingDnsSchema = z.object({
  errors: z.array(z.unknown()).nullable(),
  records: z.array(z.unknown()),
});

const workerSchema = z.object({ id: z.string() }).passthrough();

const workerDomainSchema = z
  .object({
    id: z.string(),
    hostname: z.string(),
    service: z.string(),
    zone_id: z.string(),
    zone_name: z.string(),
  })
  .passthrough();

const workerBindingSchema = z
  .object({
    name: z.string(),
    text: z.string().optional(),
    type: z.string(),
  })
  .passthrough();

const workerDeploymentListSchema = z.object({
  deployments: z.array(
    z
      .object({
        versions: z.array(
          z.object({
            percentage: z.number(),
            version_id: z.string(),
          }),
        ),
      })
      .passthrough(),
  ),
});

const workerVersionSchema = z
  .object({
    resources: z
      .object({
        bindings: z.array(workerBindingSchema).default([]),
      })
      .passthrough(),
  })
  .passthrough();

const emailRoutingRuleSchema = z
  .object({
    id: z.string(),
    actions: z
      .array(
        z
          .object({
            type: z.string(),
            value: z.array(z.string()).optional(),
          })
          .passthrough(),
      )
      .default([]),
    enabled: z.boolean().optional(),
    matchers: z
      .array(
        z
          .object({
            field: z.string().optional(),
            type: z.string(),
            value: z.string().optional(),
          })
          .passthrough(),
      )
      .default([]),
    source: z.string().optional(),
  })
  .passthrough();

const r2ObjectSchema = z.object({ key: z.string() }).passthrough();

export const wranglerAuthSchema = z.discriminatedUnion("type", [
  z.object({ type: z.enum(["api_token", "oauth"]), token: z.string().min(1) }),
  z.object({ type: z.literal("api_key"), email: z.string().min(1), key: z.string().min(1) }),
]);

export type WranglerAuth = z.infer<typeof wranglerAuthSchema>;
export type CloudflareZone = z.infer<typeof zoneSchema>;
export type CloudflareWorker = z.infer<typeof workerSchema>;
export type CloudflareWorkerDomain = z.infer<typeof workerDomainSchema>;
export type CloudflareWorkerBinding = z.infer<typeof workerBindingSchema>;
export type CloudflareEmailRoutingRule = z.infer<typeof emailRoutingRuleSchema>;

export class CloudflareApiError extends Error {
  readonly errors: Array<z.infer<typeof apiErrorSchema>>;
  readonly status: number;

  constructor(message: string, errors: Array<z.infer<typeof apiErrorSchema>>, status: number) {
    super(message);
    this.name = "CloudflareApiError";
    this.errors = errors;
    this.status = status;
  }
}

type CloudflareApiOptions = {
  auth: WranglerAuth;
  fetch?: typeof globalThis.fetch;
};

export class CloudflareApi {
  readonly #auth: WranglerAuth;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: CloudflareApiOptions) {
    this.#auth = options.auth;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async listZones(): Promise<CloudflareZone[]> {
    const zones: CloudflareZone[] = [];
    let page = 1;
    let totalPages = 1;

    do {
      const query = new URLSearchParams({ page: String(page), per_page: "50", status: "active" });
      const response = await this.#request(`/zones?${query.toString()}`, {
        resultSchema: z.array(zoneSchema),
      });
      zones.push(...response.result);
      totalPages = response.totalPages ?? 1;
      page += 1;
    } while (page <= totalPages);

    return zones.toSorted((left, right) => left.name.localeCompare(right.name));
  }

  async listWorkers(accountId: string): Promise<CloudflareWorker[]> {
    const response = await this.#request(
      `/accounts/${encodeURIComponent(accountId)}/workers/scripts`,
      { resultSchema: z.array(workerSchema) },
    );
    return response.result;
  }

  async listWorkerDomains(accountId: string): Promise<CloudflareWorkerDomain[]> {
    const response = await this.#request(
      `/accounts/${encodeURIComponent(accountId)}/workers/domains`,
      { resultSchema: z.array(workerDomainSchema) },
    );
    return response.result;
  }

  async getDeployedWorkerBindings(
    accountId: string,
    workerName: string,
  ): Promise<CloudflareWorkerBinding[]> {
    const workerPath = `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}`;
    const deployments = await this.#request(`${workerPath}/deployments`, {
      resultSchema: workerDeploymentListSchema,
    });
    const activeDeployment = deployments.result.deployments[0];
    const activeVersion = activeDeployment?.versions.toSorted(
      (left, right) => right.percentage - left.percentage,
    )[0];
    if (!activeVersion) {
      throw new Error(`Worker ${workerName} has no active deployment`);
    }

    const version = await this.#request(
      `${workerPath}/versions/${encodeURIComponent(activeVersion.version_id)}`,
      { resultSchema: workerVersionSchema },
    );
    return version.result.resources.bindings;
  }

  async listEmailRoutingRules(zoneId: string): Promise<CloudflareEmailRoutingRule[]> {
    const rules: CloudflareEmailRoutingRule[] = [];
    let page = 1;
    let totalPages = 1;

    do {
      const query = new URLSearchParams({ page: String(page), per_page: "50" });
      const response = await this.#request(
        `/zones/${encodeURIComponent(zoneId)}/email/routing/rules?${query.toString()}`,
        { resultSchema: z.array(emailRoutingRuleSchema) },
      );
      rules.push(...response.result);
      totalPages = response.totalPages ?? 1;
      page += 1;
    } while (page <= totalPages);

    return rules;
  }

  async enableEmailRouting(zoneId: string, emailDomain: string): Promise<void> {
    const path = `/zones/${encodeURIComponent(zoneId)}/email/routing/dns`;
    const query = new URLSearchParams({ subdomain: emailDomain });
    const current = await this.#request(`${path}?${query.toString()}`, {
      resultSchema: routingDnsSchema,
    });

    if ((current.result.errors?.length ?? 0) === 0 && current.result.records.length > 0) {
      return;
    }

    await this.#request(path, {
      body: { name: emailDomain },
      method: "POST",
      resultSchema: z.unknown(),
    });
  }

  async enableSubaddressing(zoneId: string): Promise<void> {
    await this.#request(`/zones/${encodeURIComponent(zoneId)}/email/routing`, {
      body: { support_subaddress: true },
      method: "PATCH",
      resultSchema: z.unknown(),
    });
  }

  async enableEmailSending(zoneId: string, emailDomain: string): Promise<void> {
    const path = `/zones/${encodeURIComponent(zoneId)}/email/sending/subdomains`;
    const existing = await this.#request(path, { resultSchema: z.array(sendingSubdomainSchema) });
    if (existing.result.some((subdomain) => subdomain.name === emailDomain && subdomain.enabled)) {
      return;
    }

    await this.#request(path, {
      body: { name: emailDomain },
      method: "POST",
      resultSchema: sendingSubdomainSchema,
    });
  }

  async deleteEmailRoutingRule(zoneId: string, ruleId: string): Promise<void> {
    await this.#request(
      `/zones/${encodeURIComponent(zoneId)}/email/routing/rules/${encodeURIComponent(ruleId)}`,
      { method: "DELETE", resultSchema: z.unknown() },
    );
  }

  async detachWorkerDomain(accountId: string, domainId: string): Promise<void> {
    await this.#request(
      `/accounts/${encodeURIComponent(accountId)}/workers/domains/${encodeURIComponent(domainId)}`,
      { method: "DELETE", resultSchema: z.unknown() },
    );
  }

  async deleteWorker(accountId: string, workerName: string): Promise<void> {
    const query = new URLSearchParams({ force: "true" });
    await this.#request(
      `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}?${query.toString()}`,
      { method: "DELETE", resultSchema: z.unknown() },
    );
  }

  async listR2ObjectKeys(accountId: string, bucketName: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;

    do {
      const query = new URLSearchParams({ per_page: "1000" });
      if (cursor) query.set("cursor", cursor);
      const response = await this.#request(
        `/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucketName)}/objects?${query.toString()}`,
        { resultSchema: z.array(r2ObjectSchema) },
      );
      keys.push(...response.result.map((object) => object.key));
      cursor = response.cursor;
    } while (cursor);

    return keys;
  }

  async deleteR2Object(accountId: string, bucketName: string, key: string): Promise<void> {
    const encodedKey = key.split("/").map(encodeURIComponent).join("/");
    await this.#request(
      `/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucketName)}/objects/${encodedKey}`,
      { method: "DELETE", resultSchema: z.unknown() },
    );
  }

  async deleteR2Bucket(accountId: string, bucketName: string): Promise<void> {
    await this.#request(
      `/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucketName)}`,
      { method: "DELETE", resultSchema: z.unknown() },
    );
  }

  async #request<Result>(
    path: string,
    options: {
      body?: object;
      method?: "DELETE" | "GET" | "PATCH" | "POST";
      resultSchema: z.ZodType<Result>;
    },
  ): Promise<{ cursor?: string; result: Result; totalPages?: number }> {
    const headers = new Headers({ Accept: "application/json" });
    if (this.#auth.type === "api_key") {
      headers.set("X-Auth-Email", this.#auth.email);
      headers.set("X-Auth-Key", this.#auth.key);
    } else {
      headers.set("Authorization", `Bearer ${this.#auth.token}`);
    }
    if (options.body) headers.set("Content-Type", "application/json");

    const response = await this.#fetch(`https://api.cloudflare.com/client/v4${path}`, {
      body: options.body ? JSON.stringify(options.body) : undefined,
      headers,
      method: options.method ?? "GET",
    });
    const responseBody = await response.text();
    if (responseBody.length === 0) {
      if (!response.ok) {
        throw new CloudflareApiError(
          `Cloudflare API request failed with HTTP ${response.status}`,
          [],
          response.status,
        );
      }
      return { result: options.resultSchema.parse(undefined) };
    }
    const envelope = envelopeSchema.parse(JSON.parse(responseBody));
    if (!response.ok || !envelope.success) {
      const detail = envelope.errors.map((error) => error.message).join("; ");
      throw new CloudflareApiError(
        detail || `Cloudflare API request failed with HTTP ${response.status}`,
        envelope.errors,
        response.status,
      );
    }

    return {
      result: options.resultSchema.parse(envelope.result),
      ...(envelope.result_info?.cursor === undefined
        ? {}
        : { cursor: envelope.result_info.cursor }),
      ...(envelope.result_info?.total_pages === undefined
        ? {}
        : { totalPages: envelope.result_info.total_pages }),
    };
  }
}
