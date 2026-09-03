import { test } from "node:test";
import assert from "node:assert/strict";
import { startRelay } from "../../relay/src/server.ts";
import { generateIdentity, fingerprint, signBytes } from "../../core/src/identity.ts";
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

test("a send during a dropped socket waits for the reconnect instead of failing", async (t) => {
  const relay = await startRelay({ port: 0 });
  const url = `ws://127.0.0.1:${relay.port}`;
  const jakeId = generateIdentity();
  const daveId = generateIdentity();
  const jakeContact = contactFor(jakeId, "jake");
  const daveContact = contactFor(daveId, "dave");
  const daveInbox: Array<{ envelope: Envelope; contact: Contact }> = [];
  const jake = new RelayClient({
    url,
    identity: jakeId,
    reconnectMs: 50,
    resolveContact: (fp) => (fp === daveContact.fingerprint ? daveContact : null),
    onEnvelope: () => {},
  });
  const dave = new RelayClient({
    url,
    identity: daveId,
    resolveContact: (fp) => (fp === jakeContact.fingerprint ? jakeContact : null),
    onEnvelope: (envelope, contact) => daveInbox.push({ envelope, contact }),
  });
  t.after(async () => {
    jake.close();
    dave.close();
    await relay.close();
  });
  await jake.connect();
  await dave.connect();

  // Knock jake off the relay the way an idle proxy would, using the relay's
  // own rule that a fresh hello for a fingerprint closes the previous socket.
  // The hello has to be signed with jake's key now, which is the point of the
  // handshake: only jake can do this to jake.
  const squatter = new WebSocket(url);
  const challenge = await new Promise<string>((r) =>
    squatter.addEventListener("message", (ev) => {
      const m = JSON.parse(String(ev.data)) as { t: string; nonce?: string };
      if (m.t === "challenge") r(m.nonce ?? "");
    }),
  );
  const sig = signBytes(
    Buffer.concat([Buffer.from("seshi-hello-v1", "utf8"), Buffer.from(challenge, "hex")]),
    jakeId.sign.priv,
  );
  squatter.send(
    JSON.stringify({
      t: "hello",
      signPub: hex(jakeId.sign.pub),
      sealPub: hex(jakeId.seal.pub),
      sig: hex(sig),
    }),
  );
  await until(() => (jake.connected ? undefined : true));
  squatter.close();

  // Sent inside the gap, before the reconnect timer has fired.
  await jake.send(daveContact, envelope("c1", 1, "sent in the gap"));
  const got = await until(() => daveInbox[0]);
  assert.equal(got.envelope.body, "sent in the gap");
});

test("the client pings while idle, so a proxy never sees an idle socket", async (t) => {
  const { WebSocketServer } = await import("ws");
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once("listening", r));
  let pings = 0;
  wss.on("connection", (s) => {
    // Enough of the relay's handshake for the client to consider itself
    // registered, which is the only state it pings from.
    s.send(JSON.stringify({ t: "challenge", nonce: "00".repeat(32) }));
    s.on("message", (d) => {
      const t = (JSON.parse(String(d)) as { t?: string }).t;
      if (t === "hello") s.send(JSON.stringify({ t: "welcome", fp: "0".repeat(32) }));
      if (t === "ping") pings += 1;
    });
  });
  const port = (wss.address() as { port: number }).port;
  const c = new RelayClient({
    url: `ws://127.0.0.1:${port}`,
    identity: generateIdentity(),
    keepaliveMs: 20,
    resolveContact: () => null,
    onEnvelope: () => {},
  });
  t.after(() => {
    c.close();
    wss.close();
  });
  await c.connect();
  await until(() => (pings >= 3 ? pings : undefined));
});

test("a daemon that throws while filing a turn produces a reject, not a crash", async (t) => {
  const w = await pair();
  t.after(() => w.close());
  const boom = new RelayClient({
    url: w.url,
    identity: w.daveId,
    resolveContact: (fp) => (fp === w.jakeContact.fingerprint ? w.jakeContact : null),
    onEnvelope: () => {
      throw new Error("corrupt record in log");
    },
    onReject: (from, reason) => w.daveRejects.push({ from, reason }),
  });
  t.after(() => boom.close());
  await w.jake.connect();
  await boom.connect();
  await w.jake.send(w.daveContact, envelope("c1", 1, "hello"));
  const r = await until(() => w.daveRejects[0]);
  assert.match(r.reason, /could not file the turn: corrupt record/);
});
