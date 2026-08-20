import * as p from "@clack/prompts";
import { access, cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runCommand, CommandError } from "../setup/process.ts";
import { unwrapPrompt } from "../setup/session.ts";
import { readDeploymentValues } from "../wrangler-config.ts";
import { credentialsMatch, readLocalCredentials } from "./credentials.ts";

export type McpClient = "claude" | "codex";

type ClientAdapter = {
  addArgs: (name: string, bridgePath: string) => string[];
  command: McpClient;
  displayName: string;
  getArgs: (name: string) => string[];
  removeArgs: (name: string) => string[];
  skillDirectory: string;
};

const clientAdapters: Record<McpClient, ClientAdapter> = {
  claude: {
    addArgs: (name, bridgePath) => ["mcp", "add", "--scope", "user", name, "--", bridgePath],
    command: "claude",
    displayName: "Claude Code",
    getArgs: (name) => ["mcp", "get", name],
    removeArgs: (name) => ["mcp", "remove", "--scope", "user", name],
    skillDirectory: resolve(homedir(), ".claude/skills"),
  },
  codex: {
    addArgs: (name, bridgePath) => ["mcp", "add", name, "--", bridgePath],
    command: "codex",
    displayName: "Codex",
    getArgs: (name) => ["mcp", "get", name],
    removeArgs: (name) => ["mcp", "remove", name],
    skillDirectory: resolve(homedir(), ".codex/skills"),
  },
};

export type ConnectionPlan = {
  bridgePath: string;
  clients: Array<{
    adapter: ClientAdapter;
    skillTarget: string;
  }>;
  connectionName: string;
  skillSource: string;
};

export type DisconnectionPlan = ConnectionPlan & {
  removeCredentials: boolean;
  removeSkill: boolean;
};

export function createConnectionPlan(options: {
  clients: McpClient[];
  projectRoot: string;
  workerName: string;
}): ConnectionPlan {
  return {
    bridgePath: resolve(options.projectRoot, "bin/agent-mailbox-mcp"),
    clients: options.clients.map((client) => ({
      adapter: clientAdapters[client],
      skillTarget: resolve(clientAdapters[client].skillDirectory, "agent-mailbox"),
    })),
    connectionName: options.workerName,
    skillSource: resolve(options.projectRoot, "skills/agent-mailbox"),
  };
}

export function createDisconnectionPlan(options: {
  clients: McpClient[];
  projectRoot: string;
  removeCredentials: boolean;
  removeSkill: boolean;
  workerName: string;
}): DisconnectionPlan {
  return {
    ...createConnectionPlan(options),
    removeCredentials: options.removeCredentials,
    removeSkill: options.removeSkill,
  };
}

async function commandAvailable(command: string): Promise<boolean> {
  try {
    await runCommand(command, ["--version"], { quiet: true });
    return true;
  } catch {
    return false;
  }
}

async function existingConnection(
  adapter: ClientAdapter,
  name: string,
): Promise<string | undefined> {
  try {
    return await runCommand(adapter.command, adapter.getArgs(name), { quiet: true });
  } catch (error) {
    if (error instanceof CommandError && error.exitCode !== 0) return undefined;
    throw error;
  }
}

async function skillContents(root: string, directory = root): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [name, content] of await skillContents(root, path)) contents.set(name, content);
    } else if (entry.isFile()) {
      contents.set(relative(root, path), await readFile(path, "utf8"));
    } else {
      throw new Error(`Agent Mailbox skill contains an unsupported filesystem entry: ${path}`);
    }
  }
  return contents;
}

export async function skillState(source: string, target: string): Promise<"missing" | "current"> {
  const sourceContents = await skillContents(source);
  if (!sourceContents.has("SKILL.md")) {
    throw new Error(`The bundled Agent Mailbox skill is incomplete: ${source}`);
  }
  try {
    const targetContents = await skillContents(target);
    if (
      sourceContents.size === targetContents.size &&
      [...sourceContents].every(([name, content]) => targetContents.get(name) === content)
    )
      return "current";
    throw new Error(`A different Agent Mailbox skill already exists at ${target}`);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }

  return "missing";
}

