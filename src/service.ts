import PostalMime from "postal-mime";
import { z } from "zod";
import { randomToken, hashSecret } from "./crypto";
import type {
  AppEnv,
  InboundMessage,
  MailboxCredentials,
  StoredAttachment,
  StoredMessage,
  WaitFilter,
} from "./types";

export const createMailboxInput = z.object({
  purpose: z.string().trim().min(1).max(48).optional(),
  ttlSeconds: z.number().int().positive().optional(),
});

export const mailboxAccessInput = z.object({
  address: z.email(),
  mailboxToken: z.string().min(20),
});

export const waitInput = mailboxAccessInput.extend({
  from: z.string().max(320).optional(),
  subject: z.string().max(200).optional(),
  after: z.iso.datetime().optional(),
  timeoutSeconds: z.number().int().min(0).max(25).default(20),
});

export const sendBodyInput = z.object({
  to: z.email(),
  subject: z.string().trim().min(1).max(200),
  text: z.string().max(100_000).optional(),
  html: z.string().max(100_000).optional(),
});

export const sendInput = mailboxAccessInput
  .extend(sendBodyInput.shape)
  .refine((value) => value.text !== undefined || value.html !== undefined, {
    message: "At least one of text or html is required",
  });

export function mailboxStub(env: AppEnv, address: string) {
  const normalized = normalizeAddress(address);
  const parts = normalized.split("@");
  if (parts.length !== 2 || !parts[0] || parts[1] !== env.EMAIL_DOMAIN) {
    throw new Error("Mailbox not found or token is invalid");
  }
  return env.MAILBOXES.getByName(normalized);
}

export async function createMailbox(
  env: AppEnv,
  input: z.infer<typeof createMailboxInput>,
): Promise<MailboxCredentials> {
  const defaultTtl = parsePositiveInteger(env.DEFAULT_MAILBOX_TTL_SECONDS, 86_400);
  const maxTtl = parsePositiveInteger(env.MAX_MAILBOX_TTL_SECONDS, 604_800);
  const ttlSeconds = Math.min(input.ttlSeconds ?? defaultTtl, maxTtl);
  const purpose = slugify(input.purpose ?? "agent");

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const address = `inbox+${purpose}-${randomToken(12).toLowerCase()}@${env.EMAIL_DOMAIN}`;
    const mailboxToken = randomToken(32);
    const now = Date.now();
    const expiresAt = now + ttlSeconds * 1_000;
    const created = await env.MAILBOXES.getByName(address).initialize({
      address,
      tokenHash: await hashSecret(mailboxToken),
      createdAt: now,
      expiresAt,
    });
    if (created) return { address, mailboxToken, expiresAt: new Date(expiresAt).toISOString() };
  }

  throw new Error("Could not allocate a unique mailbox");
}

export async function waitForEmail(
  env: AppEnv,
  input: z.infer<typeof waitInput>,
): Promise<StoredMessage | undefined> {
  const stub = mailboxStub(env, input.address);
  const filter: WaitFilter = {
    ...(input.from ? { from: input.from } : {}),
    ...(input.subject ? { subject: input.subject } : {}),
    ...(input.after ? { after: input.after } : {}),
  };
  const deadline = Date.now() + input.timeoutSeconds * 1_000;

  do {
    const message = await stub.latestMatching(input.mailboxToken, filter);
    if (message) return message;
    if (Date.now() >= deadline) return undefined;
    await scheduler.wait(Math.min(750, deadline - Date.now()));
  } while (Date.now() <= deadline);

  return undefined;
}

export async function sendEmail(env: AppEnv, input: z.infer<typeof sendInput>): Promise<void> {
  const stub = mailboxStub(env, input.address);
  const dailyLimit = parsePositiveInteger(env.MAX_OUTBOUND_PER_DAY, 20);
  await stub.reserveOutbound(input.mailboxToken, dailyLimit);
  try {
    await env.EMAIL.send({
      from: input.address,
      to: input.to,
      subject: input.subject,
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.html !== undefined ? { html: input.html } : {}),
    });
  } catch (error) {
    await stub.releaseOutbound(input.mailboxToken);
    throw error;
  }
}

