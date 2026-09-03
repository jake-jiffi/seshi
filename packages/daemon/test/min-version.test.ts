/**
 * The tier deny list names tools and the stream parser expects fields, both
 * verified against one Claude Code build. A build older than that may not
 * honour the settings this process relies on, so it is refused at the init
 * event, the same place an API key is refused.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atLeast, MIN_CLAUDE_CODE, PeerAgent } from "../src/peer-agent.ts";

const dirs: string[] = [];
const originalPath = process.env["PATH"];
process.on("exit", () => {
  process.env["PATH"] = originalPath;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A fake claude whose init event reports the given version, then answers READY. */
function fakeClaudeReporting(version: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "seshi-version-"));
  dirs.push(dir);
  const init = version === null
    ? `{ type: "system", subtype: "init", session_id: "fake", apiKeySource: "none" }`
    : `{ type: "system", subtype: "init", session_id: "fake", apiKeySource: "none", claude_code_version: ${JSON.stringify(version)} }`;
  writeFileSync(
    join(dir, "claude"),
    `#!/usr/bin/env node
let init = false; let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk; let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    buf = buf.slice(nl + 1);
    if (!init) { init = true; process.stdout.write(JSON.stringify(${init}) + "\\n"); }
    process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "READY" }] } }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "READY" }) + "\\n");
  }
});
`,
    { mode: 0o755 },
  );
  writeFileSync(join(dir, "settings.json"), "{}");
  process.env["PATH"] = `${dir}:${originalPath ?? ""}`;
  return dir;
}

function agentIn(dir: string): PeerAgent {
  return new PeerAgent({
    convoId: "11111111-1111-4111-8111-111111111111",
    settingsPath: join(dir, "settings.json"),
    scopedDir: dir,
    startTimeoutMs: 10_000,
  });
}

test("version comparison is numeric, per component", () => {
  assert.ok(atLeast("2.1.240", "2.1.240"));
  assert.ok(atLeast("2.1.241", "2.1.240"));
  assert.ok(atLeast("2.2.0", "2.1.999"));
  assert.ok(atLeast("3.0.0", "2.1.240"));
  assert.ok(!atLeast("2.1.239", "2.1.240"));
  assert.ok(!atLeast("2.1", "2.1.240"), "a missing component is zero, not infinity");
  assert.ok(!atLeast("fake", "2.1.240"), "garbage is older than everything");
});

test("a Claude Code older than the verified build is refused at init", async (t) => {
  const dir = fakeClaudeReporting("2.1.239");
  const agent = agentIn(dir);
  t.after(() => agent.stop());
  await assert.rejects(() => agent.start(), /older than 2\.1\.240/);
  assert.equal(agent.running, false, "the child must be gone, not idling on a bad build");
});

test("an init event with no version at all is refused, not trusted", async (t) => {
  const dir = fakeClaudeReporting(null);
  const agent = agentIn(dir);
  t.after(() => agent.stop());
  await assert.rejects(() => agent.start(), /unknown version/);
});

test("the verified build, and anything newer, starts", async (t) => {
  for (const v of [MIN_CLAUDE_CODE, "2.9.0"]) {
    const dir = fakeClaudeReporting(v);
    const agent = agentIn(dir);
    t.after(() => agent.stop());
    await agent.start();
    assert.equal(agent.running, true, `${v} should have started`);
  }
});
