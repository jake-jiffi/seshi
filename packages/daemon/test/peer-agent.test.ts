/**
 * Unit tests for the peer agent.
 *
 * Every test here runs against a FAKE `claude` written into a temp dir and put
 * on PATH. Nothing in this file spawns a real model or spends a token. The real
 * binary is exercised by peer-agent.live.test.ts, which is skipped unless
 * SESHI_LIVE=1.
 *
 * The fakes model one measured detail of the real binary that an obvious fake
 * gets wrong: with `--input-format stream-json` the child says nothing until
 * the first frame arrives on stdin, and only then emits its init event. A fake
 * that volunteers init at startup makes the C1 gate look like it works when it
 * does not, which is exactly what happened the first time this was written.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PeerAgent, buildArgs, buildEnv } from "../src/peer-agent.ts";
import type { PeerAgentOptions } from "../src/peer-agent.ts";

let root: string;
const originalPath = process.env["PATH"];

before(() => {
  root = mkdtempSync(join(tmpdir(), "seshi-peer-agent-"));
});

after(() => {
  process.env["PATH"] = originalPath;
  rmSync(root, { recursive: true, force: true });
});

/** Written by every fake before it does anything else, so tests can inspect the spawn. */
type SpawnRecord = {
  argv: string[];
  anthropicApiKey: string | null;
  anthropicAuthToken: string | null;
  messagingSocket: string | null;
  messagingToken: string | null;
};

/**
 * Write a fake `claude` into its own directory, put that directory first on
 * PATH, and return the paths it records into.
 *
 * The log paths are baked into the script as literals rather than passed
 * through the environment, so the tests that assert on environment stripping
 * are not themselves relying on the environment being passed through.
 */
function installFakeClaude(
  name: string,
  behaviour: string,
): { spawnLog: string; turnLog: string } {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const spawnLog = join(dir, "spawn.json");
  const turnLog = join(dir, "turns.jsonl");
  const script = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const readline = require("node:readline");
fs.writeFileSync(${JSON.stringify(spawnLog)}, JSON.stringify({
  argv: process.argv.slice(2),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? null,
  anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN ?? null,
  messagingSocket: process.env.CLAUDE_CODE_MESSAGING_SOCKET ?? null,
  messagingToken: process.env.CLAUDE_CODE_MESSAGING_TOKEN ?? null,
}));
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const init = (apiKeySource) => emit({
  type: "system", subtype: "init", session_id: "fake-session",
  apiKeySource, claude_code_version: "2.1.240", model: "fake-model",
});
const assistantText = (text) => emit({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text }] },
});
const ok = (text) => emit({ type: "result", subtype: "success", is_error: false, result: text });
const userText = (line) => {
  const content = JSON.parse(line).message.content;
  return typeof content === "string" ? content : content.map((b) => b.text).join("");
};
/**
 * Silent until the first frame arrives, then init, then one call to onTurn per
 * frame. n is 1 for the priming turn the agent sends itself.
 */
