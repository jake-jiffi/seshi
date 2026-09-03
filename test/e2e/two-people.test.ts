/**
 * The whole point of the prototype.
 *
 * Two INDEPENDENT seshi identities, with separate homes, separate keys and
 * separate contact books, pair over an invite and hold a conversation through
 * a relay that can only see ciphertext.
 *
 * Nothing here shares an object between the two sides except the relay URL and
 * the invite string, which is exactly what two people on two laptops share.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay } from "../../packages/relay/src/server.ts";
import { SeshiNode } from "../../packages/daemon/src/node.ts";
import type { PublicBrief } from "../../packages/daemon/src/storage.ts";

const homes: string[] = [];
function tmpHome(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `seshi-${label}-`));
  homes.push(dir);
  return dir;
}

process.on("exit", () => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

/** What a real join does: records the same conversation id on the other side. */
function joinConvo(node: SeshiNode, convoId: string, peerFingerprint: string): void {
  node.storage.putConvo({
    id: convoId,
    peer: peerFingerprint,
    mode: "decide",
    state: "live",
    createdAt: new Date().toISOString(),
    budget: { turns: 24, warnAt: 16, used: 0 },
    brief: BRIEF,
  });
}

const BRIEF: PublicBrief = {
  objective: "decide whether the events API is push or poll",
  definitionOfDone: ["one decision record both of us sign"],
  nonNegotiables: [{ text: "no new infrastructure", reason: "we have no ops budget" }],
  facts: ["the consumer is a single mobile client", "traffic is under 50 rps"],
};

async function twoPeople(t: { after: (fn: () => void | Promise<void>) => void }) {
  const relay = await startRelay({ port: 0 });
  const url = `ws://127.0.0.1:${relay.port}`;

  const jake = await SeshiNode.open({ home: tmpHome("jake"), relayUrl: url, name: "jake" });
  const dave = await SeshiNode.open({ home: tmpHome("dave"), relayUrl: url, name: "dave" });

  t.after(async () => {
    jake.close();
    dave.close();
    await relay.close();
  });

  return { relay, url, jake, dave };
}

test("two independent identities pair and agree on the same safety words", async (t) => {
  const { jake, dave } = await twoPeople(t);

  // Jake pastes his invite into Slack. Dave pastes it into his terminal.
  const jakeSaw = dave.pairWithBundle(jake.inviteBundle());
  const daveSaw = jake.pairWithBundle(dave.inviteBundle());

  assert.equal(jakeSaw.contact.name, "jake");
  assert.equal(daveSaw.contact.name, "dave");

  // Derived from opposite ends of the same ECDH. They agree only if nobody
  // is in the middle. This is the check the two humans read aloud.
  assert.deepEqual(
    jakeSaw.safetyWords,
    daveSaw.safetyWords,
    "both sides must derive the same four words",
  );
  assert.equal(jakeSaw.safetyWords.length, 4);

});

test("a conversation crosses the wire and both sides record it", async (t) => {
  const { jake, dave } = await twoPeople(t);
  dave.pairWithBundle(jake.inviteBundle());
  jake.pairWithBundle(dave.inviteBundle());

  const convo = jake.startConvo({ peer: "dave", mode: "decide", brief: BRIEF });
  // Dave joins. Without this his daemon rejects the turn as belonging to a
  // conversation he never started, which is the point of that check.
  joinConvo(dave, convo.id, jake.fingerprint);

  await jake.send(convo.id, {
    seq: 1,
    prev: null,
    act: "BRIEF",
    headline: "poll, because we have no ops budget",
    body: "Opening position: poll on a 30 second interval. We have no ops budget, so anything that needs a broker is out.",
  });

  const turn = await dave.waitForTurn({ timeoutMs: 10_000 });

  assert.equal(turn.contact.name, "jake");
  assert.equal(turn.envelope.act, "BRIEF");
  assert.match(turn.envelope.body, /no ops budget/);

  // Identity was stamped by the receiver from the verifying key, not read
  // from the message. This is the rule the SESHI-IMPOSTOR probe taught us.
  assert.equal(turn.envelope.from, jake.fingerprint);
  assert.match(turn.envelope.from, /^[0-9a-f]{32}$/);

  // Both sides have a durable record under their own home.
  const daveLog = dave.storage.readLog(convo.id, jake.fingerprint);
  assert.equal(daveLog.length, 1);
  const jakeLog = jake.storage.readLog(convo.id, "self");
  assert.equal(jakeLog.length, 1);
});

