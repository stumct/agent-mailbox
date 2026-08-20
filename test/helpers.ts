import { SELF } from "cloudflare:test";
import { expect } from "vitest";
import type { MailboxCredentials } from "../src/types";

export const authorization = { Authorization: "Bearer test-master-key" };

export async function createMailbox(): Promise<MailboxCredentials> {
  const response = await SELF.fetch("https://mailbox.example.com/api/mailboxes", {
    method: "POST",
    headers: { ...authorization, "Content-Type": "application/json" },
    body: JSON.stringify({ purpose: "integration", ttlSeconds: 3_600 }),
  });
  expect(response.status).toBe(200);
  return response.json<MailboxCredentials>();
}

export function mailboxUrl(address: string): string {
  return `https://mailbox.example.com/api/mailboxes/${encodeURIComponent(address)}`;
}
