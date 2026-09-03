/**
 * The regression test for the review's headline finding.
 *
 * The detector unit tests all passed while the detectors were, in the running
 * system, completely inert. They passed because they synthesised histories the
 * real `Conversation` never produced: self turns carried `from: ""`, which
 * `detect()` filters out of `parties`, so `agreement` and `deadlock` could never
 * reach their two-party gate and the fold detector only ever examined the peer.
 * The ledger never left `open` because `transition()` was called nowhere. And
 * `namedConcessions` was never supplied by any caller.
 *
 * So this file drives the REAL `Conversation`, against a fake `claude` on PATH
 * that replies with real envelopes, and asserts the detectors actually fire.
 * A unit test that calls `detect()` directly cannot catch this class of bug and
 * a version of this file must exist for as long as the detectors matter.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay } from "../../packages/relay/src/server.ts";
import { SeshiNode } from "../../packages/daemon/src/node.ts";
import { Conversation } from "../../packages/daemon/src/conversation.ts";
import type { PublicBrief } from "../../packages/daemon/src/storage.ts";
import type { Envelope } from "../../packages/core/src/envelope.ts";

const dirs: string[] = [];
const tmp = (l: string) => {
  const d = mkdtempSync(join(tmpdir(), `seshi-wire-${l}-`));
  dirs.push(d);
  return d;
};
const originalPath = process.env["PATH"];
process.on("exit", () => {
  process.env["PATH"] = originalPath;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/**
 * A fake `claude` that replies with a scripted queue of envelope bodies, one
 * per turn. It mimics the one measured behaviour that matters: the init event
 * is emitted at the start of a TURN, not at startup.
 */
/** Where the fake writes every prompt it is handed. Read by human-in-the-loop.test.ts's twin. */
let promptLog = "";

function fakeClaude(replies: string[]): string {
  const dir = tmp("bin");
  const queue = join(dir, "queue.json");
  const argvLog = join(dir, "argv.json");
  promptLog = join(dir, "prompts.jsonl");
  writeFileSync(queue, JSON.stringify(replies));
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));
let turn = 0;
let init = false;
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    fs.appendFileSync(${JSON.stringify(promptLog)}, buf.slice(0, nl) + "\\n");
    buf = buf.slice(nl + 1);
    if (!init) {
      init = true;
      process.stdout.write(JSON.stringify({
        type: "system", subtype: "init", session_id: "fake",
        apiKeySource: "none", claude_code_version: "fake", model: "fake",
      }) + "\\n");
    }
    const replies = JSON.parse(fs.readFileSync(${JSON.stringify(queue)}, "utf8"));
    // Turn 0 is the priming turn; the driver expects exactly READY.
    const text = turn === 0 ? "READY" : (replies[turn - 1] ?? replies[replies.length - 1]);
    turn += 1;
    process.stdout.write(JSON.stringify({
      type: "assistant", message: { content: [{ type: "text", text }] },
    }) + "\\n");
    // The real binary carries the final text on the RESULT event, not only on
    // the assistant event. A fake that omits it makes send() resolve empty.
    process.stdout.write(JSON.stringify({
      type: "result", subtype: "success", result: text,
    }) + "\\n");
  }
});
`;
  writeFileSync(join(dir, "claude"), script, { mode: 0o755 });
  process.env["PATH"] = `${dir}:${originalPath ?? ""}`;
  return argvLog;
}

const BRIEF: PublicBrief = {
  objective: "settle the handoff format",
  definitionOfDone: ["one agreed format"],
  nonNegotiables: [
    { text: "no new infrastructure", reason: "no ops budget" },
    { text: "must run without Blender", reason: "our users do not have it" },
  ],
  facts: [],
};

async function twoSides(t: { after: (fn: () => void | Promise<void>) => void }, replies: string[]) {
  fakeClaude(replies);
  const relay = await startRelay({ port: 0 });
  const url = `ws://127.0.0.1:${relay.port}`;
  const jake = await SeshiNode.open({ home: tmp("jake"), relayUrl: url, name: "jake", defaultTier: 2 });
  const dave = await SeshiNode.open({ home: tmp("dave"), relayUrl: url, name: "dave", defaultTier: 2 });
  dave.pairWithBundle(jake.inviteBundle());
  jake.pairWithBundle(dave.inviteBundle());

  const convo = jake.startConvo({ peer: "dave", mode: "decide", brief: BRIEF });
  const side = new Conversation({
    node: jake,
    convo,
    peer: jake.contact("dave"),
    scopedDir: jake.storage.convoDir(convo.id),
    tier: 2,
  });
  t.after(async () => {
    side.stop();
    jake.close();
    dave.close();
    await relay.close();
    process.env["PATH"] = originalPath;
  });
  await side.open();
  return { jake, dave, convo, side };
}