const serve = (apiKeySource, onTurn) => {
  let n = 0;
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    if (line.trim() === "") return;
    const text = userText(line);
    fs.appendFileSync(${JSON.stringify(turnLog)}, JSON.stringify(text) + "\\n");
    n += 1;
    if (n === 1) init(apiKeySource);
    onTurn(text, n);
  });
};
${behaviour}
`;
  writeFileSync(join(dir, "claude"), script, { mode: 0o755 });
  process.env["PATH"] = `${dir}:${originalPath ?? ""}`;
  return { spawnLog, turnLog };
}

/** An echoing fake on the subscription. */
const ECHOES = `serve("none", (text) => { assistantText("echo:" + text); ok("echo:" + text); });`;

function options(overrides: Partial<PeerAgentOptions> = {}): PeerAgentOptions {
  return {
    convoId: "0199f000-0000-7000-8000-000000000001",
    settingsPath: join(root, "tier2.json"),
    scopedDir: root,
    startTimeoutMs: 5_000,
    ...overrides,
  };
}

const readSpawn = (log: string): SpawnRecord =>
  JSON.parse(readFileSync(log, "utf8")) as SpawnRecord;

const readTurns = (log: string): string[] =>
  readFileSync(log, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as string);

test("never passes --bare", () => {
  assert.ok(!buildArgs(options()).includes("--bare"));
});

test("always passes --setting-sources user", () => {
  assert.ok(buildArgs(options()).join(" ").includes("--setting-sources user"));
});

test("passes stream-json both ways, the tier settings, the convo id and the scoped dir", () => {
  const args = buildArgs(options()).join(" ");
  assert.ok(args.includes("--input-format stream-json"));
  assert.ok(args.includes("--output-format stream-json"));
  // Claude Code 2.1.240 exits 1 without this: "When using --print,
  // --output-format=stream-json requires --verbose".
  assert.ok(args.includes("--verbose"));
  assert.ok(args.includes(`--settings ${join(root, "tier2.json")}`));
  assert.ok(args.includes("--session-id 0199f000-0000-7000-8000-000000000001"));
  assert.ok(args.includes(`--add-dir ${root}`));
});

test("strips every API-credential and peer-bus variable from the child environment", () => {
  const env = buildEnv({
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "sk-ant-leak",
    ANTHROPIC_AUTH_TOKEN: "tok",
    ANTHROPIC_BASE_URL: "https://proxy.example",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_USE_VERTEX: "1",
    CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/x.sock",
    CLAUDE_CODE_MESSAGING_TOKEN: "peer-token",
  });
  assert.equal(env["PATH"], "/usr/bin");
  for (const k of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
  ])
    assert.equal(env[k], undefined, `${k} must not reach the peer process`);
});

test("asserts subscription auth and refuses an API key", async () => {
  const { spawnLog } = installFakeClaude("apikey", `serve("ANTHROPIC_API_KEY", () => {});`);
  const agent = new PeerAgent(options());
  await assert.rejects(agent.start(), /subscription|apiKeySource/i);
  assert.equal(agent.running, false, "the process must be killed, not left running");
  assert.equal(readSpawn(spawnLog).argv.includes("--bare"), false);
});

test("accepts apiKeySource none", async () => {
  installFakeClaude("subscription", ECHOES);
  const agent = new PeerAgent(options());
  await agent.start();
  assert.equal(agent.running, true);
  agent.stop();
});

test("start's priming turn is seshi's own words, never the peer's, and is sent once", async () => {
  const { turnLog } = installFakeClaude("priming", ECHOES);
  const agent = new PeerAgent(options());
  const seen: string[] = [];
  agent.on("text", (t: string) => seen.push(t));
  await agent.start();
  const turns = readTurns(turnLog);
  assert.equal(turns.length, 1, "exactly one turn before the caller has said anything");
  assert.match(turns[0] ?? "", /^seshi startup check\./);
  assert.deepEqual(seen, [], "the priming turn is not conversation text");
  agent.stop();
});

test("the spawned process never sees ANTHROPIC_API_KEY even when the daemon does", async () => {
  const { spawnLog } = installFakeClaude("envleak", ECHOES);
  process.env["ANTHROPIC_API_KEY"] = "sk-ant-should-not-leak";
  process.env["CLAUDE_CODE_MESSAGING_SOCKET"] = "/tmp/cc-socks/fake.sock";
  try {
    const agent = new PeerAgent(options());
    await agent.start();
    agent.stop();
  } finally {
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["CLAUDE_CODE_MESSAGING_SOCKET"];
  }
  const spawned = readSpawn(spawnLog);
  assert.equal(spawned.anthropicApiKey, null);
  assert.equal(spawned.messagingSocket, null);
});

test("send resolves with the result text and surfaces assistant text events", async () => {
  installFakeClaude("send", ECHOES);
  const agent = new PeerAgent(options());
  const seen: string[] = [];
  agent.on("text", (t: string) => seen.push(t));
  await agent.start();
  assert.equal(await agent.send("hello"), "echo:hello");
  assert.equal(await agent.send("again"), "echo:again");
  assert.deepEqual(seen, ["echo:hello", "echo:again"]);
  agent.stop();
});

test("refuses a second send while a turn is in flight", async () => {
  installFakeClaude(
    "concurrent",
    `serve("none", (text, n) => { if (n === 1) return ok("READY"); setTimeout(() => ok(text), 150); });`,
  );
  const agent = new PeerAgent(options());
  await agent.start();
  const first = agent.send("one");
  await assert.rejects(agent.send("two"), /in flight|already/i);
  assert.equal(await first, "one");
  agent.stop();
});

test("send before start is an error", async () => {
  installFakeClaude("nostart", ECHOES);
  const agent = new PeerAgent(options());
  await assert.rejects(agent.send("hi"), /not started/i);
});

test("send after stop is an error", async () => {
  installFakeClaude("afterstop", ECHOES);
  const agent = new PeerAgent(options());
  await agent.start();
  agent.stop();
  await assert.rejects(agent.send("hi"), /not started|not running/i);
});

test("start fails loudly when claude dies before the init event", async () => {
  installFakeClaude("dies", `process.stderr.write("fake claude exploded\\n"); process.exit(7);`);
  const agent = new PeerAgent(options());
  await assert.rejects(agent.start(), /exploded|code 7/i);
});

test("start times out rather than hanging when claude never speaks", async () => {
  installFakeClaude("silent", `setTimeout(() => {}, 60_000);`);
  const agent = new PeerAgent(options({ startTimeoutMs: 200 }));
  await assert.rejects(agent.start(), /timed out|timeout/i);
  assert.equal(agent.running, false);
});

test("start fails when the priming turn itself errors", async () => {
  installFakeClaude(
    "primefail",
    `serve("none", () => emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "no capacity" }));`,
  );
  const agent = new PeerAgent(options());
  await assert.rejects(agent.start(), /no capacity|error_during_execution/i);
  // A failed start must not leave a `claude` running: the first version of this
  // held the whole test process open at exit.
  assert.equal(agent.running, false);
});

test("a turn that dies mid-flight rejects the pending send", async () => {
  installFakeClaude(
    "crash",
    `serve("none", (text, n) => { if (n === 1) return ok("READY"); process.exit(3); });`,
  );
  const agent = new PeerAgent(options());
  await agent.start();
  await assert.rejects(agent.send("hello"), /exit|died/i);
  assert.equal(agent.running, false);
});

test("an errored result rejects the send instead of resolving with the error text", async () => {
  installFakeClaude(
    "errresult",
    `serve("none", (text, n) => { if (n === 1) return ok("READY");
      emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "model blew up" }); });`,
  );
  const agent = new PeerAgent(options());
  await agent.start();
  await assert.rejects(agent.send("hello"), /model blew up|error_during_execution/i);
  agent.stop();
});

test("non-JSON noise and unknown events on stdout do not break the stream", async () => {
  installFakeClaude(
    "noise",
    `process.stdout.write("warning: something plugin-ish\\n");
     serve("none", (text, n) => {
       process.stdout.write("more noise\\n");
       emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
       ok(n === 1 ? "READY" : "echo:" + text);
     });`,
  );
  const agent = new PeerAgent(options());
  await agent.start();
  assert.equal(await agent.send("hi"), "echo:hi");
  agent.stop();
});

test("stop is idempotent and leaves the agent not running", async () => {
  installFakeClaude("stop", ECHOES);
  const agent = new PeerAgent(options());
  await agent.start();
  agent.stop();
  agent.stop();
  assert.equal(agent.running, false);
});

test("start cannot be called twice on one agent", async () => {
  installFakeClaude("twice", ECHOES);
  const agent = new PeerAgent(options());
  await agent.start();
  await assert.rejects(agent.start(), /already started/i);
  agent.stop();
});

test("claude missing from PATH fails start with a legible error", async () => {
  const empty = join(root, "empty-path");
  mkdirSync(empty, { recursive: true });
  process.env["PATH"] = empty;
  const agent = new PeerAgent(options());
  await assert.rejects(agent.start(), /ENOENT|not found|spawn/i);
  process.env["PATH"] = originalPath;
});

// --- Attacks on the C1 gate itself -------------------------------------------
// These three are the ones worth being nervous about: each is a way to end up
// with a live, usable child that was never proved to be on a subscription.

test("a child that answers turns but never emits init is never usable", async () => {
  installFakeClaude(
    "noinit",
    `readline.createInterface({ input: process.stdin }).on("line", (line) => {
       if (line.trim() !== "") ok("answered without ever identifying myself");
     });`,
  );
  const agent = new PeerAgent(options({ startTimeoutMs: 400 }));
  await assert.rejects(agent.start(), /timed out/i);
  assert.equal(agent.running, false);
  await assert.rejects(agent.send("hello"), /not started|not running/i);
});

test("an init that reports an API key mid-conversation kills the agent", async () => {
  installFakeClaude(
    "lateinit",
    `let n = 0;
     readline.createInterface({ input: process.stdin }).on("line", (line) => {
       if (line.trim() === "") return;
       n += 1;
       if (n === 1) { init("none"); return ok("READY"); }
       init("ANTHROPIC_API_KEY");
       ok("this turn should never be delivered");
     });`,
  );
  const agent = new PeerAgent(options());
  await agent.start();
  await assert.rejects(agent.send("hello"), /apiKeySource|subscription/i);
  assert.equal(agent.running, false);
});

test("an agent stopped before it starts refuses to start", async () => {
  installFakeClaude("stopfirst", ECHOES);
  const agent = new PeerAgent(options());
  agent.stop();
  await assert.rejects(agent.start(), /stopped/i);
  assert.equal(agent.running, false);
});
