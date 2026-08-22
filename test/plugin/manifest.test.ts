import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const pluginRoot = join(repoRoot, "plugin");
const manifestPath = join(pluginRoot, ".claude-plugin", "plugin.json");
const hookPath = join(pluginRoot, "hooks", "session-start.sh");
const skillPath = join(pluginRoot, "skills", "seshi", "SKILL.md");

type Manifest = {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  license?: unknown;
  hooks?: unknown;
};

type HookEntry = { type?: unknown; command?: unknown };
type HookMatcher = { matcher?: unknown; hooks?: HookEntry[] };
type HooksConfig = { hooks?: Record<string, HookMatcher[]> };

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Front matter of a SKILL.md, as flat `key: value` pairs. */
function frontmatter(md: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(md);
  assert.ok(m, "SKILL.md must open with a YAML front matter block");
  const out: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]!] = kv[2]!.trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/**
 * Run the SessionStart hook the way Claude Code does: hook JSON on stdin,
 * CLAUDE_PLUGIN_ROOT in the environment.
 */
function runHook(opts: {
  seshiOnPath: boolean;
  withIdentity: boolean;
  dropEnv?: string[];
  prefix?: string;
  extraEnv?: Record<string, string>;
}): { stdout: string } {
  const sandbox = mkdtempSync(join(tmpdir(), opts.prefix ?? "seshi-hook-"));
  const bin = join(sandbox, "bin");
  const home = join(sandbox, "home");
  const seshiHome = join(sandbox, "seshi");
  mkdirSync(bin);
  mkdirSync(home);
  mkdirSync(seshiHome);
  if (opts.seshiOnPath) {
    const stub = join(bin, "seshi");
    writeFileSync(stub, "#!/bin/sh\nexit 0\n");
    chmodSync(stub, 0o755);
  }
  if (opts.withIdentity) writeFileSync(join(seshiHome, "identity.json"), "{}");

  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: home,
    SESHI_HOME: seshiHome,
    CLAUDE_PLUGIN_ROOT: pluginRoot,
    ...(opts.extraEnv ?? {}),
  };
  for (const key of opts.dropEnv ?? []) delete env[key];

  const stdout = execFileSync(hookPath, {
    input: JSON.stringify({
      session_id: "1e5e8f2a-0000-4000-8000-000000000001",
      cwd: "/Users/someone/dev/thing",
      hook_event_name: "SessionStart",
      source: "startup",
    }),
    env,
    encoding: "utf8",
  });
  return { stdout };
}

test("the plugin manifest parses and identifies seshi", () => {
  const m = readJson(manifestPath) as Manifest;
  assert.equal(m.name, "seshi");
  assert.equal(typeof m.version, "string");
  assert.equal(typeof m.description, "string");
  assert.ok((m.description as string).length > 20);
  assert.equal(m.license, "MIT");
});

