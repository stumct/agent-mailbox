import * as p from "@clack/prompts";
import { CloudflareApi, wranglerAuthSchema } from "./cloudflare-api.ts";
import { runWrangler } from "./process.ts";
import { isProfileBoundTo, parseWranglerProfiles, withWranglerProfile } from "./profiles.ts";

export type CloudflareSessionOptions = {
  profile?: string;
  yes?: boolean;
};

export function unwrapPrompt<T>(value: T | symbol, message = "Operation cancelled."): T {
  if (p.isCancel(value)) {
    p.cancel(message);
    process.exit(0);
  }
  return value;
}

/** Selects one Wrangler keyring profile without changing the active profile globally. */
export async function chooseWranglerProfile(
  projectRoot: string,
  options: CloudflareSessionOptions,
): Promise<string | undefined> {
  if (options.profile) return options.profile;
  if (process.env.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_KEY) return undefined;

  const output = await runWrangler(projectRoot, ["auth", "list"], { quiet: true });
  const profiles = parseWranglerProfiles(output);
  if (profiles.length === 0) return undefined;
  if (profiles.length === 1) return profiles[0]?.name;
  if (options.yes) {
    throw new Error("--profile is required with --yes when multiple Wrangler profiles exist");
  }

  const active = profiles.find((profile) => isProfileBoundTo(profile, projectRoot));
  return unwrapPrompt(
    await p.select({
      initialValue:
        active?.name ??
        (profiles.some((profile) => profile.name === "default") ? "default" : profiles[0]?.name),
      message: "Which Wrangler profile should manage Agent Mailbox?",
      options: profiles.map((profile) => ({
        ...(isProfileBoundTo(profile, projectRoot) ? { hint: "active for this directory" } : {}),
        label: profile.name === "default" ? "default (Wrangler fallback)" : profile.name,
        value: profile.name,
      })),
    }),
  );
}

/** Reuses Wrangler's OAuth/keyring credential without persisting it in this project. */
export async function connectCloudflare(
  projectRoot: string,
  options: CloudflareSessionOptions,
): Promise<CloudflareApi> {
  const readAuth = async () => {
    const output = await runWrangler(
      projectRoot,
      withWranglerProfile(["auth", "token", "--json"], options.profile),
      { quiet: true },
    );
    return wranglerAuthSchema.parse(JSON.parse(output));
  };

  try {
    return new CloudflareApi({ auth: await readAuth() });
  } catch (error) {
    if (options.yes) {
      throw new Error("Wrangler is not authenticated. Run the command interactively once.", {
        cause: error,
      });
    }

    const shouldLogin = unwrapPrompt(
      await p.confirm({
        initialValue: true,
        message: options.profile
          ? `Connect Wrangler profile "${options.profile}" to Cloudflare now?`
          : "Connect Wrangler to your Cloudflare account now?",
      }),
    );
    if (!shouldLogin) throw new Error("Cloudflare authentication is required", { cause: error });
    if (options.profile && options.profile !== "default") {
      await runWrangler(projectRoot, ["auth", "create", options.profile]);
    } else {
      await runWrangler(projectRoot, ["login", "--use-keyring"]);
    }
    return new CloudflareApi({ auth: await readAuth() });
  }
}
