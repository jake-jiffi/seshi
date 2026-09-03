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

/**
 * The relay seshi ships pointed at.
 *
 * ADR 001 refused a baked-in default because it makes one operator the
 * metadata sink for every stranger who installs. The amendment of 2026-09-03
 * takes that trade on purpose: Jiffi runs this box, says so on first use, and
 * `seshi use` points anywhere else in one line. What the relay sees is two
 * routing fingerprints and ciphertext, never content.
 */
export const DEFAULT_RELAY = "wss://relay.seshi.sh";

/** Env beats config, config beats the default. Never null. */
export function relayUrl(): string {
  const fromEnv = process.env["SESHI_RELAY"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return readConfig().relay ?? DEFAULT_RELAY;
}

/**
 * True the first time a machine falls back to the default: nothing in the
 * environment and nothing in config. The caller says whose box it is, once,
 * and writes the default into config so the next run is quiet and `whoami`
 * shows the truth.
 */
export function adoptDefaultRelay(): boolean {
  const fromEnv = process.env["SESHI_RELAY"];
  if (fromEnv !== undefined && fromEnv !== "") return false;
  if (readConfig().relay !== undefined) return false;
  writeConfig({ relay: DEFAULT_RELAY });
  return true;
}

export const DEFAULT_RELAY_NOTE = `  Using Jiffi's relay at ${DEFAULT_RELAY}.
  It carries sealed frames between paired people. It sees two fingerprints and
  ciphertext, never content. To use a box of your own:  seshi use wss://<host>
`;

export function displayName(): string {
  return (
    process.env["SESHI_NAME"] ??
    readConfig().name ??
    homedir().split("/").filter(Boolean).pop() ??
    "someone"
  );
}
