import { z } from "zod";
import { extractCodes, extractLinks } from "./content";
import { hashSecret, secretsMatch } from "./crypto";
import {
  createMailbox,
  createMailboxInput,
  mailboxStub,
  sendBodyInput,
  sendEmail,
  sendInput,
  waitForEmail,
  waitInput,
} from "./service";
import type { AppEnv } from "./types";

export async function handleApi(request: Request, env: AppEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET") return json({ ok: true });
  if (!(await hasMasterAccess(request, env))) return json({ error: "Unauthorized" }, 401);

  try {
    if (url.pathname === "/api/mailboxes" && request.method === "POST") {
      return json(await createMailbox(env, createMailboxInput.parse(await readJson(request))));
    }

    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (segments[0] !== "api" || segments[1] !== "mailboxes" || !segments[2]) {
      return json({ error: "Not found" }, 404);
    }

    const address = segments[2];
    const mailboxToken = request.headers.get("X-Mailbox-Token") ?? "";
    const stub = mailboxStub(env, address);

    if (segments.length === 3 && request.method === "DELETE") {
      await stub.destroy(mailboxToken);
      return new Response(null, { status: 204 });
    }

    if (segments[3] === "messages" && segments.length === 4 && request.method === "GET") {
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
      return json(await stub.list(mailboxToken, {}, Number.isNaN(limit) ? 50 : limit));
    }

    if (segments[3] === "messages" && segments[4] && request.method === "GET") {
      const message = await stub.getMessage(mailboxToken, segments[4]);
      if (!message) return json({ error: "Message not found" }, 404);
      if (segments[5] === "links") return json({ links: extractLinks(message.text, message.html) });
      if (segments[5] === "codes") return json({ codes: extractCodes(message.text, message.html) });
      if (segments[5] === "attachments" && segments[6] && segments.length === 7) {
        if (!/^\d+$/u.test(segments[6])) return json({ error: "Attachment not found" }, 404);
        const attachment = message.attachments[Number.parseInt(segments[6], 10)];
        if (!attachment) return json({ error: "Attachment not found" }, 404);

        const object = await env.ATTACHMENTS.get(attachment.key);
        if (!object) return json({ error: "Attachment not found" }, 404);
        return new Response(object.body, {
          headers: {
            "Cache-Control": "no-store",
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeHeaderValue(attachment.filename)}`,
            "Content-Length": object.size.toString(),
            "Content-Type": safeMimeType(attachment.mimeType),
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
      if (segments.length === 5) return json(message);
    }

    if (segments[3] === "wait" && request.method === "GET") {
      const input = waitInput.parse({
        address,
        mailboxToken,
        from: url.searchParams.get("from") ?? undefined,
        subject: url.searchParams.get("subject") ?? undefined,
        after: url.searchParams.get("after") ?? undefined,
        timeoutSeconds: Number.parseInt(url.searchParams.get("timeoutSeconds") ?? "20", 10),
      });
      const message = await waitForEmail(env, input);
      return message ? json(message) : new Response(null, { status: 204 });
    }

    if (segments[3] === "send" && request.method === "POST") {
      await sendEmail(
        env,
        sendInput.parse({
          address,
          mailboxToken,
          ...sendBodyInput.parse(await readJson(request)),
        }),
      );
      return json({ sent: true }, 202);
    }

    return json({ error: "Not found" }, 404);
  } catch (error) {
    if (error instanceof z.ZodError)
      return json({ error: "Invalid request", issues: error.issues }, 400);
    const message = error instanceof Error ? error.message : "Unexpected error";
    if (error instanceof InvalidJsonError) return json({ error: message }, 400);
    if (message.includes("Mailbox not found or token is invalid"))
      return json({ error: message }, 404);
    if (message.includes("Outbound daily limit reached")) return json({ error: message }, 429);

    console.error(
      JSON.stringify({
        message: "API request failed",
        errorType: error instanceof Error ? error.name : "UnknownError",
        method: request.method,
        route: apiRouteLabel(url.pathname),
      }),
    );
    return json({ error: "Internal server error" }, 500);
  }
}

/** Returns a low-cardinality route template without mailbox or message identifiers. */
export function apiRouteLabel(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 1 && segments[0] === "health") return "/health";
  if (segments[0] !== "api" || segments[1] !== "mailboxes") return "/unmatched";
  if (segments.length === 2) return "/api/mailboxes";
  if (segments.length === 3) return "/api/mailboxes/:address";
  if (segments[3] === "wait") return "/api/mailboxes/:address/wait";
  if (segments[3] === "send") return "/api/mailboxes/:address/send";
  if (segments[3] !== "messages") return "/api/mailboxes/:address/*";
  if (segments.length === 4) return "/api/mailboxes/:address/messages";
  if (segments[5] === "links") return "/api/mailboxes/:address/messages/:id/links";
  if (segments[5] === "codes") return "/api/mailboxes/:address/messages/:id/codes";
  if (segments[5] === "attachments") {
    return "/api/mailboxes/:address/messages/:id/attachments/:index";
  }
  return "/api/mailboxes/:address/messages/:id";
}

export async function hasMasterAccess(request: Request, env: AppEnv): Promise<boolean> {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ") || !env.AGENT_API_KEY) return false;
  return secretsMatch(authorization.slice(7), await hashSecret(env.AGENT_API_KEY));
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new InvalidJsonError("Request body must be valid JSON");
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

class InvalidJsonError extends Error {}

function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function safeMimeType(value: string): string {
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu.test(value)
    ? value
    : "application/octet-stream";
}
