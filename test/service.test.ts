import { describe, expect, it, vi } from "vitest";
import { ingestInboundMessage } from "../src/service";
import type { InboundMessage } from "../src/types";

const inbound: InboundMessage = {
  id: "message-id",
  from: "sender@example.net",
  to: "inbox+test@mail.example.com",
  subject: "Test",
  receivedAt: "2026-08-19T00:00:00.000Z",
  headers: {},
  attachments: [
    {
      key: "private-attachment-key",
      filename: "attachment.txt",
      mimeType: "text/plain",
      disposition: "attachment",
      size: 4,
    },
  ],
};

describe("inbound email commit", () => {
  it("deletes newly stored attachments when mailbox ingestion throws", async () => {
    const failure = new Error("Durable Object unavailable");
    const ingest = vi.fn().mockRejectedValue(failure);
    const deleteAttachments = vi.fn().mockResolvedValue(undefined);

    await expect(
      ingestInboundMessage({ ingest }, { delete: deleteAttachments }, inbound),
    ).rejects.toBe(failure);
    expect(deleteAttachments).toHaveBeenCalledWith(["private-attachment-key"]);
  });

  it("deletes attachments when an expired mailbox rejects the commit", async () => {
    const deleteAttachments = vi.fn().mockResolvedValue(undefined);

    await expect(
      ingestInboundMessage(
        { ingest: vi.fn().mockResolvedValue("unknown-or-expired") },
        { delete: deleteAttachments },
        inbound,
      ),
    ).resolves.toBe("unknown-or-expired");
    expect(deleteAttachments).toHaveBeenCalledWith(["private-attachment-key"]);
  });
});
