import { spawn } from "node:child_process";
import { resolve } from "node:path";

type RunOptions = {
  cwd?: string;
  input?: string;
  quiet?: boolean;
};

export class CommandError extends Error {
  readonly command: string;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(command: string, exitCode: number | null, stderr: string) {
    super(stderr.trim() || `${command} exited with code ${exitCode ?? "unknown"}`);
    this.name = "CommandError";
    this.command = command;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: [
        options.input === undefined ? "inherit" : "pipe",
        options.quiet ? "pipe" : "inherit",
        "pipe",
      ],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      if (!options.quiet) process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      const errorOutput = Buffer.concat(stderr).toString("utf8");
      if (exitCode === 0) {
        resolvePromise(Buffer.concat(stdout).toString("utf8"));
      } else {
        reject(new CommandError([command, ...args].join(" "), exitCode, errorOutput));
      }
    });

    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

export function wranglerCommand(projectRoot: string): { args: string[]; command: string } {
  return {
    command: process.execPath,
    args: [resolve(projectRoot, "node_modules/wrangler/bin/wrangler.js")],
  };
}

export async function runWrangler(
  projectRoot: string,
  args: string[],
  options: RunOptions = {},
): Promise<string> {
  const wrangler = wranglerCommand(projectRoot);
  return runCommand(wrangler.command, [...wrangler.args, ...args], {
    cwd: projectRoot,
    ...options,
  });
}

export function detectPackageManager(): "bun" | "npm" | "pnpm" | "yarn" {
  const name = process.env.npm_config_user_agent?.split("/")[0];
  if (name === "bun" || name === "pnpm" || name === "yarn") return name;
  return "npm";
}
