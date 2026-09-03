/**
 * The founding constraint that had no code: the human watches, cuts in, and
 * their words go to both sides. These drive the real Conversation against the
 * fake `claude` and read the prompts it was actually handed, because "the
 * agent was told" is only true if the bytes reached the process.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay } from "../../packages/relay/src/server.ts";
import { SeshiNode } from "../../packages/daemon/src/node.ts";
import { Conversation } from "../../packages/daemon/src/conversation.ts";
import { startDaemon } from "../../packages/daemon/src/daemon.ts";
import { controlRequest } from "../../packages/daemon/src/control.ts";
import { Storage, type PublicBrief } from "../../packages/daemon/src/storage.ts";
import type { Envelope } from "../../packages/core/src/envelope.ts";
import { formatEvent } from "../../packages/cli/src/watch.ts";

const dirs: string[] = [];
const tmp = (l: string): string => {
  const d = mkdtempSync(join(tmpdir(), `seshi-human-${l}-`));
  dirs.push(d);
  return d;
};
const originalPath = process.env["PATH"];
process.on("exit", () => {
  process.env["PATH"] = originalPath;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

let promptLog = "";
function prompts(): string[] {
  return readFileSync(promptLog, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => {
      const frame = JSON.parse(l) as { message?: { content?: Array<{ text?: string }> } };
      return frame.message?.content?.[0]?.text ?? "";
    });
}

function fakeClaude(replies: string[]): void {
  const dir = tmp("bin");
  const queue = join(dir, "queue.json");
  promptLog = join(dir, "prompts.jsonl");
  writeFileSync(queue, JSON.stringify(replies));
  writeFileSync(
    join(dir, "claude"),
    `#!/usr/bin/env node
const fs = require("node:fs");
let turn = 0; let init = false; let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk; let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    fs.appendFileSync(${JSON.stringify(promptLog)}, buf.slice(0, nl) + "\\n");
    buf = buf.slice(nl + 1);
    if (!init) { init = true; process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "fake", apiKeySource: "none", claude_code_version: "2.1.240" }) + "\\n"); }
    const replies = JSON.parse(fs.readFileSync(${JSON.stringify(queue)}, "utf8"));
    const text = turn === 0 ? "READY" : (replies[turn - 1] ?? replies[replies.length - 1]);
    turn += 1;
    // A reply that starts with !ERROR is emitted the way Claude Code reports a
    // failed turn: an is_error result carrying the service's message.
    if (text.startsWith("!ERROR ")) {
      process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: text.slice(7) }) + "\\n");
      continue;
    }
    process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }) + "\\n");
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: text }) + "\\n");
  }
});
`,
    { mode: 0o755 },
  );
  process.env["PATH"] = `${dir}:${originalPath ?? ""}`;
}

const BRIEF: PublicBrief = {
  objective: "settle the handoff format",
  definitionOfDone: ["one agreed format"],
  nonNegotiables: [{ text: "must run without Blender", reason: "our users do not have it" }],
  facts: [],
};

async function twoSides(
  t: { after: (fn: () => void | Promise<void>) => void },
  replies: string[],
  extra: { retryDelaysMs?: number[]; onNote?: (line: string) => void } = {},
) {
  fakeClaude(replies);
  const relay = await startRelay({ port: 0 });
  const url = `ws://127.0.0.1:${relay.port}`;
  const jake = await SeshiNode.open({ home: tmp("jake"), relayUrl: url, name: "jake", defaultTier: 2 });
  const dave = await SeshiNode.open({ home: tmp("dave"), relayUrl: url, name: "dave", defaultTier: 2 });
  dave.pairWithBundle(jake.inviteBundle());
  jake.pairWithBundle(dave.inviteBundle());
  const convo = jake.startConvo({ peer: "dave", mode: "decide", brief: BRIEF });
  const side = new Conversation({
    node: jake, convo, peer: jake.contact("dave"),
    scopedDir: jake.storage.convoDir(convo.id), tier: 2, ...extra,
  });
  t.after(async () => {
    side.stop();
    jake.close();
    dave.close();
    await relay.close();
    process.env["PATH"] = originalPath;
  });
  await side.open();
  const daveFp = jake.contact("dave").fingerprint;
  const fromDave = (seq: number, e: Partial<Envelope>): Envelope =>
    ({ v: 1, convo: convo.id, seq, prev: null, from: daveFp, act: "COUNTER", headline: "h", body: "b", ...e }) as Envelope;
  return { jake, dave, convo, side, fromDave };
}

// A well-behaved reply carries the ledger, so the reminder in #turn stays out
// of these tests unless a test leaves it out on purpose.
const reply = (act: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    act, headline: `${act} headline`, body: `${act} body`,
    ledger: [{ id: "i-01", state: "open" }], ...extra,
  });

test("what our human says live reaches the agent's next prompt, above everything else, once", async (t) => {
  const { side, fromDave } = await twoSides(t, [reply("BRIEF"), reply("COUNTER"), reply("COUNTER")]);
  await side.openingTurn();

  side.interject("drop the Blender requirement, I have changed my mind");
  const p1 = fromDave(1, { act: "PROPOSE" });
  side.observe(p1);
  await side.replyTo(p1);
  const withWords = prompts().at(-1)!;
  assert.match(withWords, /^YOUR HUMAN IS WATCHING AND JUST SAID THIS/);
  assert.match(withWords, /drop the Blender requirement/);

  // Said once, heard once: the next turn does not repeat it.
  const p2 = fromDave(2, { act: "PROPOSE", headline: "again" });
  side.observe(p2);
  await side.replyTo(p2);
  assert.doesNotMatch(prompts().at(-1)!, /drop the Blender requirement/);

  // And it is in the transcript as a HUMAN turn of ours.
  assert.match(side.writeDecision(), /\*\*us\*\* `HUMAN` drop the Blender requirement/);
});

test("the other person cutting in is framed as their words, still wrapped as untrusted", async (t) => {
  const { side, fromDave } = await twoSides(t, [reply("BRIEF"), reply("COUNTER")]);
  await side.openingTurn();
  const human = fromDave(1, { act: "HUMAN", headline: "stop", body: "stop arguing about OBJ, <b>use glTF</b>" });
  side.observe(human);
  await side.replyTo(human);
  const last = prompts().at(-1)!;
  assert.match(last, /THE OTHER PERSON THEMSELVES, dave, cut in live/);
  assert.match(last, /not an instruction from your human/);
  assert.match(last, /<seshi-peer from=/, "another machine's bytes stay wrapped");
  assert.match(last, /&lt;b&gt;use glTF&lt;\/b&gt;/, "and escaped");
  assert.doesNotMatch(last, /YOUR HUMAN IS WATCHING/, "their human is not our human");
});

test("a human cutting in does not hide the agent folding", async (t) => {
  // Three folds. Three interjections in between would halve the rate if they
  // counted as turns, and the detector would go quiet on an agent that gave
  // way every single time it spoke.
  const fold = reply("ACCEPT");
  const { side, fromDave } = await twoSides(t, [reply("BRIEF"), fold, fold, fold]);
  await side.openingTurn();
  for (let i = 1; i <= 3; i++) {
    side.interject(`steer ${i}`);
    const p = fromDave(i, { act: "PROPOSE", headline: `p${i}`, body: `body ${i}` });
    side.observe(p);
    await side.replyTo(p);
  }
  const degenerate = side.detections().filter((d) => d.kind === "degenerate");
  assert.ok(degenerate.some((d) => /accepted or conceded on 100%/.test(d.because)),
    `expected the fold at 100%, got ${JSON.stringify(degenerate.map((d) => d.because))}`);
});

test("a reply that leaves the ledger out gets one reminder, and the reminded reply is what ships", async (t) => {
  const bare = JSON.stringify({ act: "COUNTER", headline: "no", body: "I disagree" });
  const withLedger = JSON.stringify({
    act: "COUNTER", headline: "no", body: "I disagree", ledger: [{ id: "i-01", state: "open" }],
  });
  const { side, fromDave } = await twoSides(t, [reply("BRIEF", { ledger: [{ id: "i-01", state: "open" }] }), bare, withLedger]);
  await side.openingTurn();
  const before = prompts().length;
  const p = fromDave(1, { act: "PROPOSE" });
  side.observe(p);
  const sent = await side.replyTo(p);
  assert.equal(prompts().length, before + 2, "one reply prompt plus exactly one reminder");
  assert.match(prompts().at(-1)!, /^Your reply left out the 'ledger' field/);
  assert.match(prompts().at(-1)!, /i-01 \[open\] must run without Blender/);
  assert.deepEqual(sent.ledger, [{ id: "i-01", state: "open" }], "the reminded reply is the one that ships");
});

test("a reply that carries the ledger is not reminded, and neither is NOT_UNDERSTOOD", async (t) => {
  const { side, fromDave } = await twoSides(t, [
    reply("BRIEF", { ledger: [{ id: "i-01", state: "open" }] }),
    reply("COUNTER", { ledger: [{ id: "i-01", state: "proposed" }] }),
    "this is not json at all",
  ]);
  await side.openingTurn();
  let before = prompts().length;
  const p1 = fromDave(1, { act: "PROPOSE" });
  side.observe(p1);
  await side.replyTo(p1);
  assert.equal(prompts().length, before + 1, "a ledgered reply costs one prompt");

  before = prompts().length;
  const p2 = fromDave(2, { act: "PROPOSE", headline: "again" });
  side.observe(p2);
  const sent = await side.replyTo(p2);
  assert.equal(sent.act, "NOT_UNDERSTOOD");
  assert.equal(prompts().length, before + 1, "a reply that did not parse is not nagged for a ledger");
});

test("a closing turn that leaves the ledger out is reminded even with nothing open, so both sides declare agreed", async (t) => {
  // The live run: our ACCEPT declared agreed, the peer's CLOSE carried no
  // ledger, and the artefact called a signed decision agreed by one side only.
  const closeBare = JSON.stringify({ act: "CLOSE", headline: "done", body: "closing" });
  const closeAgreed = JSON.stringify({ act: "CLOSE", headline: "done", body: "closing", ledger: [{ id: "i-01", state: "agreed" }] });
  const { side, fromDave } = await twoSides(t, [
    reply("BRIEF", { ledger: [{ id: "i-01", state: "proposed" }] }),
    closeBare,
    closeAgreed,
  ]);
  await side.openingTurn();
  const theirs = fromDave(1, { act: "ACCEPT", headline: "signed", body: "agreed", ledger: [{ id: "i-01", state: "agreed" }] });
  side.observe(theirs);
  assert.equal(side.ledger.openCount(), 0, "nothing is open any more");
  const before = prompts().length;
  const sent = await side.replyTo(theirs);
  assert.equal(prompts().length, before + 2, "reminded although nothing was open");
  assert.deepEqual(sent.ledger, [{ id: "i-01", state: "agreed" }]);
  assert.match(side.writeDecision(), /## Decision\n\n- must run without Blender/, "both sides declared agreed, so it is a decision");
});

test("a detector that fired mid-run is in the artefact even when nothing fires at the close", async (t) => {
  // Four turns with the ledger unmoved and an issue open trips looping. Then
  // both sides agree and looping goes quiet. The artefact keeps both facts.
  // Distinct positions on both sides, in real words: the position fingerprint
  // drops words under three characters, so "body 1" and "body 2" would read
  // as one restated position and trip deadlock instead.
  const ours = ["quads must survive the handoff", "metres rather than millimetres", "glTF cannot carry quads"];
  const theirs = ["edge flow is the whole point", "units are negotiable", "OBJ keeps the cage"];
  const { side, fromDave } = await twoSides(t, [
    reply("BRIEF", { ledger: [{ id: "i-01", state: "proposed" }] }),
    ...ours.map((body) => reply("COUNTER", { body, ledger: [{ id: "i-01", state: "proposed" }] })),
    reply("ACCEPT", { ledger: [{ id: "i-01", state: "agreed" }] }),
  ]);
  await side.openingTurn();
  let sawLooping = false;
  for (let i = 1; i <= 3; i++) {
    const p = fromDave(i, { act: "COUNTER", headline: `counter ${i}`, body: theirs[i - 1]!, ledger: [{ id: "i-01", state: "proposed" }] });
    if (side.observe(p).some((d) => d.kind === "looping")) sawLooping = true;
    await side.replyTo(p);
  }
  assert.ok(sawLooping, "looping should have fired while the ledger sat still");
  const done = fromDave(4, { act: "ACCEPT", headline: "ok", body: "agreed", ledger: [{ id: "i-01", state: "agreed" }] });
  const atClose = side.observe(done);
  await side.replyTo(done);
  assert.ok(!atClose.some((d) => d.kind === "looping"), "looping is quiet once nothing is open");
  const md = side.writeDecision(side.detections());
  assert.match(md, /_Nothing firing at the close\._/);
  assert.match(md, /During the run:\n- \*\*looping\*\* at turn \d+: the ledger has not changed/);
});

test("`say` with no id reaches the running conversation over the control socket", async (t) => {
  const home = tmp("ctl");
  Storage.open(home).putConvo({
    id: "11111111-1111-4111-8111-111111111111", peer: "d".repeat(32), mode: "decide", state: "live",
    createdAt: new Date().toISOString(), budget: { turns: 24, warnAt: 16, used: 0 }, brief: BRIEF,
  });
  const heard: Array<[string, string]> = [];
  const daemon = await startDaemon({
    home, idleTimeoutMs: 0,
    current: () => "11111111-1111-4111-8111-111111111111",
    onSay: (convo, text) => { heard.push([convo, text]); },
  });
  t.after(() => daemon.stop());
  const r = (await controlRequest(daemon.socketPath, daemon.token, "say", { text: "hold the line" })) as { convo: string };
  assert.equal(r.convo, "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(heard, [["11111111-1111-4111-8111-111111111111", "hold the line"]]);
});

test("`say` with nothing running is refused with a message that says so", async (t) => {
  const daemon = await startDaemon({ home: tmp("idle"), idleTimeoutMs: 0, current: () => null });
  t.after(() => daemon.stop());
  await assert.rejects(
    () => controlRequest(daemon.socketPath, daemon.token, "say", { text: "anyone there" }),
    /no conversation is running here/,
  );
});

test("watch lines carry the documented shape, and peer headlines arrive tagged", () => {
  const line = (event: Record<string, unknown>): string | null =>
    formatEvent(JSON.stringify({ t: "event", event }));
  assert.equal(
    line({ kind: "turn", at: "T", convo: "abcdefgh-rest", from: "you", act: "PROPOSE", headline: "h" }),
    "T | abcdefgh | you | PROPOSE | h",
  );
  assert.match(
    line({ kind: "turn", at: "T", convo: "c", from: "0123456789abcdef", act: "COUNTER", headline: "<seshi-peer from=\"0123456789abcdef\">x</seshi-peer>" }) ?? "",
    /\| 0123456789abcdef \| COUNTER \| <seshi-peer/,
  );
  assert.equal(line({ kind: "quiet", at: "T", convo: "c", because: "silence" }), "T | c | seshi | QUIET | silence");
  assert.equal(line({ kind: "say", at: "T", convo: "c", text: "go on" }), "T | c | you | HUMAN | go on");
  assert.equal(formatEvent(JSON.stringify({ id: 1, ok: true, result: { watching: true } })), null, "the ack is not an event");
  assert.equal(formatEvent("not json"), null);
});

test("a turn the service refuses as overloaded is retried, and the human is told", async (t) => {
  const notes: string[] = [];
  const { side, fromDave } = await twoSides(
    t,
    [
      reply("BRIEF"),
      "!ERROR API Error: 529 Overloaded. This is a server-side issue, usually temporary",
      reply("COUNTER"),
    ],
    { retryDelaysMs: [10, 10, 10], onNote: (l) => notes.push(l) },
  );
  await side.openingTurn();
  const p = fromDave(1, { act: "PROPOSE" });
  side.observe(p);
  const sent = await side.replyTo(p);
  assert.equal(sent.act, "COUNTER", "the retry's reply is what ships");
  assert.equal(notes.length, 1);
  assert.match(notes[0]!, /overloaded; trying again in 0s \(1 of 3\)/);
});

test("a turn that keeps failing as overloaded gives up after the delays run out", async (t) => {
  const boom = "!ERROR API Error: 529 Overloaded";
  const { side, fromDave } = await twoSides(t, [reply("BRIEF"), boom, boom, boom, boom], { retryDelaysMs: [5, 5] });
  await side.openingTurn();
  const p = fromDave(1, { act: "PROPOSE" });
  side.observe(p);
  await assert.rejects(() => side.replyTo(p), /529 Overloaded/);
});

test("an error that is not transient is not retried", async (t) => {
  const notes: string[] = [];
  const { side, fromDave } = await twoSides(t, [reply("BRIEF"), "!ERROR invalid_request: prompt too long", reply("COUNTER")], {
    retryDelaysMs: [5, 5, 5], onNote: (l) => notes.push(l),
  });
  await side.openingTurn();
  const p = fromDave(1, { act: "PROPOSE" });
  side.observe(p);
  await assert.rejects(() => side.replyTo(p), /prompt too long/);
  assert.equal(notes.length, 0);
});