/** An envelope shaped exactly as it arrives from a real peer. */
function fromPeer(convo: string, seq: number, e: Partial<Envelope>): Envelope {
  return {
    v: 1, convo, seq, prev: null,
    from: "d".repeat(32),
    act: "COUNTER", headline: "h", body: "b",
    ...e,
  } as Envelope;
}

test("a real Conversation stamps its own turns, so both parties are visible to the detectors", async (t) => {
  const { jake, side } = await twoSides(t, [
    JSON.stringify({ act: "BRIEF", headline: "opening", body: "my position" }),
  ]);
  const mine = await side.openingTurn();
  assert.equal(mine.from, jake.fingerprint, "a self turn must carry our own fingerprint, not \"\"");
  assert.notEqual(mine.from, "");
});

test("a real Conversation moves its ledger, so convergence is measurable", async (t) => {
  const { convo, side } = await twoSides(t, [
    JSON.stringify({
      act: "PROPOSE",
      headline: "proposing",
      body: "here is my proposal",
      ledger: [{ id: "i-01", state: "proposed" }],
    }),
  ]);
  assert.equal(side.ledger.openCount(), 2, "two non-negotiables were seeded");
  await side.openingTurn();
  assert.equal(side.ledger.get("i-01")?.state, "proposed", "the ledger must actually move");
  void convo;
});

test("OUR OWN agent folding is caught, which the unwired version could never see", async (t) => {
  // Four turns, all capitulation. Before the fix, `parties` never contained us,
  // so the fold detector only ever examined the peer and this went unnoticed.
  const fold = JSON.stringify({ act: "ACCEPT", headline: "sure", body: "whatever you think" });
  const { convo, side } = await twoSides(t, [fold, fold, fold, fold]);

  await side.openingTurn();
  for (let i = 0; i < 3; i += 1) {
    side.observe(fromPeer(convo.id, i + 1, { act: "PROPOSE", headline: `p${i}`, body: `body ${i}` }));
    await side.replyTo(fromPeer(convo.id, i + 1, { act: "PROPOSE", headline: `p${i}`, body: `body ${i}` }));
  }

  const found = side.detections();
  const degenerate = found.filter((d) => d.kind === "degenerate");
  assert.ok(degenerate.length > 0, `our own fold must be caught, got: ${JSON.stringify(found.map((d) => d.kind))}`);
  assert.match(degenerate[0]!.because, /accepted or conceded/);
});

test("a RED_TEAM that names no concession is caught through the real path", async (t) => {
  const { convo, side } = await twoSides(t, [
    JSON.stringify({ act: "PROPOSE", headline: "p", body: "my proposal here" }),
    JSON.stringify({
      act: "RED_TEAM",
      headline: "nothing to report",
      body: "we agreed on everything, no concerns",
      concessions: [],
    }),
  ]);

  await side.openingTurn();
  side.observe(fromPeer(convo.id, 1, { act: "COUNTER", headline: "c", body: "I disagree" }));
  await side.replyTo(fromPeer(convo.id, 1, { act: "COUNTER", headline: "c", body: "I disagree" }));

  const found = side.detections();
  assert.ok(
    found.some((d) => d.kind === "degenerate" && /could not name a single position/.test(d.because)),
    `expected the empty-concession fold, got: ${JSON.stringify(found.map((d) => d.because))}`,
  );
});