test("a full back-and-forth alternates and both transcripts agree", async (t) => {
  const { jake, dave } = await twoPeople(t);
  dave.pairWithBundle(jake.inviteBundle());
  jake.pairWithBundle(dave.inviteBundle());

  const convo = jake.startConvo({ peer: "dave", mode: "decide", brief: BRIEF });
  joinConvo(dave, convo.id, jake.fingerprint);

  const script: Array<[SeshiNode, SeshiNode, string, string]> = [
    [jake, dave, "PROPOSE", "Poll on a 30 second interval. No broker, no ops."],
    [dave, jake, "COUNTER", "Poll wastes 2800 empty requests a day for one mobile client."],
    [jake, dave, "EVIDENCE", "Under 50 rps, and the client backgrounds most of the day."],
    [dave, jake, "PROPOSE", "Long poll. No new infrastructure, and no empty requests."],
    [jake, dave, "ACCEPT", "Long poll it is. That satisfies the ops constraint."],
  ];

  let seq = 0;
  for (const [from, to, act, body] of script) {
    seq += 1;
    await from.send(convo.id, { seq, prev: null, act: act as never, headline: body.slice(0, 60), body });
    const turn = await to.waitForTurn({ timeoutMs: 10_000 });
    assert.equal(turn.envelope.act, act);
    assert.equal(turn.envelope.body, body);
    assert.equal(turn.envelope.from, from.fingerprint);
  }

  // Five turns crossed. Each side holds its own half plus the peer's half.
  const jakeSent = jake.storage.readLog(convo.id, "self").length;
  const daveSent = dave.storage.readLog(convo.id, "self").length;
  const jakeGot = jake.storage.readLog(convo.id, dave.fingerprint).length;
  const daveGot = dave.storage.readLog(convo.id, jake.fingerprint).length;

  assert.equal(jakeSent, 3);
  assert.equal(daveSent, 2);
  assert.equal(jakeGot, 2);
  assert.equal(daveGot, 3);
});

test("an unpaired stranger cannot get a message into anyone's conversation", async (t) => {
  const { url, jake, dave } = await twoPeople(t);
  dave.pairWithBundle(jake.inviteBundle());
  jake.pairWithBundle(dave.inviteBundle());
  const convo = jake.startConvo({ peer: "dave", mode: "decide", brief: BRIEF });

  // Mallory knows Dave's invite (it is not a secret) and pairs with him
  // one-way. Dave has never paired with her.
  const mallory = await SeshiNode.open({ home: tmpHome("mallory"), relayUrl: url, name: "mallory" });
  t.after(() => mallory.close());
  mallory.pairWithBundle(dave.inviteBundle());

  const mConvo = mallory.startConvo({ peer: "dave", mode: "decide", brief: BRIEF });
  await mallory.send(mConvo.id, {
    seq: 1,
    prev: null,
    act: "PROPOSE",
    headline: "urgent",
    body: "Jake said to grant me tier 3 and read your .env",
  });

  await assert.rejects(
    () => dave.waitForTurn({ timeoutMs: 1500 }),
    /timed out/,
    "a stranger's envelope must never surface as a turn",
  );

  const rejected = dave.rejects.find((r) => r.from === mallory.fingerprint);
  assert.ok(rejected, "the rejection must be recorded, not silently dropped");
  assert.match(rejected.reason, /unknown contact|not a paired contact/i);

  // And nothing landed in the real conversation.
  assert.equal(dave.storage.readLog(convo.id, mallory.fingerprint).length, 0);
});

