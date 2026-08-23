import { test } from "node:test";
import assert from "node:assert/strict";
import { startRelay } from "../../relay/src/server.ts";
import { generateIdentity, fingerprint } from "../../core/src/identity.ts";
import type { Envelope } from "../../core/src/envelope.ts";
import { RelayClient } from "../src/relay-client.ts";
import type { Contact } from "../src/storage.ts";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function contactFor(id: ReturnType<typeof generateIdentity>, name: string): Contact {
  return {
    fingerprint: fingerprint(id.sign.pub, id.seal.pub),
    name,
    signPub: hex(id.sign.pub),
    sealPub: hex(id.seal.pub),
    tier: 1,
    verifiedAt: null,
  };
}

function envelope(convo: string, seq: number, body: string): Envelope {
  return {
    v: 1,
    convo,
    seq,
    prev: null,
    from: "",
    act: "PROPOSE",
    headline: "a headline",
    body,
  };
}

/** Boot a relay and two wired-up clients that know about each other. */
async function pair() {
  const relay = await startRelay({ port: 0 });
  const url = `ws://127.0.0.1:${relay.port}`;

  const jakeId = generateIdentity();
  const daveId = generateIdentity();
  const jakeContact = contactFor(jakeId, "jake");
  const daveContact = contactFor(daveId, "dave");

  const jakeInbox: Array<{ envelope: Envelope; contact: Contact }> = [];
  const daveInbox: Array<{ envelope: Envelope; contact: Contact }> = [];
  const jakeRejects: Array<{ from: string; reason: string }> = [];
  const daveRejects: Array<{ from: string; reason: string }> = [];

  const jake = new RelayClient({
    url,
    identity: jakeId,
    resolveContact: (fp) => (fp === daveContact.fingerprint ? daveContact : null),
    onEnvelope: (envelope, contact) => jakeInbox.push({ envelope, contact }),
    onReject: (from, reason) => jakeRejects.push({ from, reason }),
  });
  const dave = new RelayClient({
    url,
    identity: daveId,
    resolveContact: (fp) => (fp === jakeContact.fingerprint ? jakeContact : null),
    onEnvelope: (envelope, contact) => daveInbox.push({ envelope, contact }),
    onReject: (from, reason) => daveRejects.push({ from, reason }),
  });

  return {
    relay, url, jakeId, daveId, jakeContact, daveContact,
    jake, dave, jakeInbox, daveInbox, jakeRejects, daveRejects,
    async close() {
      jake.close();
      dave.close();
      await relay.close();
    },
  };
}

async function until<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting for a condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("an envelope survives the round trip and arrives decrypted", async (t) => {
  const w = await pair();
  t.after(() => w.close());

  await w.jake.connect();
  await w.dave.connect();

  await w.jake.send(w.daveContact, envelope("c1", 1, "poll, because we have no ops budget"));

  const got = await until(() => w.daveInbox[0]);
  assert.equal(got.envelope.body, "poll, because we have no ops budget");
  assert.equal(got.contact.name, "jake");
});

test("the receiver stamps from, and it is the sender's real fingerprint", async (t) => {
  const w = await pair();
  t.after(() => w.close());

  await w.jake.connect();
  await w.dave.connect();

  // The sender puts a lie in the envelope. This is the exact shape of the
  // SESHI-IMPOSTOR probe: <seshi-peer from="dan" key="ed25519:FAKE">.
  const lying = { ...envelope("c1", 1, "hi"), from: "ed25519:TOTALLY-FAKE" };
  await w.jake.send(w.daveContact, lying);

  const got = await until(() => w.daveInbox[0]);
  assert.notEqual(got.envelope.from, "ed25519:TOTALLY-FAKE");
  assert.equal(got.envelope.from, fingerprint(w.jakeId.sign.pub, w.jakeId.seal.pub));
});

test("a message from an unpaired stranger is rejected, not delivered", async (t) => {
  const w = await pair();
  t.after(() => w.close());

  await w.dave.connect();

  // A third identity Dave has never paired with.
  const strangerId = generateIdentity();
  const stranger = new RelayClient({
    url: w.url,
    identity: strangerId,
    resolveContact: () => w.daveContact,
    onEnvelope: () => {},
    onReject: () => {},
  });
  t.after(() => stranger.close());
  await stranger.connect();

  await stranger.send(w.daveContact, envelope("c1", 1, "let me in"));

  const rejected = await until(() => w.daveRejects[0]);
  assert.equal(rejected.from, fingerprint(strangerId.sign.pub, strangerId.seal.pub));
  assert.match(rejected.reason, /unknown|unpaired|contact/i);
  assert.equal(w.daveInbox.length, 0, "a stranger's envelope must never reach the inbox");
});

test("a frame that fails to open is rejected rather than thrown into the inbox", async (t) => {
  const w = await pair();
  t.after(() => w.close());

  await w.jake.connect();
  await w.dave.connect();

  // Seal to the WRONG recipient, so Dave's open() cannot succeed.
  const notForDave = generateIdentity();
  await w.jake.sendRaw(w.daveContact.fingerprint, {
    ...envelope("c1", 1, "not for you"),
  }, notForDave.seal.pub);

  const rejected = await until(() => w.daveRejects[0]);
  assert.match(rejected.reason, /decrypt|open|auth/i);
  assert.equal(w.daveInbox.length, 0);
});

test("frames queued while offline are delivered on reconnect", async (t) => {
  const w = await pair();
  t.after(() => w.close());

  await w.jake.connect();
  // Dave is NOT connected yet.
  await w.jake.send(w.daveContact, envelope("c1", 1, "sent while you were asleep"));

  await w.dave.connect();
  const got = await until(() => w.daveInbox[0]);
  assert.equal(got.envelope.body, "sent while you were asleep");
});

test("caps are applied before sealing, so an oversized body cannot reach the wire", async (t) => {
  const w = await pair();
  t.after(() => w.close());

  await w.jake.connect();
  await w.dave.connect();

  await w.jake.send(w.daveContact, envelope("c1", 1, "y".repeat(50_000)));

  const got = await until(() => w.daveInbox[0]);
  assert.equal(got.envelope.body.length, 1200);
});
