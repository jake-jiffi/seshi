/**
 * Where seshi remembers your relay, so nobody has to export an env var.
 *
 * A first-run experience that begins with "set SESHI_RELAY" is a first-run
 * experience most people abandon. The relay address is written once, by
 * `seshi use`, and every command after that just works.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Config = {
  /** ws:// or wss:// address of the relay both parties connect to. */
  relay?: string;
  /** Display name the other person sees. */
  name?: string;
};

export function seshiHome(): string {
  return process.env["SESHI_HOME"] ?? join(homedir(), ".seshi");
}

function configPath(): string {
  return join(seshiHome(), "config.json");
}

export function readConfig(): Config {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    const c = parsed as Record<string, unknown>;
    return {
      ...(typeof c["relay"] === "string" ? { relay: c["relay"] } : {}),
      ...(typeof c["name"] === "string" ? { name: c["name"] } : {}),
    };
  } catch {
    // A corrupt config should not stop you using seshi; it should just not lie
    // about what it holds.
    return {};
  }
}

export function writeConfig(patch: Config): Config {
  const merged = { ...readConfig(), ...patch };
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  return merged;
}

/** Env beats config, config beats nothing. There is no baked-in default. */
export function relayUrl(): string | null {
  const fromEnv = process.env["SESHI_RELAY"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return readConfig().relay ?? null;
}

export function displayName(): string {
  return (
    process.env["SESHI_NAME"] ??
    readConfig().name ??
    homedir().split("/").filter(Boolean).pop() ??
    "someone"
  );
}

/**
 * There is deliberately no default relay baked into the source.
 *
 * A default would mean every stranger who installs this silently routes their
 * conversations through one person's machine, and that person becomes the
 * metadata sink for everyone. Whoever runs `seshi serve` chooses to carry that,
 * and says so out loud when they hand out the address.
 */
export const NO_RELAY_HELP = `No relay set.

One of you runs it, once, and leaves it running:

    seshi serve

That points you at it and prints the address. The other person needs nothing:
the link you send them carries it. To use a relay nobody sent you a link for:

    seshi use wss://<address>

The relay only ever sees encrypted frames and two fingerprints. It cannot read
a word of what you say.`;
