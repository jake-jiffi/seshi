/**
 * The real thing.
 *
 * Two independent seshi identities, each running its OWN `claude -p` process on
 * the user's OWN subscription, hold an actual conversation across a relay. No
 * API key exists anywhere in this test. Nothing is mocked except the fact that
 * both machines happen to be this one.
 *
 * Skipped unless SESHI_LIVE=1, because it spawns real models and costs real
 * tokens. Run it with:
 *
 *   SESHI_LIVE=1 node --test test/e2e/live-conversation.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay } from "@seshi/relay/server";
import { SeshiNode } from "@seshi/daemon/node";
import { Conversation } from "@seshi/daemon/conversation";
import type { PublicBrief } from "@seshi/daemon/storage";
import type { Envelope } from "@seshi/core/envelope";
import { detect } from "@seshi/core/detectors";

const LIVE = process.env["SESHI_LIVE"] === "1";
const dirs: string[] = [];
const tmp = (l: string) => {
  const d = mkdtempSync(join(tmpdir(), `seshi-live-${l}-`));
  dirs.push(d);
  return d;
};
process.on("exit", () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const JAKE_BRIEF: PublicBrief = {
  objective: "agree how our two halves of the 2d-to-3d skill hand meshes to each other",
  definitionOfDone: ["one agreed handoff format both skills implement"],
  nonNegotiables: [
    { text: "the skill must run without Blender installed", reason: "most of our users do not have it" },
  ],
  facts: ["my half emits triangle meshes in millimetres", "I already ship a Gemini to Tripo pipeline"],
};

const DAVE_BRIEF: PublicBrief = {
  objective: "agree how our two halves of the 2d-to-3d skill hand meshes to each other",
  definitionOfDone: ["one agreed handoff format both skills implement"],
  nonNegotiables: [
    { text: "edge flow must survive the handoff", reason: "retopology is the whole value of my half" },
  ],
  facts: ["my half consumes quad meshes", "I work in metres, not millimetres"],
};

test(
  "two real Claude processes, on two identities, hold a conversation over the relay",
  { skip: LIVE ? false : "set SESHI_LIVE=1 to run (spawns real models)" },
  async (t) => {
    const relay = await startRelay({ port: 0 });
    const url = `ws://127.0.0.1:${relay.port}`;

    const jake = await SeshiNode.open({ home: tmp("jake"), relayUrl: url, name: "jake", defaultTier: 2 });
    const dave = await SeshiNode.open({ home: tmp("dave"), relayUrl: url, name: "dave", defaultTier: 2 });
    t.after(async () => {
      jake.close();
      dave.close();
      await relay.close();
    });

    // Pair, and confirm the safety words agree.
    const a = dave.pair(jake.invite());
    const b = jake.pair(dave.invite());
    assert.deepEqual(a.safetyWords, b.safetyWords);
    console.log(`\n  safety words: ${a.safetyWords.join(" ")}\n`);

    const jakeConvo = jake.startConvo({ peer: "dave", mode: "decide", brief: JAKE_BRIEF, turns: 6 });
    dave.storage.putConvo({
      id: jakeConvo.id,
      peer: jake.fingerprint,
      mode: "decide",
      state: "live",
      createdAt: new Date().toISOString(),
      budget: { turns: 6, warnAt: 4, used: 0 },
      brief: DAVE_BRIEF,
    });

    const jakeSide = new Conversation({
      node: jake,
      convo: jakeConvo,
      peer: jake.contact("dave"),
      scopedDir: jake.storage.convoDir(jakeConvo.id),
      tier: 2,
    });
    const daveSide = new Conversation({
      node: dave,
      convo: dave.storage.getConvo(jakeConvo.id)!,
      peer: dave.contact("jake"),
      scopedDir: dave.storage.convoDir(jakeConvo.id),
      tier: 2,
    });
    t.after(() => {
      jakeSide.stop();
      daveSide.stop();
    });

    console.log("  spawning both peer agents...");
    await Promise.all([jakeSide.open(), daveSide.open()]);
    console.log("  both agents up\n");

    // Jake's agent opens from its own brief.
    let outbound: Envelope = await jakeSide.openingTurn();
    console.log(`  jake  ${outbound.act.padEnd(15)} ${outbound.headline}`);
    await jake.send(jakeConvo.id, outbound);

    const transcript: Envelope[] = [outbound];
    let turns = 0;
    const MAX = 5;

    // Strict alternation. One turn token, passed back and forth.
    let waiting: [SeshiNode, Conversation, SeshiNode, Conversation] = [dave, daveSide, jake, jakeSide];
    while (turns < MAX) {
      const [recvNode, recvSide, sendBackNode, _sendBackSide] = waiting;

      const inbound = await recvNode.waitForTurn({ timeoutMs: 180_000 });
      recvSide.observe(inbound.envelope);

      const reply = await recvSide.replyTo(inbound.envelope);
      const who = recvNode === jake ? "jake " : "dave ";
      console.log(`  ${who} ${reply.act.padEnd(15)} ${reply.headline}`);
      transcript.push(reply);

      await recvNode.send(inbound.envelope.convo, reply);
      turns += 1;

      if (reply.act === "CLOSE" || reply.act === "ACCEPT") break;
      waiting = [sendBackNode, _sendBackSide, recvNode, recvSide];
    }

    // What actually has to be true.
    assert.ok(transcript.length >= 3, `expected a real exchange, got ${transcript.length} turns`);

    const jakeTurns = transcript.filter((_, i) => i % 2 === 0);
    assert.ok(
      jakeTurns.every((e) => e.body.length > 0 && e.body.length <= 1200),
      "every body must be non-empty and within the cap",
    );

    const notUnderstood = transcript.filter((e) => e.act === "NOT_UNDERSTOOD");
    assert.ok(
      notUnderstood.length < transcript.length / 2,
      `too many unparseable turns: ${notUnderstood.length}/${transcript.length}. ` +
        `First: ${notUnderstood[0]?.body.slice(0, 300)}`,
    );

    // Both sides hold a durable record.
    assert.ok(jake.storage.readLog(jakeConvo.id, "self").length > 0);
    assert.ok(dave.storage.readLog(jakeConvo.id, jake.fingerprint).length > 0);

    // And an artefact exists, even though this run was cut short by the cap.
    // Note it writes from jake's OWN history: each side holds its own record
    // and neither is authoritative over the other.
    const decision = jakeSide.writeDecision(
      detect({ history: [...jakeSide.history], ledger: jakeSide.ledger }),
    );
    assert.match(decision, /## Decision/);
    assert.equal(jake.storage.readDecision(jakeConvo.id), decision);

    console.log("\n--- DECISION.md (jake's copy) ---");
    console.log(decision.split("\n").slice(0, 30).join("\n"));
    console.log("---\n");
  },
);