test("a RED_TEAM naming a real concession is not flagged", async (t) => {
  const { convo, side } = await twoSides(t, [
    JSON.stringify({ act: "PROPOSE", headline: "p", body: "my proposal here" }),
    JSON.stringify({
      act: "RED_TEAM",
      headline: "what I gave up",
      body: "I dropped millimetres, which costs us a conversion step on every import",
      concessions: ["millimetres, costing a conversion step on every import"],
    }),
  ]);

  await side.openingTurn();
  side.observe(fromPeer(convo.id, 1, { act: "COUNTER", headline: "c", body: "I disagree" }));
  await side.replyTo(fromPeer(convo.id, 1, { act: "COUNTER", headline: "c", body: "I disagree" }));

  assert.equal(
    side.detections().some((d) => d.kind === "degenerate" && /name a single position/.test(d.because)),
    false,
  );
});

test("an invented ledger state does not move the ledger and does not crash the turn", async (t) => {
  const { side } = await twoSides(t, [
    JSON.stringify({
      act: "PROPOSE",
      headline: "p",
      body: "b",
      ledger: [{ id: "i-01", state: "closed" }, { id: "i-02", state: "proposed" }],
    }),
  ]);
  await side.openingTurn();
  assert.equal(side.ledger.get("i-01")?.state, "open", "an invented state must be ignored");
  assert.equal(side.ledger.get("i-02")?.state, "proposed", "a valid one alongside it still applies");
});

test("a peer cannot add, delete or resurrect an issue in our ledger", async (t) => {
  const { convo, side } = await twoSides(t, [
    JSON.stringify({ act: "PROPOSE", headline: "p", body: "b", ledger: [{ id: "i-01", state: "proposed" }] }),
  ]);
  await side.openingTurn();
  side.observe(
    fromPeer(convo.id, 1, {
      act: "COUNTER",
      headline: "c",
      body: "b",
      ledger: [
        { id: "i-99", state: "agreed" }, // an issue we never had
        { id: "i-01", state: "open" }, // trying to walk ours backwards
      ],
    }),
  );
  assert.equal(side.ledger.get("i-99"), null, "a peer cannot add an issue");
  assert.equal(side.ledger.all().length, 2, "still just our two seeded issues");
  assert.equal(side.ledger.get("i-01")?.state, "open", "proposed -> open is legal, and it is ours to apply");
});

test("the transcript credits our turns to us and theirs to them", async (t) => {
  const { convo, side } = await twoSides(t, [
    JSON.stringify({ act: "PROPOSE", headline: "mine", body: "my proposal" }),
  ]);
  await side.openingTurn();
  side.observe(fromPeer(convo.id, 1, { act: "COUNTER", headline: "theirs", body: "their counter" }));

  const md = side.writeDecision([]);
  assert.match(md, /\*\*us\*\* `PROPOSE` mine/, "our turn must be credited to us");
  assert.match(md, /\*\*dave\*\* `COUNTER` theirs/, "their turn must be credited to them");
  assert.doesNotMatch(md, /\*\*dave\*\* `PROPOSE` mine/, "our turn must never be credited to them");
});

