/**
 * Live integration test for the peer agent.
 *
 * Spawns a REAL `claude` on the machine's own subscription, under real tier 2
 * settings, and asserts one round trip. Skipped unless SESHI_LIVE=1, because it
 * spends the user's tokens and takes tens of seconds.
 *
 *   SESHI_LIVE=1 node --test 'packages/daemon/test/peer-agent.live.test.ts'
 *
 * What it is actually proving is C1: if this machine were thinking on an API
 * key rather than a subscription, start() would reject on the init event and
 * this test would fail rather than quietly billing someone.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { PeerAgent } from "../src/peer-agent.ts";
import { tierSettings } from "../src/tiers.ts";

const live = process.env["SESHI_LIVE"] === "1";

test(
  "a real claude answers one turn on the subscription",
  { skip: live ? false : "set SESHI_LIVE=1 to run against a real claude", timeout: 300_000 },
  async () => {
    const home = mkdtempSync(join(tmpdir(), "seshi-live-home-"));
    const scoped = mkdtempSync(join(tmpdir(), "seshi-live-scope-"));
    const settingsPath = join(home, "tier2.json");
    writeFileSync(settingsPath, JSON.stringify(tierSettings(2, { seshiHome: home }), null, 2));

    const agent = new PeerAgent({
      convoId: randomUUID(),
      settingsPath,
      scopedDir: scoped,
      cwd: scoped,
      startTimeoutMs: 180_000,
    });

    const streamed: string[] = [];
    agent.on("text", (t: string) => streamed.push(t));

    try {
      // Rejects unless the init event says apiKeySource "none".
      await agent.start();
      assert.equal(agent.running, true);

      const reply = await agent.send("reply with exactly OK and nothing else");
      assert.equal(reply.trim(), "OK");
      assert.equal(streamed.join("").trim(), "OK");
    } finally {
      agent.stop();
      rmSync(home, { recursive: true, force: true });
      rmSync(scoped, { recursive: true, force: true });
    }
  },
);
