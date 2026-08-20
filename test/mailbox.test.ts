import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { InboundMessage, MailboxMetadata } from "../src/types";
import { authorization, createMailbox, mailboxUrl } from "./helpers";

describe("mailbox lifecycle", () => {
  it("stores, lists, reads, and downloads an inbound message", async () => {
    const mailbox = await createMailbox();
    const stub = env.MAILBOXES.getByName(mailbox.address);
    const attachmentBody = new TextEncoder().encode("attachment contents");
    const attachmentKey = `${encodeURIComponent(mailbox.address)}/message-1/0-report.txt`;
    await env.ATTACHMENTS.put(attachmentKey, attachmentBody);

    const message = inboundMessage(mailbox.address, attachmentKey, attachmentBody.byteLength);
    await expect(stub.ingest(message)).resolves.toBe("stored");

    const headers = { ...authorization, "X-Mailbox-Token": mailbox.mailboxToken };
    const list = await SELF.fetch(`${mailboxUrl(mailbox.address)}/messages`, { headers });
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toEqual([
      {
        id: message.id,
        from: message.from,
        to: message.to,
        subject: message.subject,
        receivedAt: message.receivedAt,
        messageId: message.messageId,
        attachmentCount: 1,
      },
    ]);

    const complete = await SELF.fetch(`${mailboxUrl(mailbox.address)}/messages/${message.id}`, {
      headers,
    });
    expect(complete.status).toBe(200);
    await expect(complete.json()).resolves.toMatchObject({ id: message.id, text: message.text });

    const attachment = await SELF.fetch(
      `${mailboxUrl(mailbox.address)}/messages/${message.id}/attachments/0`,
      { headers },
    );
    expect(attachment.status).toBe(200);
    expect(attachment.headers.get("Content-Type")).toBe("text/plain");
    expect(attachment.headers.get("Cache-Control")).toBe("no-store");
    expect(attachment.headers.get("Content-Disposition")).toBe(
      "attachment; filename*=UTF-8''report.txt",
    );
    expect(attachment.headers.get("X-Content-Type-Options")).toBe("nosniff");
    await expect(attachment.text()).resolves.toBe("attachment contents");
  });

  it("deletes expired mailbox data and attachments when its alarm runs", async () => {
    const mailbox = await createMailbox();
    const stub = env.MAILBOXES.getByName(mailbox.address);
    const attachmentKey = `${encodeURIComponent(mailbox.address)}/message-2/0-expiring.txt`;
    await env.ATTACHMENTS.put(attachmentKey, "temporary");
    await stub.ingest(inboundMessage(mailbox.address, attachmentKey, 9));

    await runInDurableObject(stub, async (_instance, state) => {
      const metadata = await state.storage.get<MailboxMetadata>("metadata");
      if (!metadata) throw new Error("Expected mailbox metadata");
      await state.storage.put("metadata", { ...metadata, expiresAt: Date.now() - 1 });
      await state.storage.setAlarm(Date.now() + 60_000);
    });

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    await expect(env.ATTACHMENTS.get(attachmentKey)).resolves.toBeNull();
    await runInDurableObject(stub, async (_instance, state) => {
      await expect(state.storage.get("metadata")).resolves.toBeUndefined();
    });
  });

  it("rejects an invalid mailbox token", async () => {
    const mailbox = await createMailbox();
    const stub = env.MAILBOXES.getByName(mailbox.address);

    await runInDurableObject(stub, async (instance) => {
      await expect(instance.list("incorrect-token-that-is-long-enough")).rejects.toThrow(
        "Mailbox not found or token is invalid",
      );
    });
  });

  it("enforces the per-mailbox outbound reservation limit", async () => {
    const mailbox = await createMailbox();
    const stub = env.MAILBOXES.getByName(mailbox.address);

    await runInDurableObject(stub, async (instance) => {
      await instance.reserveOutbound(mailbox.mailboxToken, 1);
      await expect(instance.reserveOutbound(mailbox.mailboxToken, 1)).rejects.toThrow(
        "Outbound daily limit reached",
      );
    });
  });
});

function inboundMessage(
  address: string,
  attachmentKey: string,
  attachmentSize: number,
): InboundMessage {
  return {
    id: "message-1",
    from: "sender@example.net",
    to: address,
    subject: "Verify your account",
    text: "Use code 123456 or open https://example.net/verify",
    receivedAt: "2026-08-18T12:00:00.000Z",
    messageId: "<message-1@example.net>",
    headers: { "message-id": ["<message-1@example.net>"] },
    attachments: [
      {
        key: attachmentKey,
        filename: "report.txt",
        mimeType: "text/plain",
        disposition: "attachment",
        size: attachmentSize,
      },
    ],
  };
}