test("tier 3: a peer's agent writes into a throwaway worktree, and the human gets a patch", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { readFileSync } = await import("node:fs");

  // A repo the human is working in, on their own branch, with their own edits.
  const repo = tmp("repo");
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  writeFileSync(join(repo, "handoff.md"), "# Handoff\n\nTBD\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");

  // The peer's agent writes a file, then reports it.
  const argvLog = fakeClaude([
    JSON.stringify({ act: "PROPOSE", headline: "drafted the handoff spec", body: "written to handoff.md" }),
  ]);

  const relay = await startRelay({ port: 0 });
  const jake = await SeshiNode.open({
    home: tmp("jake3"), relayUrl: `ws://127.0.0.1:${relay.port}`, name: "jake", defaultTier: 2,
  });
  const dave = await SeshiNode.open({
    home: tmp("dave3"), relayUrl: `ws://127.0.0.1:${relay.port}`, name: "dave", defaultTier: 2,
  });
  jake.pairWithBundle(dave.inviteBundle());

  const convo = jake.startConvo({ peer: "dave", mode: "build", brief: BRIEF });
  const side = new Conversation({
    node: jake,
    convo,
    peer: jake.contact("dave"),
    scopedDir: jake.storage.convoDir(convo.id),
    tier: 3,
    repo,
  });
  t.after(async () => {
    side.discardWorktree();
    side.stop();
    jake.close();
    dave.close();
    await relay.close();
    process.env["PATH"] = originalPath;
  });
  await side.open();

  // The human's checkout is untouched and still on their branch.
  assert.equal(
    execFileSync("git", ["branch", "--show-current"], { cwd: repo, encoding: "utf8" }).trim(),
    "main",
  );

  const worktree = join(jake.storage.convoDir(convo.id), "worktree");

  // THE BOUNDARY. The agent must be scoped to the worktree and nowhere else.
  // Without this assertion the test passes even if --add-dir points straight at
  // the human's checkout, which is the whole thing tier 3 exists to prevent.
  const argv = JSON.parse(readFileSync(argvLog, "utf8")) as string[];
  const addDir = argv[argv.indexOf("--add-dir") + 1];
  assert.equal(addDir, worktree, "--add-dir must point at the worktree, never the human's repo");
  assert.notEqual(addDir, repo);
  assert.ok(argv.includes("--setting-sources") && argv.includes("user"));

  // Stand in for the agent's Edit tool, which is what tier 3 permits.
  writeFileSync(join(worktree, "handoff.md"), "# Handoff\n\nOBJ plus a JSON sidecar.\n");
  writeFileSync(join(worktree, "sidecar.schema.json"), '{"units":"mm"}\n');

  await side.openingTurn();

  // The human's own files never changed.
  assert.equal(readFileSync(join(repo, "handoff.md"), "utf8"), "# Handoff\n\nTBD\n");
  assert.equal(existsSync(join(repo, "sidecar.schema.json")), false);

  // And a patch came out, carrying both the edit and the new file.
  const patch = side.proposedPatch();
  assert.ok(patch !== null, "tier 3 must produce a patch");
  assert.match(patch, /OBJ plus a JSON sidecar/);
  assert.match(patch, /sidecar\.schema\.json/, "a new file must be in the patch, not silently dropped");

  // DECISION.md carries it, so the human reads one document.
  const md = side.writeDecision([]);
  assert.match(md, /## Proposed changes/);
  assert.match(md, /throwaway worktree on branch/);
  assert.match(md, /```diff/);

  // The patch applies cleanly in the human's own checkout. This is the flow.
  const patchFile = join(repo, "peer.patch");
  writeFileSync(patchFile, patch);
  execFileSync("git", ["apply", patchFile], { cwd: repo, stdio: "pipe" });
  assert.match(readFileSync(join(repo, "handoff.md"), "utf8"), /OBJ plus a JSON sidecar/);
});

test("tier 3 without a repo is refused rather than silently downgraded", async (t) => {
  fakeClaude(["{}"]);
  const relay = await startRelay({ port: 0 });
  const jake = await SeshiNode.open({
    home: tmp("jake4"), relayUrl: `ws://127.0.0.1:${relay.port}`, name: "jake", defaultTier: 2,
  });
  const dave = await SeshiNode.open({
    home: tmp("dave4"), relayUrl: `ws://127.0.0.1:${relay.port}`, name: "dave", defaultTier: 2,
  });
  jake.pairWithBundle(dave.inviteBundle());
  t.after(async () => {
    jake.close();
    dave.close();
    await relay.close();
  });

  const convo = jake.startConvo({ peer: "dave", mode: "build", brief: BRIEF });
  assert.throws(
    () =>
      new Conversation({
        node: jake,
        convo,
        peer: jake.contact("dave"),
        scopedDir: jake.storage.convoDir(convo.id),
        tier: 3,
      }),
    /tier 3 needs a repo/,
  );
});