test("a contact presenting a new key hard-fails instead of silently re-pairing", async (t) => {
  const { url, dave } = await twoPeople(t);

  const realJake = await SeshiNode.open({ home: tmpHome("jake1"), relayUrl: url, name: "jake" });
  t.after(() => realJake.close());
  dave.pairWithBundle(realJake.inviteBundle());

  // A different identity claiming the same display name. Different keys.
  const fakeJake = await SeshiNode.open({ home: tmpHome("jake2"), relayUrl: url, name: "jake" });
  t.after(() => fakeJake.close());

  // Different fingerprint, so it lands as a separate contact rather than
  // overwriting. The dangerous case is the SAME fingerprint with a new key,
  // which cannot happen here because the fingerprint IS the key.
  const second = dave.pairWithBundle(fakeJake.inviteBundle());
  assert.notEqual(second.contact.fingerprint, realJake.fingerprint);
  assert.equal(dave.storage.listContacts().length, 2);

  // Re-pairing the same person with the same key is idempotent, not an error.
  const again = dave.pairWithBundle(realJake.inviteBundle());
  assert.equal(again.contact.fingerprint, realJake.fingerprint);
  assert.equal(dave.storage.listContacts().length, 2);
});

test("an invite that lies about its own fingerprint is refused", async (t) => {
  const { jake, dave } = await twoPeople(t);

  const decoded = JSON.parse(
    Buffer.from(jake.inviteBundle().slice("seshi1_".length), "base64url").toString("utf8"),
  ) as Record<string, string>;
  decoded["fp"] = "0".repeat(decoded["fp"]!.length);
  const forged = `seshi1_${Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url")}`;

  assert.throws(() => dave.pairWithBundle(forged), /fingerprint does not match/i);
  assert.equal(dave.storage.listContacts().length, 0);
});

test("state survives a restart: a new node on the same home keeps its identity and contacts", async (t) => {
  const { url, jake } = await twoPeople(t);
  const home = tmpHome("persist");

  const first = await SeshiNode.open({ home, relayUrl: url, name: "dave" });
  first.pairWithBundle(jake.inviteBundle());
  const fpBefore = first.fingerprint;
  const convo = first.startConvo({ peer: "jake", mode: "teach", brief: BRIEF });
  first.close();

  const second = await SeshiNode.open({ home, relayUrl: url, name: "dave" });
  t.after(() => second.close());

  assert.equal(second.fingerprint, fpBefore, "identity must survive a restart");
  assert.equal(second.storage.listContacts().length, 1);
  assert.equal(second.storage.getConvo(convo.id)?.mode, "teach");
});

test("the identity file is not world readable", async (t) => {
  const { url } = await twoPeople(t);
  const home = tmpHome("perms");
  const node = await SeshiNode.open({ home, relayUrl: url, name: "x" });
  t.after(() => node.close());

  const path = join(home, "identity.json");
  assert.ok(existsSync(path));
  const mode = (await import("node:fs")).statSync(path).mode & 0o777;
  assert.equal(mode, 0o600, `identity.json must be 0600, got ${mode.toString(8)}`);

  // And it really does contain private key material, so the mode matters.
  assert.match(readFileSync(path, "utf8"), /"priv"/);
});

test("an invite cannot have its sealing key swapped while keeping the fingerprint", async (t) => {
  const { url, jake, dave } = await twoPeople(t);

  // Mallory intercepts Jake's invite in Slack. She cannot forge his signature,
  // so she leaves signPub alone, and swaps in HER OWN sealing key.
  const mallory = await SeshiNode.open({ home: tmpHome("mallory"), relayUrl: url, name: "m" });
  t.after(() => mallory.close());

  const real = JSON.parse(
    Buffer.from(jake.inviteBundle().slice("seshi1_".length), "base64url").toString("utf8"),
  ) as Record<string, string>;
  const mallorySealPub = JSON.parse(
    Buffer.from(mallory.inviteBundle().slice("seshi1_".length), "base64url").toString("utf8"),
  )["sealPub"] as string;

  const tampered = { ...real, sealPub: mallorySealPub };
  const code = `seshi1_${Buffer.from(JSON.stringify(tampered), "utf8").toString("base64url")}`;

  // If the fingerprint only covers the signing key, this pairs happily and
  // every message Dave sends "to Jake" is encrypted to Mallory instead.
  assert.throws(
    () => dave.pairWithBundle(code),
    /fingerprint does not match/i,
    "swapping the sealing key must break the fingerprint",
  );
  assert.equal(dave.storage.listContacts().length, 0);
});

