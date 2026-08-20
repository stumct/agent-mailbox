import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authorization, createMailbox, mailboxUrl } from "./helpers";
import { apiRouteLabel } from "../src/api";

describe("API boundary", () => {
  it("serves health without authentication", async () => {
    const response = await SELF.fetch("https://mailbox.example.com/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("rejects unauthenticated API requests", async () => {
    const response = await SELF.fetch("https://mailbox.example.com/api/mailboxes");

    expect(response.status).toBe(401);
  });

  it("returns a client error for invalid JSON", async () => {
    const response = await SELF.fetch("https://mailbox.example.com/api/mailboxes", {
      method: "POST",
      headers: { ...authorization, "Content-Type": "application/json" },
      body: "not-json",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Request body must be valid JSON" });
  });

  it("creates and deletes a token-scoped mailbox", async () => {
    const mailbox = await createMailbox();
    expect(mailbox.address).toMatch(/^inbox\+integration-[a-z0-9_-]+@mail\.example\.com$/u);

    const list = await SELF.fetch(`${mailboxUrl(mailbox.address)}/messages`, {
      headers: { ...authorization, "X-Mailbox-Token": mailbox.mailboxToken },
    });
    expect(list.status).toBe(200);

    const deleted = await SELF.fetch(mailboxUrl(mailbox.address), {
      method: "DELETE",
      headers: { ...authorization, "X-Mailbox-Token": mailbox.mailboxToken },
    });
    expect(deleted.status).toBe(204);
  });

  it("does not reveal whether an address outside the configured domain exists", async () => {
    const response = await SELF.fetch(`${mailboxUrl("inbox@example.net")}/messages`, {
      headers: { ...authorization, "X-Mailbox-Token": "incorrect-token-that-is-long-enough" },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Mailbox not found or token is invalid",
    });
  });

  it("removes mailbox and message identifiers from log route labels", () => {
    expect(
      apiRouteLabel(
        "/api/mailboxes/inbox%2Bprivate%40mail.example.com/messages/sensitive-id/attachments/0",
      ),
    ).toBe("/api/mailboxes/:address/messages/:id/attachments/:index");
  });
});
