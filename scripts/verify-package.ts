import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const packResultSchema = z
  .array(
    z.object({
      files: z.array(z.object({ path: z.string() })),
    }),
  )
  .length(1);

const packageDirectory = resolve("packages/create-agent-mailbox");
const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
  cwd: packageDirectory,
});
const [packResult] = packResultSchema.parse(JSON.parse(stdout));
if (!packResult) throw new Error("npm pack did not return an artifact");
const actualFiles = new Set(packResult.files.map((file) => file.path));
const expectedFiles = new Set([
  "LICENSE",
  "README.md",
  "dist/index.js",
  "dist/scaffold.js",
  "dist/validate-package.js",
  "package.json",
]);

const missing = [...expectedFiles].filter((path) => !actualFiles.has(path));
const unexpected = [...actualFiles].filter((path) => !expectedFiles.has(path));
if (missing.length > 0 || unexpected.length > 0) {
  throw new Error(
    [
      missing.length > 0 ? `Missing package files: ${missing.join(", ")}` : undefined,
      unexpected.length > 0 ? `Unexpected package files: ${unexpected.join(", ")}` : undefined,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

console.log(`Packed setup artifact contains the expected ${actualFiles.size} files.`);