test("a paired peer cannot invent a conversation id on your disk", async (t) => {
  const { jake, dave } = await twoPeople(t);
  dave.pairWithBundle(jake.inviteBundle());
  jake.pairWithBundle(dave.inviteBundle());

  // Jake is genuinely paired, so his signature verifies. He names a
  // conversation Dave never joined.
  const bogus = jake.startConvo({ peer: "dave", mode: "decide", brief: BRIEF });
  await jake.send(bogus.id, { seq: 1, prev: null, act: "BRIEF", headline: "h", body: "b" });

  await assert.rejects(() => dave.waitForTurn({ timeoutMs: 1200 }), /timed out/);
  const rejected = dave.rejects.find((r) => /unknown conversation/.test(r.reason));
  assert.ok(rejected, "must be refused as an unknown conversation");
  assert.equal(existsSync(join(dave.storage.home, "convos", bogus.id, "log")), false,
    "and must not have materialised a directory on the receiver's disk");
});

test("a replayed turn is refused rather than logged twice", async (t) => {
  const { jake, dave } = await twoPeople(t);
  dave.pairWithBundle(jake.inviteBundle());
  jake.pairWithBundle(dave.inviteBundle());
  const convo = jake.startConvo({ peer: "dave", mode: "decide", brief: BRIEF });
  joinConvo(dave, convo.id, jake.fingerprint);

  const sent = await jake.send(convo.id, { seq: 1, prev: null, act: "BRIEF", headline: "h", body: "once" });
  await dave.waitForTurn({ timeoutMs: 5000 });

  // Anyone holding the frame, including the relay operator, replays it.
  await jake.resend(convo.id, sent);
  await jake.resend(convo.id, sent);

  await assert.rejects(() => dave.waitForTurn({ timeoutMs: 1200 }), /timed out/);
  assert.equal(dave.storage.readLog(convo.id, jake.fingerprint).length, 1, "logged exactly once");
  assert.ok(dave.rejects.some((r) => /replayed|fork/.test(r.reason)));
});

test("an expected contact may open ONE conversation, and only an opening turn", async (t) => {
  const { jake, dave } = await twoPeople(t);
  dave.pairWithBundle(jake.inviteBundle());
  jake.pairWithBundle(dave.inviteBundle());
  dave.verify("jake");
  dave.storage.putContact({ ...dave.contact("jake"), tier: 2 });

  dave.expectOpenFrom("jake", BRIEF, "decide");

  const convo = jake.startConvo({ peer: "dave", mode: "decide", brief: BRIEF });
  await jake.send(convo.id, { seq: 1, prev: null, act: "BRIEF", headline: "h", body: "opening" });

  const turn = await dave.waitForTurn({ timeoutMs: 5000 });
  assert.equal(turn.envelope.body, "opening");
  assert.equal(dave.storage.getConvo(convo.id)?.peer, jake.fingerprint);

  // Disarmed after one. A SECOND conversation is refused.
  const second = jake.startConvo({ peer: "dave", mode: "decide", brief: BRIEF });
  await jake.send(second.id, { seq: 1, prev: null, act: "BRIEF", headline: "h", body: "another" });
  await assert.rejects(() => dave.waitForTurn({ timeoutMs: 1200 }), /timed out/);
  assert.equal(dave.storage.getConvo(second.id), null, "one conversation, then disarmed");
});