export async function applyConnectionPlan(
  plan: ConnectionPlan,
  options: { installSkill: boolean },
): Promise<string[]> {
  await Promise.all([access(plan.bridgePath), access(plan.skillSource)]);
  const results: string[] = [];

  // Validate every target before changing any client, so a conflict cannot
  // leave only half of a multi-client connection plan applied.
  const states = await Promise.all(
    plan.clients.map(async (client) => ({
      client,
      connection: await existingConnection(client.adapter, plan.connectionName),
      skill: options.installSkill
        ? await skillState(plan.skillSource, client.skillTarget)
        : ("current" as const),
    })),
  );
  for (const state of states) {
    if (state.connection && !state.connection.includes(plan.bridgePath)) {
      throw new Error(
        `${state.client.adapter.displayName} already has a different MCP server named ${plan.connectionName}`,
      );
    }
  }

  const applied: Array<{
    client: ConnectionPlan["clients"][number];
    connectionAdded: boolean;
    skillInstalled: boolean;
  }> = [];
  try {
    for (const state of states) {
      const { client } = state;
      const mutation = { client, connectionAdded: false, skillInstalled: false };
      applied.push(mutation);
      if (!state.connection) {
        await runCommand(
          client.adapter.command,
          client.adapter.addArgs(plan.connectionName, plan.bridgePath),
          { quiet: true },
        );
        mutation.connectionAdded = true;
        results.push(`${client.adapter.displayName}: MCP connection added`);
      } else {
        results.push(`${client.adapter.displayName}: MCP connection already configured`);
      }

      if (options.installSkill) {
        if (state.skill === "missing") {
          await mkdir(dirname(client.skillTarget), { recursive: true });
          // The target was proven absent during preflight, so any partial tree
          // now belongs to this invocation and is safe to remove on failure.
          mutation.skillInstalled = true;
          await cp(plan.skillSource, client.skillTarget, {
            recursive: true,
            errorOnExist: true,
            force: false,
          });
        }
        results.push(
          `${client.adapter.displayName}: skill ${state.skill === "missing" ? "installed" : "already current"}`,
        );
      }
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const mutation of applied.toReversed()) {
      if (mutation.skillInstalled) {
        try {
          await rm(mutation.client.skillTarget, { recursive: true });
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (mutation.connectionAdded) {
        try {
          await runCommand(
            mutation.client.adapter.command,
            mutation.client.adapter.removeArgs(plan.connectionName),
            { quiet: true },
          );
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Client connection failed and automatic rollback was incomplete",
        { cause: error },
      );
    }
    throw error;
  }

  return results;
}

function isMcpClient(value: string): value is McpClient {
  return value === "claude" || value === "codex";
}

export async function runConnect(args: string[], projectRoot = process.cwd()): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args,
    options: {
      client: { type: "string", multiple: true },
      help: { type: "boolean", short: "h", default: false },
      "no-skill": { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(`Connect an Agent Mailbox deployment to an AI coding client

Usage:
  pnpm run connect [instance] [options]
  pnpm mailbox connect [instance] [options]

Options:
  --client <codex|claude>        Client to configure; may be repeated
  --no-skill                     Configure MCP without installing the bundled skill
  -y, --yes                      Apply without confirmation (requires --client)
  -h, --help                     Show this help
`);
    return;
  }

  const source = await readFile(resolve(projectRoot, "wrangler.jsonc"), "utf8");
  const deployment = readDeploymentValues(source);
  const credentials = await readLocalCredentials(projectRoot);
  const requested = positionals[0];
  if (
    requested &&
    ![deployment.workerName, deployment.emailDomain, deployment.mcpHostname].includes(requested)
  ) {
    throw new Error(`This checkout does not hold credentials for ${requested}`);
  }
  if (!deployment.workerName || !credentialsMatch(credentials, deployment)) {
    throw new Error("Run deploy from this checkout before connecting an MCP client");
  }

  const requestedClients = values.client ?? [];
  const invalid = requestedClients.find((client) => !isMcpClient(client));
  if (invalid) throw new Error(`Unsupported MCP client: ${invalid}`);
  let clients = requestedClients.filter(isMcpClient);

  if (clients.length === 0) {
    if (values.yes) throw new Error("--client is required with --yes");
    const detected = (
      await Promise.all(
        Object.values(clientAdapters).map(async (adapter) => ({
          adapter,
          available: await commandAvailable(adapter.command),
        })),
      )
    )
      .filter((candidate) => candidate.available)
      .map((candidate) => candidate.adapter);
    if (detected.length === 0)
      throw new Error("Install Codex or Claude Code before running connect");
    clients = unwrapPrompt(
      await p.multiselect({
        initialValues: detected.length === 1 ? [detected[0]!.command] : [],
        message: "Which clients should use this Agent Mailbox?",
        options: detected.map((adapter) => ({
          label: adapter.displayName,
          value: adapter.command,
        })),
        required: true,
      }),
    );
  }

  clients = [...new Set(clients)];
  const unavailable = (
    await Promise.all(
      clients.map(async (client) => ({
        client,
        available: await commandAvailable(clientAdapters[client].command),
      })),
    )
  ).find((candidate) => !candidate.available);
  if (unavailable) {
    throw new Error(
      `${clientAdapters[unavailable.client].displayName} is not installed or not available on PATH`,
    );
  }
  const plan = createConnectionPlan({ clients, projectRoot, workerName: deployment.workerName });
  const installSkill = !values["no-skill"];
  p.note(
    [
      `Instance: ${plan.connectionName}`,
      `Clients: ${plan.clients.map((client) => client.adapter.displayName).join(", ")}`,
      `MCP transport: local credential bridge (${basename(plan.bridgePath)})`,
      `Agent skill: ${installSkill ? "install" : "skip"}`,
      "The API key remains in the mode-0600 credentials file.",
    ].join("\n"),
    "Connection plan",
  );

  if (!values.yes) {
    const approved = unwrapPrompt(
      await p.confirm({
        initialValue: true,
        message: "Apply these client configuration changes?",
      }),
    );
    if (!approved) {
      p.outro("No client configuration was changed.");
      return;
    }
  }

  const results = await applyConnectionPlan(plan, { installSkill });
  for (const result of results) p.log.success(result);
  p.outro("Agent Mailbox is ready in the selected clients. Restart them if they are already open.");
}

export async function runDisconnect(args: string[], projectRoot = process.cwd()): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args,
    options: {
      client: { type: "string", multiple: true },
      help: { type: "boolean", short: "h", default: false },
      "remove-credentials": { type: "boolean", default: false },
      "remove-skill": { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(`Disconnect Agent Mailbox from local AI coding clients

Usage:
  pnpm run disconnect [instance] [options]
  pnpm mailbox disconnect [instance] [options]

Options:
  --client <codex|claude>        Client to disconnect; may be repeated
  --remove-credentials           Delete this checkout's matching credentials file
  --remove-skill                 Delete the shared Agent Mailbox skill for selected clients
  -y, --yes                      Apply without confirmation (requires --client)
  -h, --help                     Show this help
`);
    return;
  }

  const source = await readFile(resolve(projectRoot, "wrangler.jsonc"), "utf8");
  const deployment = readDeploymentValues(source);
  const requested = positionals[0];
  if (
    requested &&
    ![deployment.workerName, deployment.emailDomain, deployment.mcpHostname].includes(requested)
  ) {
    throw new Error(`This checkout is not configured for ${requested}`);
  }
  if (!deployment.workerName) throw new Error("This checkout has no configured Worker name");

  const requestedClients = values.client ?? [];
  const invalid = requestedClients.find((client) => !isMcpClient(client));
  if (invalid) throw new Error(`Unsupported MCP client: ${invalid}`);
  let clients = [...new Set(requestedClients.filter(isMcpClient))];

  if (clients.length === 0) {
    if (values.yes) throw new Error("--client is required with --yes");
    const connected = (
      await Promise.all(
        Object.values(clientAdapters).map(async (adapter) => ({
          adapter,
          connection: (await commandAvailable(adapter.command))
            ? await existingConnection(adapter, deployment.workerName!)
            : undefined,
        })),
      )
    ).filter((candidate) => candidate.connection);
    if (connected.length === 0) {
      throw new Error(`No local MCP clients are connected to ${deployment.workerName}`);
    }
    clients = unwrapPrompt(
      await p.multiselect({
        initialValues: connected.map((candidate) => candidate.adapter.command),
        message: "Which clients should be disconnected?",
        options: connected.map(({ adapter }) => ({
          label: adapter.displayName,
          value: adapter.command,
        })),
        required: true,
      }),
    );
  }

  const unavailable = (
    await Promise.all(
      clients.map(async (client) => ({
        client,
        available: await commandAvailable(clientAdapters[client].command),
      })),
    )
  ).find((candidate) => !candidate.available);
  if (unavailable) {
    throw new Error(
      `${clientAdapters[unavailable.client].displayName} is not installed or not available on PATH`,
    );
  }

  const credentials = await readLocalCredentials(projectRoot);
  let removeCredentials = values["remove-credentials"];
  if (!values.yes && !removeCredentials && credentialsMatch(credentials, deployment)) {
    removeCredentials = unwrapPrompt(
      await p.confirm({
        initialValue: false,
        message: "Delete this checkout's matching Agent Mailbox credentials too?",
      }),
    );
  }
  const plan = createDisconnectionPlan({
    clients,
    projectRoot,
    removeCredentials,
    removeSkill: values["remove-skill"],
    workerName: deployment.workerName,
  });
  if (plan.removeCredentials && !credentialsMatch(credentials, deployment)) {
    throw new Error("The local credentials do not match this configured deployment");
  }

  p.note(
    [
      `Instance: ${plan.connectionName}`,
      `Clients: ${plan.clients.map((client) => client.adapter.displayName).join(", ")}`,
      `Credentials: ${plan.removeCredentials ? "delete" : "keep"}`,
      `Shared skill: ${plan.removeSkill ? "delete for selected clients" : "keep"}`,
    ].join("\n"),
    "Local cleanup plan",
  );

  if (!values.yes) {
    const approved = unwrapPrompt(
      await p.confirm({
        initialValue: false,
        message: "Apply these local client changes?",
      }),
    );
    if (!approved) {
      p.outro("No local configuration was changed.");
      return;
    }
  }

  for (const client of plan.clients) {
    const connection = await existingConnection(client.adapter, plan.connectionName);
    if (connection) {
      await runCommand(client.adapter.command, client.adapter.removeArgs(plan.connectionName), {
        quiet: true,
      });
      p.log.success(`${client.adapter.displayName}: MCP connection removed`);
    } else {
      p.log.info(`${client.adapter.displayName}: MCP connection already absent`);
    }
    if (plan.removeSkill) {
      const state = await skillState(plan.skillSource, client.skillTarget);
      if (state === "current") {
        await rm(client.skillTarget, { recursive: true });
        p.log.success(`${client.adapter.displayName}: shared skill removed`);
      }
    }
  }

  if (plan.removeCredentials) {
    await rm(resolve(projectRoot, ".agent-mailbox.credentials.json"));
    p.log.success("Matching local credentials deleted");
  }
  p.outro("Local Agent Mailbox connections removed.");
}
