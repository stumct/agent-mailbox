import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { configureWrangler, normalizeHostname, readDeploymentValues } from "./wrangler-config.ts";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      check: { type: "boolean", default: false },
      config: { type: "string", default: "wrangler.jsonc" },
      domain: { type: "string" },
      hostname: { type: "string" },
      validate: { type: "boolean", default: false },
    },
    strict: true,
  });
  const configPath = resolve(values.config);
  const source = await readFile(configPath, "utf8");

  if (values.check) {
    const current = readDeploymentValues(source);
    const configured = configureWrangler(source, current);
    if (configured !== source) {
      throw new Error("Deployment hostnames in wrangler.jsonc are inconsistent");
    }
    console.log(`Configuration structure is valid: ${configPath}`);
    return;
  }

  if (!values.domain || !values.hostname) {
    throw new Error("Both --domain and --hostname are required");
  }

  const deployment = {
    emailDomain: normalizeHostname(values.domain, "Receiving email domain"),
    mcpHostname: normalizeHostname(values.hostname, "Public Worker hostname"),
  };
  const configured = configureWrangler(source, deployment);

  if (values.validate) {
    console.log("Domain and hostname are valid.");
    return;
  }

  if (configured !== source) {
    const temporaryPath = `${configPath}.${process.pid}.tmp`;
    try {
      await writeFile(temporaryPath, configured, "utf8");
      await rename(temporaryPath, configPath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  console.log(`Configured ${configPath}`);
  console.log(`  Email domain: ${deployment.emailDomain}`);
  console.log(`  MCP endpoint: https://${deployment.mcpHostname}/mcp`);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  await main();
}
