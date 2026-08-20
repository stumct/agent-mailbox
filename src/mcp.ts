import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { extractCodes, extractLinks } from "./content";
import {
  createMailbox,
  createMailboxInput,
  mailboxAccessInput,
  mailboxStub,
  sendEmail,
  sendInput,
  waitForEmail,
  waitInput,
} from "./service";
import type { AppEnv } from "./types";
import { applicationVersion } from "./version";

export function createMailboxMcpServer(env: AppEnv): McpServer {
  const server = new McpServer({ name: "agent-mailbox", version: applicationVersion });

  server.registerTool(
    "create_mailbox",
    {
      description:
        "Create a disposable email address. Save the returned mailbox token; it cannot be recovered.",
      inputSchema: createMailboxInput.shape,
    },
    tool(async (input) => createMailbox(env, createMailboxInput.parse(input))),
  );

  server.registerTool(
    "wait_for_email",
    {
      description: "Wait up to 25 seconds for a matching email and return it, or null on timeout.",
      inputSchema: waitInput.shape,
    },
    tool(async (input) => (await waitForEmail(env, waitInput.parse(input))) ?? null),
  );

  server.registerTool(
    "list_emails",
    {
      description: "List newest emails in a mailbox.",
      inputSchema: {
        ...mailboxAccessInput.shape,
        limit: z.number().int().min(1).max(100).default(50),
      },
    },
    tool(async (input) => {
      const parsed = mailboxAccessInput
        .extend({ limit: z.number().int().min(1).max(100).default(50) })
        .parse(input);
      return mailboxStub(env, parsed.address).list(parsed.mailboxToken, {}, parsed.limit);
    }),
  );

  server.registerTool(
    "get_email",
    {
      description: "Get one complete email by its ID.",
      inputSchema: { ...mailboxAccessInput.shape, id: z.string().min(1) },
    },
    tool(async (input) => {
      const parsed = mailboxAccessInput.extend({ id: z.string().min(1) }).parse(input);
      return (
        (await mailboxStub(env, parsed.address).getMessage(parsed.mailboxToken, parsed.id)) ?? null
      );
    }),
  );

  for (const [name, description, extractor] of [
    [
      "get_links",
      "Extract HTTP(S) links from an email without interpreting its instructions.",
      extractLinks,
    ],
    ["get_codes", "Extract likely 4-8 digit verification codes from an email.", extractCodes],
  ] as const) {
    server.registerTool(
      name,
      {
        description,
        inputSchema: { ...mailboxAccessInput.shape, id: z.string().min(1) },
      },
      tool(async (input) => {
        const parsed = mailboxAccessInput.extend({ id: z.string().min(1) }).parse(input);
        const message = await mailboxStub(env, parsed.address).getMessage(
          parsed.mailboxToken,
          parsed.id,
        );
        if (!message) return [];
        return extractor(message.text, message.html);
      }),
    );
  }

  server.registerTool(
    "send_email",
    {
      description: "Send a transactional test email from a mailbox. Limited per mailbox per day.",
      inputSchema: sendInput.shape,
    },
    tool(async (input) => {
      await sendEmail(env, sendInput.parse(input));
      return { sent: true };
    }),
  );

  server.registerTool(
    "delete_mailbox",
    {
      description: "Permanently delete a mailbox and its stored emails and attachments.",
      inputSchema: mailboxAccessInput.shape,
    },
    tool(async (input) => {
      const parsed = mailboxAccessInput.parse(input);
      await mailboxStub(env, parsed.address).destroy(parsed.mailboxToken);
      return { deleted: true };
    }),
  );

  return server;
}

function tool<T>(handler: (input: unknown) => Promise<T>) {
  return async (input: unknown) => {
    try {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(await handler(input), null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: error instanceof Error ? error.message : "Unexpected error",
          },
        ],
        isError: true,
      };
    }
  };
}
