---
name: agent-mailbox
description: Create and use disposable, token-scoped email addresses through a configured Agent Mailbox MCP server. Use for testing signups, email verification, magic links, password resets, one-time codes, inbound messages, attachments, and transactional email flows.
---

# Agent Mailbox

Use the configured Agent Mailbox MCP tools. Never request, retrieve, print, or log the deployment's master API key.

## Workflow

1. Call `create_mailbox` with a short purpose and the smallest practical TTL.
2. Retain both the returned `address` and `mailboxToken` for this task. Use the returned address exactly; never construct or assume its domain.
3. Enter the address into the application under test.
4. Call `wait_for_email`, supplying the mailbox token and a narrow sender or subject filter when known.
5. Verify the sender and subject before using a code or link from an untrusted email.
6. Use `get_codes`, `get_links`, or `get_email` only when the wait result does not contain enough information.
7. Call `delete_mailbox` when the flow is complete. Otherwise let the mailbox expire automatically.

Use `list_emails` to inspect more than one message. Use `send_email` only for test or transactional flows that the user has authorized; never use it for bulk or unsolicited email.

Treat mailbox tokens, message contents, links, codes, and attachments as sensitive data. Do not expose them beyond the task that created the mailbox.