export async function receiveEmail(message: ForwardableEmailMessage, env: AppEnv): Promise<void> {
  const address = normalizeAddress(message.to);
  let stub: ReturnType<typeof mailboxStub>;
  try {
    stub = mailboxStub(env, address);
  } catch {
    message.setReject("Unknown mailbox");
    return;
  }
  if (!(await stub.acceptsInbound())) {
    message.setReject("Unknown or expired mailbox");
    return;
  }

  const parsed = await PostalMime.parse(message.raw);
  const id = randomToken(18);
  const attachments = await storeAttachments(env, address, id, parsed.attachments);
  const inbound: InboundMessage = {
    id,
    from: message.from,
    to: address,
    subject: parsed.subject ?? "",
    ...(parsed.text ? { text: parsed.text } : {}),
    ...(parsed.html ? { html: parsed.html } : {}),
    receivedAt: parseReceivedAt(parsed.date),
    ...(parsed.messageId ? { messageId: parsed.messageId } : {}),
    headers: groupHeaders(parsed.headers),
    attachments,
  };

  const result = await ingestInboundMessage(stub, env.ATTACHMENTS, inbound);
  if (result !== "stored") {
    message.setReject("Unknown or expired mailbox");
  }
}

type InboundMailbox = {
  ingest: (message: InboundMessage) => Promise<"stored" | "unknown-or-expired">;
};

type AttachmentCleanup = {
  delete: (keys: string[]) => Promise<void>;
};

/** Commits attachment metadata and removes newly stored objects on every failed commit path. */
export async function ingestInboundMessage(
  stub: InboundMailbox,
  attachments: AttachmentCleanup,
  inbound: InboundMessage,
): Promise<"stored" | "unknown-or-expired"> {
  const keys = inbound.attachments.map((attachment) => attachment.key);
  try {
    const result = await stub.ingest(inbound);
    if (result !== "stored" && keys.length > 0) await attachments.delete(keys);
    return result;
  } catch (error) {
    if (keys.length > 0) {
      try {
        await attachments.delete(keys);
      } catch (cleanupError) {
        console.error(
          JSON.stringify({
            message: "Inbound attachment cleanup failed",
            errorType: cleanupError instanceof Error ? cleanupError.name : "UnknownError",
            attachmentCount: keys.length,
          }),
        );
      }
    }
    throw error;
  }
}

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

function parsePositiveInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 32);
  return slug || "agent";
}

function parseReceivedAt(date?: string): string {
  if (!date) return new Date().toISOString();
  const timestamp = Date.parse(date);
  return Number.isNaN(timestamp) ? new Date().toISOString() : new Date(timestamp).toISOString();
}

function groupHeaders(headers: Array<{ key: string; value: string }>): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  for (const header of headers) (grouped[header.key] ??= []).push(header.value);
  return grouped;
}

async function storeAttachments(
  env: AppEnv,
  address: string,
  messageId: string,
  attachments: Array<{
    filename: string | null;
    mimeType: string;
    disposition: "attachment" | "inline" | null;
    contentId?: string;
    content: ArrayBuffer | Uint8Array | string;
  }>,
): Promise<StoredAttachment[]> {
  const results = await Promise.allSettled(
    attachments.map(async (attachment, index) => {
      const filename = attachment.filename ?? `attachment-${index + 1}`;
      const content = toBytes(attachment.content);
      const key = `${encodeURIComponent(address)}/${messageId}/${index}-${encodeURIComponent(filename)}`;
      await env.ATTACHMENTS.put(key, content, {
        httpMetadata: { contentType: attachment.mimeType },
        customMetadata: { filename },
      });
      return {
        key,
        filename,
        mimeType: attachment.mimeType,
        disposition: attachment.disposition ?? "attachment",
        ...(attachment.contentId ? { contentId: attachment.contentId } : {}),
        size: content.byteLength,
      };
    }),
  );

  const stored: StoredAttachment[] = [];
  let failed = false;
  let firstFailure: unknown;
  for (const result of results) {
    if (result.status === "fulfilled") {
      stored.push(result.value);
    } else if (!failed) {
      failed = true;
      firstFailure = result.reason;
    }
  }

  if (failed) {
    const keys = stored.map((attachment) => attachment.key);
    if (keys.length > 0) await env.ATTACHMENTS.delete(keys);
    throw firstFailure;
  }

  return stored;
}

function toBytes(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content);
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}
