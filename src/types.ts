export interface MailboxCredentials {
  address: string;
  mailboxToken: string;
  expiresAt: string;
}

export interface StoredAttachment {
  key: string;
  filename: string;
  mimeType: string;
  disposition: string;
  contentId?: string;
  size: number;
}

export interface StoredMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
  receivedAt: string;
  messageId?: string;
  headers: Record<string, string[]>;
  attachments: StoredAttachment[];
}

export interface MessageSummary {
  id: string;
  from: string;
  to: string;
  subject: string;
  receivedAt: string;
  messageId?: string;
  attachmentCount: number;
}

export interface MailboxMetadata {
  address: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
}

export interface InboundMessage extends StoredMessage {}

export interface WaitFilter {
  from?: string;
  subject?: string;
  after?: string;
}

export interface AppEnv extends Env {
  AGENT_API_KEY: string;
  MAILBOXES: DurableObjectNamespace<import("./mailbox").Mailbox>;
}