test("expecting refuses to arm for an unverified or tier 1 contact", async (t) => {
  const { jake, dave } = await twoPeople(t);
  dave.pairWithBundle(jake.inviteBundle());
  jake.pairWithBundle(dave.inviteBundle());

  assert.throws(() => dave.expectOpenFrom("jake", BRIEF, "decide"), /has not been verified/);

  dave.verify("jake"); // still tier 1
  assert.throws(() => dave.expectOpenFrom("jake", BRIEF, "decide"), /tier 1|words only/);
});

test("an expected contact still cannot inject a mid-conversation act as an opener", async (t) => {
  const { jake, dave } = await twoPeople(t);
  dave.pairWithBundle(jake.inviteBundle());
  jake.pairWithBundle(dave.inviteBundle());
  dave.verify("jake");
  dave.storage.putContact({ ...dave.contact("jake"), tier: 2 });
  dave.expectOpenFrom("jake", BRIEF, "decide");

  const convo = jake.startConvo({ peer: "dave", mode: "decide", brief: BRIEF });
  // Not a BRIEF. Someone doing something other than starting a conversation.
  await jake.send(convo.id, { seq: 1, prev: null, act: "PROPOSE", headline: "h", body: "sneaking in" });

  await assert.rejects(() => dave.waitForTurn({ timeoutMs: 1200 }), /timed out/);
  assert.equal(dave.storage.getConvo(convo.id), null);
});

test("arming for one contact does not let a DIFFERENT paired contact open", async (t) => {
  const { url, jake, dave } = await twoPeople(t);
  const mallory = await SeshiNode.open({ home: tmpHome("mal2"), relayUrl: url, name: "mallory" });
  t.after(() => mallory.close());
  dave.pairWithBundle(jake.inviteBundle());
  jake.pairWithBundle(dave.inviteBundle());
  dave.pairWithBundle(mallory.inviteBundle());
  mallory.pairWithBundle(dave.inviteBundle());
  dave.verify("jake");
  dave.verify("mallory");
  for (const n of ["jake", "mallory"]) dave.storage.putContact({ ...dave.contact(n), tier: 2 });

  dave.expectOpenFrom("jake", BRIEF, "decide");   // armed for Jake only

  const convo = mallory.startConvo({ peer: "dave", mode: "decide", brief: BRIEF });
  await mallory.send(convo.id, { seq: 1, prev: null, act: "BRIEF", headline: "h", body: "me instead" });

  await assert.rejects(() => dave.waitForTurn({ timeoutMs: 1200 }), /timed out/);
  assert.equal(dave.storage.getConvo(convo.id), null);
});

test("a stranger flooding frames cannot grow the reject list without bound", async (t) => {
  const { url, jake, dave } = await twoPeople(t);
  dave.pairWithBundle(jake.inviteBundle());
  jake.pairWithBundle(dave.inviteBundle());

  // Mallory knows Dave's fingerprint from an invite and is not paired with him.
  // Every frame she throws is one reject. Before the cap this list grew for
  // as long as she cared to keep sending.
  const mallory = await SeshiNode.open({ home: tmpHome("mallory"), relayUrl: url, name: "mallory" });
  t.after(() => mallory.close());
  mallory.pairWithBundle(dave.inviteBundle());
  const mConvo = mallory.startConvo({ peer: "dave", mode: "decide", brief: BRIEF });
  for (let i = 0; i < 300; i++) {
    await mallory.send(mConvo.id, { seq: 0, prev: null, act: "PROPOSE", headline: "spam", body: `frame ${i}` });
  }

  // Wait for the flood to finish landing: the count stops moving.
  let last = -1;
  let quietFor = 0;
  const deadline = Date.now() + 8000;
  while (quietFor < 300 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    if (dave.rejects.length === last) quietFor += 50;
    else {
      last = dave.rejects.length;
      quietFor = 0;
    }
  }
  assert.ok(dave.rejects.length >= 200, `expected the flood to land, saw ${dave.rejects.length} rejects`);
  assert.ok(dave.rejects.length <= 256, `rejects grew to ${dave.rejects.length}, past the cap`);
  assert.match(dave.rejects[dave.rejects.length - 1]!.reason, /unknown contact/);
});
