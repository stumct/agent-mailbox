import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

async function readVersion(path: string): Promise<string> {
  const parsed: unknown = JSON.parse(await readFile(resolve(path), "utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("version" in parsed) ||
    typeof parsed.version !== "string"
  )
    throw new Error(`${path} has no valid version`);
  return parsed.version;
}

const tag = process.argv[2];
if (!tag?.startsWith("v")) throw new Error("Pass the v-prefixed release tag");

const [applicationVersion, packageVersion] = await Promise.all([
  readVersion("package.json"),
  readVersion("packages/create-agent-mailbox/package.json"),
]);
const expectedTag = `v${packageVersion}`;

if (applicationVersion !== packageVersion) {
  throw new Error(`Version mismatch: application=${applicationVersion}, package=${packageVersion}`);
}
if (tag !== expectedTag) {
  throw new Error(`Release tag ${tag} does not match package version ${expectedTag}`);
}

console.log(`Release ${tag} matches the application and setup package versions.`);
