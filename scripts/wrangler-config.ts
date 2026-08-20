import { applyEdits, modify, parse, type FormattingOptions, type ParseError } from "jsonc-parser";

export type DeploymentValues = {
  accountId?: string;
  emailDomain: string;
  mcpHostname: string;
  workerName?: string;
};

type JsonObject = Record<string, unknown>;

const formattingOptions: FormattingOptions = { insertSpaces: true, tabSize: 2 };
const hostnameLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const workerNamePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export function normalizeHostname(input: string, label: string): string {
  const hostname = input.trim().toLowerCase().replace(/\.$/u, "");
  const parts = hostname.split(".");

  if (
    hostname.length > 253 ||
    parts.length < 2 ||
    parts.some((part) => !hostnameLabel.test(part))
  ) {
    throw new Error(`${label} must be a valid DNS hostname, for example mail.example.com`);
  }

  return hostname;
}

function parseObject(source: string): JsonObject {
  const errors: ParseError[] = [];
  const value: unknown = parse(source, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isObject(value)) {
    throw new Error("wrangler.jsonc must contain a valid root object");
  }
  return value;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, label: string): JsonObject {
  if (!isObject(value)) throw new Error(`Expected ${label} object in wrangler.jsonc`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected exactly one ${label} entry in wrangler.jsonc`);
  }
  return value;
}

function requireSingleObject(value: unknown, label: string): JsonObject {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error(`Expected exactly one ${label} entry in wrangler.jsonc`);
  }
  return requireObject(value[0], label);
}

function requireSingleString(value: unknown, label: string): string {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error(`Expected exactly one ${label} entry in wrangler.jsonc`);
  }
  return requireString(value[0], label);
}

function validateStructure(config: JsonObject): void {
  validateWorkerName(requireString(config.name, "Worker name"));
  requireSingleString(config.addresses, "addresses");
  requireString(requireSingleObject(config.routes, "custom-domain route").pattern, "route pattern");
  const vars = requireObject(config.vars, "vars");
  requireString(vars.EMAIL_DOMAIN, "EMAIL_DOMAIN");
  requireString(vars.MCP_HOSTNAME, "MCP_HOSTNAME");
  if (config.account_id !== undefined) requireString(config.account_id, "account_id");
}

function update(source: string, path: (string | number)[], value: string | string[]): string {
  return applyEdits(source, modify(source, path, value, { formattingOptions }));
}

function validateWorkerName(workerName: string): string {
  if (workerName.length > 63 || !workerNamePattern.test(workerName)) {
    throw new Error(
      "Worker name must contain lowercase letters, numbers, or dashes and be at most 63 characters",
    );
  }
  return workerName;
}

export function readDeploymentValues(source: string): DeploymentValues {
  const config = parseObject(source);
  validateStructure(config);
  const vars = requireObject(config.vars, "vars");

  return {
    ...(config.account_id === undefined
      ? {}
      : { accountId: requireString(config.account_id, "account_id") }),
    emailDomain: requireString(vars.EMAIL_DOMAIN, "EMAIL_DOMAIN"),
    mcpHostname: requireString(vars.MCP_HOSTNAME, "MCP_HOSTNAME"),
    workerName: requireString(config.name, "Worker name"),
  };
}

export function configureWrangler(source: string, values: DeploymentValues): string {
  const config = parseObject(source);
  validateStructure(config);
  const emailDomain = normalizeHostname(values.emailDomain, "Receiving email domain");
  const mcpHostname = normalizeHostname(values.mcpHostname, "Public Worker hostname");
  const address = `inbox@${emailDomain}`;
  const route = requireSingleObject(config.routes, "custom-domain route");
  const vars = requireObject(config.vars, "vars");

  let configured = source;
  if (values.workerName && values.workerName !== config.name) {
    configured = update(configured, ["name"], validateWorkerName(values.workerName));
  }
  if (values.accountId && values.accountId !== config.account_id) {
    configured = update(configured, ["account_id"], values.accountId);
  }
  if (requireSingleString(config.addresses, "addresses") !== address) {
    configured = update(configured, ["addresses"], [address]);
  }
  if (route.pattern !== mcpHostname) {
    configured = update(configured, ["routes", 0, "pattern"], mcpHostname);
  }
  if (vars.EMAIL_DOMAIN !== emailDomain) {
    configured = update(configured, ["vars", "EMAIL_DOMAIN"], emailDomain);
  }
  if (vars.MCP_HOSTNAME !== mcpHostname) {
    configured = update(configured, ["vars", "MCP_HOSTNAME"], mcpHostname);
  }

  return configured;
}
