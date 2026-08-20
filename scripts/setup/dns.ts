import { z } from "zod";

const dnsRecordTypes = {
  A: 1,
  NS: 2,
  CNAME: 5,
  MX: 15,
  AAAA: 28,
} as const;

const dnsAnswerSchema = z.object({
  data: z.string(),
  name: z.string(),
  type: z.number(),
});

const dnsResponseSchema = z.object({
  Answer: z.array(dnsAnswerSchema).optional(),
  Status: z.number(),
});

export type DnsRecordType = keyof typeof dnsRecordTypes;

export type DnsRecord = {
  content: string;
  name: string;
  type: DnsRecordType;
};

type DnsLookupOptions = {
  fetch?: typeof globalThis.fetch;
  types: DnsRecordType[];
};

const dnsTypeByCode = new Map<number, DnsRecordType>([
  [dnsRecordTypes.A, "A"],
  [dnsRecordTypes.AAAA, "AAAA"],
  [dnsRecordTypes.CNAME, "CNAME"],
  [dnsRecordTypes.MX, "MX"],
  [dnsRecordTypes.NS, "NS"],
]);

function normalizeDnsName(name: string): string {
  return name.toLowerCase().replace(/\.$/u, "");
}

/** Inspect public DNS without requiring permissions that Wrangler OAuth cannot grant. */
export async function listDnsRecords(
  hostname: string,
  options: DnsLookupOptions,
): Promise<DnsRecord[]> {
  const fetchDns = options.fetch ?? globalThis.fetch;
  const normalizedHostname = normalizeDnsName(hostname);
  const responses = await Promise.all(
    options.types.map(async (type) => {
      const query = new URLSearchParams({ name: normalizedHostname, type });
      const response = await fetchDns(`https://cloudflare-dns.com/dns-query?${query.toString()}`, {
        headers: { Accept: "application/dns-json" },
      });
      if (!response.ok) {
        throw new Error(
          `DNS lookup for ${normalizedHostname} (${type}) failed with HTTP ${response.status}`,
        );
      }

      const result = dnsResponseSchema.parse(await response.json());
      if (result.Status !== 0 && result.Status !== 3) {
        throw new Error(
          `DNS lookup for ${normalizedHostname} (${type}) failed with status ${result.Status}`,
        );
      }
      return result.Answer ?? [];
    }),
  );

  const records = new Map<string, DnsRecord>();
  for (const answer of responses.flat()) {
    const type = dnsTypeByCode.get(answer.type);
    const name = normalizeDnsName(answer.name);
    if (!type || name !== normalizedHostname) continue;

    const record = { content: answer.data, name, type };
    records.set(`${record.name}:${record.type}:${record.content}`, record);
  }
  return [...records.values()];
}

export function findDnsConflicts(records: DnsRecord[], purpose: "email" | "hostname"): DnsRecord[] {
  if (purpose === "hostname") return records;

  return records.filter((record) => {
    if (record.type === "MX" && /\.mx\.cloudflare\.net\.?$/iu.test(record.content)) return false;
    return record.type === "MX" || record.type === "CNAME";
  });
}