test("the manifest points at a hooks config that exists", () => {
  const m = readJson(manifestPath) as Manifest;
  assert.equal(typeof m.hooks, "string", "hooks must be a path to a hooks config");
  const hooksPath = join(pluginRoot, (m.hooks as string).replace(/^\.\//, ""));
  assert.ok(statSync(hooksPath).isFile(), `${hooksPath} must exist`);
});

test("the hooks config runs session-start.sh on SessionStart", () => {
  const m = readJson(manifestPath) as Manifest;
  const cfg = readJson(join(pluginRoot, (m.hooks as string).replace(/^\.\//, ""))) as HooksConfig;
  const sessionStart = cfg.hooks?.["SessionStart"];
  assert.ok(Array.isArray(sessionStart) && sessionStart.length > 0, "SessionStart must be declared");
  const commands = sessionStart
    .flatMap((entry) => entry.hooks ?? [])
    .map((h) => {
      assert.equal(h.type, "command");
      return String(h.command);
    });
  assert.ok(
    commands.some((c) => c.includes("CLAUDE_PLUGIN_ROOT") && c.includes("hooks/session-start.sh")),
    `SessionStart must invoke hooks/session-start.sh, got ${JSON.stringify(commands)}`,
  );
});

test("the hook is an executable script that credits agmsg", () => {
  const mode = statSync(hookPath).mode;
  assert.ok(mode & 0o111, "session-start.sh must be executable");
  const src = readFileSync(hookPath, "utf8");
  assert.match(src, /^#!/, "must have a shebang");
  const header = src.slice(0, 1200);
  assert.match(header, /agmsg/i, "the Monitor-wake mechanism must be credited to agmsg");
  assert.match(header, /MIT/, "agmsg's licence must be named");
  assert.match(header, /fujibee/i, "the upstream project must be identified");
});

test("the hook directs the model to Monitor 'seshi watch' persistently", () => {
  const { stdout } = runHook({ seshiOnPath: true, withIdentity: true });
  assert.match(stdout, /Monitor/, "must name the Monitor tool");
  assert.match(stdout, /persistent:\s*true/, "must ask for a persistent Monitor task");
  assert.match(stdout, /\bwatch\b/, "must point Monitor at seshi watch");
  assert.match(stdout, /command:\s*\S*seshi\S*\s+watch/, "must give a runnable command line");
});

test("the hook shell-quotes an awkward install path", () => {
  const { stdout } = runHook({ seshiOnPath: true, withIdentity: true, prefix: "seshi o'brien dir-" });
  const m = /command: (.+)/.exec(stdout);
  assert.ok(m, "a command line must be printed");
  // Re-parse the printed command with a real shell: it must survive round-tripping.
  const echoed = execFileSync("/bin/bash", ["-c", `for a in ${m[1]!}; do printf '%s\n' "$a"; done`], {
    encoding: "utf8",
  }).trim().split("\n");
  assert.equal(echoed.length, 2, `expected exactly two argv words, got ${JSON.stringify(echoed)}`);
  assert.match(echoed[0]!, /seshi o'brien dir-.*\/bin\/seshi$/);
  assert.equal(echoed[1], "watch");
});

test("the hook stays silent when seshi is not installed", () => {
  const { stdout } = runHook({ seshiOnPath: false, withIdentity: true });
  assert.equal(stdout.trim(), "", "an uninstalled seshi must not nag the model");
});

test("the hook stays silent before seshi init has run", () => {
  const { stdout } = runHook({ seshiOnPath: true, withIdentity: false });
  assert.equal(stdout.trim(), "", "no identity means nothing to watch");
});

test("the hook never touches an API key and never passes --bare", () => {
  const src = readFileSync(hookPath, "utf8");
  assert.doesNotMatch(src, /ANTHROPIC_API_KEY/);
  assert.doesNotMatch(src, /--bare/);
});

test("the hook survives a stripped environment", () => {
  const { stdout } = runHook({
    seshiOnPath: false,
    withIdentity: false,
    dropEnv: ["HOME", "SESHI_HOME", "CLAUDE_PLUGIN_ROOT"],
  });
  assert.equal(stdout.trim(), "", "no HOME must mean a quiet exit 0, not an unbound-variable crash");
});

test("the hook resolves seshi from PATH only, never from an environment variable", () => {
  const planted = mkdtempSync(join(tmpdir(), "seshi-planted-"));
  const evil = join(planted, "not-seshi");
  writeFileSync(evil, "#!/bin/sh\nexit 0\n");
  chmodSync(evil, 0o755);
  const { stdout } = runHook({
    seshiOnPath: false,
    withIdentity: true,
    extraEnv: { SESHI_BIN: evil, SESHI_CMD: evil, SESHI_WATCH: evil },
  });
  assert.doesNotMatch(stdout, /not-seshi/, "a settings-writable env var must not become a command");
  assert.equal(stdout.trim(), "", "with no seshi on PATH there is nothing to say");
});

test("the skill front matter carries a description and an argument hint", () => {
  const fm = frontmatter(readFileSync(skillPath, "utf8"));
  assert.equal(fm["name"], "seshi");
  assert.ok((fm["description"] ?? "").length > 40, "description must be substantive");
  assert.ok((fm["argument-hint"] ?? "").length > 0, "argument-hint must be present");
  assert.match(fm["argument-hint"]!, /invite|start|say/, "argument-hint must show real verbs");
});