test("mode actually reaches the detectors, so a teach learner is not flagged as folding", async (t) => {
  // The mode-awareness fix is inert unless Conversation passes mode through.
  // That is the same class of bug as the detectors being unwired at all, so it
  // gets a test that drives the real path rather than calling detect() directly.
  const accept = JSON.stringify({ act: "ACCEPT", headline: "understood", body: "that makes sense to me" });
  fakeClaude([accept, accept, accept, accept]);

  const relay = await startRelay({ port: 0 });
  const jake = await SeshiNode.open({
    home: tmp("jaketeach"), relayUrl: `ws://127.0.0.1:${relay.port}`, name: "jake", defaultTier: 2,
  });
  const dave = await SeshiNode.open({
    home: tmp("daveteach"), relayUrl: `ws://127.0.0.1:${relay.port}`, name: "dave", defaultTier: 2,
  });
  jake.pairWithBundle(dave.inviteBundle());
  t.after(async () => {
    jake.close(); dave.close(); await relay.close();
    process.env["PATH"] = originalPath;
  });

  const convo = jake.startConvo({ peer: "dave", mode: "teach", brief: BRIEF });
  const side = new Conversation({
    node: jake, convo, peer: jake.contact("dave"),
    scopedDir: jake.storage.convoDir(convo.id), tier: 2,
  });
  t.after(() => side.stop());
  await side.open();

  await side.openingTurn();
  for (let i = 0; i < 3; i += 1) {
    const inbound = fromPeer(convo.id, i + 1, { act: "EVIDENCE", headline: `lesson ${i}`, body: `here is how I do step ${i}` });
    side.observe(inbound);
    await side.replyTo(inbound);
  }

  const found = side.detections();
  assert.equal(
    found.filter((d) => d.kind === "degenerate").length,
    0,
    `a teach learner accepting what it is taught must not be flagged: ${JSON.stringify(found.map((d) => d.because))}`,
  );
});

test("a peer declaring an issue agreed on its own does not make it a decision", async (t) => {
  const { jake, convo, side } = await twoSides(t, [
    JSON.stringify({ act: "BRIEF", headline: "opening", body: "my position" }),
    JSON.stringify({
      act: "COUNTER",
      headline: "no",
      body: "I do not agree with that",
      ledger: [{ id: "i-01", state: "proposed" }],
    }),
  ]);
  const daveFp = jake.contact("dave").fingerprint;
  await side.openingTurn();
  const proposal = fromPeer(convo.id, 1, {
    from: daveFp, act: "PROPOSE", headline: "p", body: "b",
    ledger: [{ id: "i-01", state: "proposed" }],
  });
  side.observe(proposal);
  await side.replyTo(proposal);
  // The peer now unilaterally calls it agreed. The transition is legal, so the
  // ledger moves, and the artefact used to print it as a decision we signed.
  side.observe(fromPeer(convo.id, 2, {
    from: daveFp, act: "ACCEPT", headline: "done", body: "agreed then",
    ledger: [{ id: "i-01", state: "agreed" }],
  }));
  assert.equal(side.ledger.get("i-01")?.state, "agreed", "the ledger itself moves on a legal transition");

  const md = side.writeDecision();
  assert.match(md, /_No issue reached agreement/, "one side's say-so must not become a decision");
  assert.match(md, /\[agreed by one side only\] no new infrastructure/, "and the artefact says which side");
});

test("an issue both sides' latest ledger views call agreed is a decision", async (t) => {
  const { jake, convo, side } = await twoSides(t, [
    JSON.stringify({
      act: "BRIEF", headline: "opening", body: "my position",
      ledger: [{ id: "i-01", state: "proposed" }],
    }),
    JSON.stringify({
      act: "ACCEPT", headline: "yes", body: "agreed",
      ledger: [{ id: "i-01", state: "agreed" }],
    }),
  ]);
  const daveFp = jake.contact("dave").fingerprint;
  await side.openingTurn();
  const accept = fromPeer(convo.id, 1, {
    from: daveFp, act: "ACCEPT", headline: "a", body: "b",
    ledger: [{ id: "i-01", state: "agreed" }],
  });
  side.observe(accept);
  await side.replyTo(accept);

  const md = side.writeDecision();
  assert.match(md, /## Decision\n\n- no new infrastructure/, "both said agreed, so it is decided");
  assert.doesNotMatch(md, /agreed by one side only/);
});
