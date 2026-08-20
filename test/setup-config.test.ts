import { describe, expect, it } from "vitest";
import {
  configureWrangler,
  normalizeHostname,
  readDeploymentValues,
} from "../scripts/wrangler-config";

const exampleConfig = `{
  "name": "agent-mailbox",
  "addresses": ["inbox@mail.example.com"],
  "routes": [{ "pattern": "mailbox.example.com", "custom_domain": true }],
  "vars": {
    "EMAIL_DOMAIN": "mail.example.com",
    "MCP_HOSTNAME": "mailbox.example.com"
  }
}`;

describe("setup configuration", () => {
  it("normalises hostnames", () => {
    expect(normalizeHostname("Mail.Example.com.", "Domain")).toBe("mail.example.com");
  });

  it("preserves the original JSONC formatting when values are unchanged", () => {
    expect(configureWrangler(exampleConfig, readDeploymentValues(exampleConfig))).toBe(
      exampleConfig,
    );
  });

  it.each(["localhost", "-mail.example.com", "mail..example.com", "https://example.com"])(
    "rejects invalid hostname %s",
    (hostname) => {
      expect(() => normalizeHostname(hostname, "Domain")).toThrow("valid DNS hostname");
    },
  );

  it("updates every deployment-specific hostname and is idempotent", () => {
    const deployment = {
      emailDomain: "inbound.example.org",
      mcpHostname: "mailbox.example.org",
      workerName: "agent-mailbox-example-org",
    };
    const configured = configureWrangler(exampleConfig, deployment);

    expect(configured).toContain('"name": "agent-mailbox-example-org"');
    expect(configured).toContain('"inbox@inbound.example.org"');
    expect(configured).toContain('"pattern": "mailbox.example.org"');
    expect(readDeploymentValues(configured)).toEqual(deployment);
    expect(configureWrangler(configured, deployment)).toBe(configured);
  });

  it("pins Wrangler to the account that owns the selected zone", () => {
    const deployment = {
      accountId: "0123456789abcdef0123456789abcdef",
      emailDomain: "inbound.example.org",
      mcpHostname: "mailbox.example.org",
      workerName: "agent-mailbox-example-org",
    };
    const configured = configureWrangler(exampleConfig, deployment);

    expect(configured).toContain('"account_id": "0123456789abcdef0123456789abcdef"');
    expect(readDeploymentValues(configured)).toEqual(deployment);
    expect(configureWrangler(configured, deployment)).toBe(configured);
  });

  it("does not confuse binding names for the Worker name", () => {
    const source = `{
  "name": "agent-mailbox",
  "addresses": ["inbox@mail.example.com"],
  "routes": [{ "pattern": "mailbox.example.com", "custom_domain": true }],
  "durable_objects": {
    "bindings": [
      {
        "name": "MAILBOXES",
        "class_name": "Mailbox"
      }
    ]
  },
  "send_email": [{ "name": "EMAIL" }],
  "vars": {
    "EMAIL_DOMAIN": "mail.example.com",
    "MCP_HOSTNAME": "mailbox.example.com"
  }
}`;
    const deployment = {
      accountId: "0123456789abcdef0123456789abcdef",
      emailDomain: "inbound.example.org",
      mcpHostname: "mailbox.example.org",
      workerName: "agent-mailbox-example-org",
    };

    const configured = configureWrangler(source, deployment);

    expect(configured).toContain('"name": "agent-mailbox-example-org"');
    expect(configured).toContain('"name": "MAILBOXES"');
    expect(configured).toContain('"name": "EMAIL"');
    expect(readDeploymentValues(configured)).toEqual(deployment);
    expect(configureWrangler(configured, deployment)).toBe(configured);
  });

  it("fails closed when the expected config structure changes", () => {
    expect(() =>
      configureWrangler("{}", {
        emailDomain: "mail.example.com",
        mcpHostname: "mailbox.example.com",
      }),
    ).toThrow("wrangler.jsonc");
  });
});
