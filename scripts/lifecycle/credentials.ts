import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

export const credentialsName = ".agent-mailbox.credentials.json";

const credentialsSchema = z.object({
  apiKey: z.string().min(1),
  emailDomain: z.string().min(1),
  healthUrl: z.url(),
  mcpUrl: z.url(),
});

export type LocalCredentials = z.infer<typeof credentialsSchema>;

/** Returns no credentials for a missing file, but rejects malformed credential files. */
export async function readLocalCredentials(
  projectRoot: string,
): Promise<LocalCredentials | undefined> {
  try {
    const source = await readFile(resolve(projectRoot, credentialsName), "utf8");
    return credentialsSchema.parse(JSON.parse(source));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error(`${credentialsName} is not valid`, { cause: error });
  }
}

export function credentialsMatch(
  credentials: LocalCredentials | undefined,
  values: { emailDomain?: string; mcpHostname?: string },
): boolean {
  if (!credentials || !values.emailDomain || !values.mcpHostname) return false;
  return (
    credentials.emailDomain === values.emailDomain &&
    new URL(credentials.mcpUrl).hostname === values.mcpHostname
  );
}
