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
    if (!init) { init = true; process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "fake", apiKeySource: "none", claude_code_version: "fake" }) + "\\n"); }
    const replies = JSON.parse(fs.readFileSync(${JSON.stringify(queue)}, "utf8"));
    const text = turn === 0 ? "READY" : (replies[turn - 1] ?? replies[replies.length - 1]);
    turn += 1;
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
    node: jake, convo, peer: jake.contact("dave"),
    scopedDir: jake.storage.convoDir(convo.id), tier: 2,
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

const reply = (act: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ act, headline: `${act} headline`, body: `${act} body`, ...extra });

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
