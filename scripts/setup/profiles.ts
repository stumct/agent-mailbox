import { sep } from "node:path";

const ansiEscape = new RegExp(`${String.fromCodePoint(27)}\\[[0-?]*[ -/]*[@-~]`, "gu");

export type WranglerProfile = {
  boundDirectories: string[];
  name: string;
};

export function parseWranglerProfiles(output: string): WranglerProfile[] {
  const normalized = output.replace(ansiEscape, "");
  const profiles: WranglerProfile[] = [];
  const seen = new Set<string>();

  for (const line of normalized.split(/\r?\n/u)) {
    const cells = line
      .split("│")
      .slice(1, -1)
      .map((cell) => cell.trim());
    const [name, directories] = cells;
    if (!name || !directories || name === "Profile" || seen.has(name)) continue;

    seen.add(name);
    profiles.push({
      boundDirectories:
        directories === "-"
          ? []
          : directories
              .split(",")
              .map((directory) => directory.trim())
              .filter(Boolean),
      name,
    });
  }

  if (profiles.length === 0 && !normalized.includes("No profiles found")) {
    throw new Error("Could not read the Wrangler profile list; pass --profile explicitly");
  }
  return profiles;
}

export function isProfileBoundTo(profile: WranglerProfile, projectRoot: string): boolean {
  return profile.boundDirectories.some(
    (directory) => projectRoot === directory || projectRoot.startsWith(`${directory}${sep}`),
  );
}

export function withWranglerProfile(args: string[], profile?: string): string[] {
  return profile ? [...args, "--profile", profile] : args;
}
