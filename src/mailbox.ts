import { DurableObject } from "cloudflare:workers";
import { secretsMatch } from "./crypto";
import type {
  AppEnv,
  InboundMessage,
  MailboxMetadata,
  MessageSummary,
  StoredAttachment,
  StoredMessage,
  WaitFilter,
} from "./types";

interface MessageRow extends Record<string, SqlStorageValue> {
  id: string;
  sender: string;
  recipient: string;
  subject: string;
  text_body: string | null;
  html_body: string | null;
  received_at: string;
  message_id: string | null;
  headers_json: string;
  attachments_json: string;
}

interface OutboundRow extends Record<string, SqlStorageValue> {
  count: number;
}

const METADATA_KEY = "metadata";

export class Mailbox extends DurableObject<AppEnv> {
  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        subject TEXT NOT NULL,
        text_body TEXT,
        html_body TEXT,
        received_at TEXT NOT NULL,
        message_id TEXT,
        headers_json TEXT NOT NULL,
        attachments_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_received_at ON messages(received_at DESC);
      CREATE TABLE IF NOT EXISTS outbound_daily (
        day TEXT PRIMARY KEY,
        count INTEGER NOT NULL
      );
    `);
  }

  async initialize(metadata: MailboxMetadata): Promise<boolean> {
    const existing = await this.ctx.storage.get<MailboxMetadata>(METADATA_KEY);
    if (existing && existing.expiresAt > Date.now()) return false;
    await this.ctx.storage.put(METADATA_KEY, metadata);
    await this.ctx.storage.setAlarm(metadata.expiresAt);
    return true;
  }

  async acceptsInbound(): Promise<boolean> {
    const metadata = await this.activeMetadata();
    return metadata !== undefined;
  }

  async ingest(message: InboundMessage): Promise<"stored" | "unknown-or-expired"> {
    if (!(await this.activeMetadata())) return "unknown-or-expired";
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO messages
        (id, sender, recipient, subject, text_body, html_body, received_at, message_id, headers_json, attachments_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      message.id,
      message.from,
      message.to,
      message.subject,
      message.text ?? null,
      message.html ?? null,
      message.receivedAt,
      message.messageId ?? null,
      JSON.stringify(message.headers),
      JSON.stringify(message.attachments),
    );
    return "stored";
  }

  async list(token: string, filter: WaitFilter = {}, limit = 50): Promise<MessageSummary[]> {
    await this.authorize(token);
    const cappedLimit = Math.max(1, Math.min(limit, 100));
    const rows = this.ctx.storage.sql
      .exec<MessageRow>("SELECT * FROM messages ORDER BY received_at DESC LIMIT ?", cappedLimit)
      .toArray();
    return rows.map(rowToMessage).filter(messageMatches(filter)).map(toSummary);
  }

  async getMessage(token: string, id: string): Promise<StoredMessage | undefined> {
    await this.authorize(token);
    const rows = this.ctx.storage.sql
      .exec<MessageRow>("SELECT * FROM messages WHERE id = ? LIMIT 1", id)
      .toArray();
    const row = rows[0];
    return row ? rowToMessage(row) : undefined;
  }

  async latestMatching(token: string, filter: WaitFilter): Promise<StoredMessage | undefined> {
    await this.authorize(token);
    const rows = this.ctx.storage.sql
      .exec<MessageRow>("SELECT * FROM messages ORDER BY received_at DESC LIMIT 100")
      .toArray();
    return rows.map(rowToMessage).find(messageMatches(filter));
  }

  async reserveOutbound(token: string, dailyLimit: number): Promise<void> {
    await this.authorize(token);
    const day = new Date().toISOString().slice(0, 10);
    const existing =
      this.ctx.storage.sql
        .exec<OutboundRow>("SELECT count FROM outbound_daily WHERE day = ? LIMIT 1", day)
        .toArray()[0]?.count ?? 0;
    if (existing >= dailyLimit) throw new Error("Outbound daily limit reached");
    this.ctx.storage.sql.exec(
      `INSERT INTO outbound_daily(day, count) VALUES (?, 1)
       ON CONFLICT(day) DO UPDATE SET count = count + 1`,
      day,
    );
    this.ctx.storage.sql.exec("DELETE FROM outbound_daily WHERE day < date('now', '-7 days')");
  }

  async releaseOutbound(token: string): Promise<void> {
    await this.authorize(token);
    const day = new Date().toISOString().slice(0, 10);
    this.ctx.storage.sql.exec(
      "UPDATE outbound_daily SET count = MAX(count - 1, 0) WHERE day = ?",
      day,
    );
  }

  async destroy(token: string): Promise<void> {
    await this.authorize(token);
    await this.deleteMailbox();
  }

  override async alarm(): Promise<void> {
    const metadata = await this.ctx.storage.get<MailboxMetadata>(METADATA_KEY);
    if (metadata && metadata.expiresAt > Date.now()) {
      await this.ctx.storage.setAlarm(metadata.expiresAt);
      return;
    }
    await this.deleteMailbox();
  }

  private async activeMetadata(): Promise<MailboxMetadata | undefined> {
    const metadata = await this.ctx.storage.get<MailboxMetadata>(METADATA_KEY);
    if (!metadata || metadata.expiresAt <= Date.now()) return undefined;
    return metadata;
  }

  private async authorize(token: string): Promise<MailboxMetadata> {
    const metadata = await this.activeMetadata();
    if (!metadata || !(await secretsMatch(token, metadata.tokenHash))) {
      throw new Error("Mailbox not found or token is invalid");
    }
    return metadata;
  }

  private async deleteMailbox(): Promise<void> {
    const keys = this.ctx.storage.sql
      .exec<{ attachments_json: string }>("SELECT attachments_json FROM messages")
      .toArray()
      .flatMap((row) => parseAttachments(row.attachments_json).map((attachment) => attachment.key));
    if (keys.length > 0) await this.env.ATTACHMENTS.delete(keys);
    await this.ctx.storage.deleteAll();
  }
}

function rowToMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    from: row.sender,
    to: row.recipient,
    subject: row.subject,
    ...(row.text_body ? { text: row.text_body } : {}),
    ...(row.html_body ? { html: row.html_body } : {}),
    receivedAt: row.received_at,
    ...(row.message_id ? { messageId: row.message_id } : {}),
    headers: parseHeaders(row.headers_json),
    attachments: parseAttachments(row.attachments_json),
  };
}

function toSummary(message: StoredMessage): MessageSummary {
  return {
    id: message.id,
    from: message.from,
    to: message.to,
    subject: message.subject,
    receivedAt: message.receivedAt,
    ...(message.messageId ? { messageId: message.messageId } : {}),
    attachmentCount: message.attachments.length,
  };
}

function messageMatches(filter: WaitFilter): (message: StoredMessage) => boolean {
  return (message) => {
    if (filter.from && !message.from.toLowerCase().includes(filter.from.toLowerCase()))
      return false;
    if (filter.subject && !message.subject.toLowerCase().includes(filter.subject.toLowerCase()))
      return false;
    if (filter.after && message.receivedAt <= filter.after) return false;
    return true;
  };
}

function parseHeaders(value: string): Record<string, string[]> {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string[]] =>
        Array.isArray(entry[1]) && entry[1].every((item) => typeof item === "string"),
    ),
  );
}

function parseAttachments(value: string): StoredAttachment[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isStoredAttachment);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStoredAttachment(value: unknown): value is StoredAttachment {
  return (
    isRecord(value) &&
    typeof value.key === "string" &&
    typeof value.filename === "string" &&
    typeof value.mimeType === "string" &&
    typeof value.disposition === "string" &&
    typeof value.size === "number"
  );
}
