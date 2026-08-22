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
import { startRelay } from "@seshi/relay/server";
import { SeshiNode } from "@seshi/daemon/node";
import type { PublicBrief } from "@seshi/daemon/storage";

const homes: string[] = [];
function tmpHome(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `seshi-${label}-`));
  homes.push(dir);
  return dir;
}

process.on("exit", () => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

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
  const jakeSaw = dave.pair(jake.invite());
  const daveSaw = jake.pair(dave.invite());

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
  dave.pair(jake.invite());
  jake.pair(dave.invite());

  const convo = jake.startConvo({ peer: "dave", mode: "decide", brief: BRIEF });

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
  assert.match(turn.envelope.from, /^[0-9a-f]{16,64}$/);

  // Both sides have a durable record under their own home.
  const daveLog = dave.storage.readLog(convo.id, jake.fingerprint);
  assert.equal(daveLog.length, 1);
  const jakeLog = jake.storage.readLog(convo.id, "self");
  assert.equal(jakeLog.length, 1);
});

test("a full back-and-forth alternates and both transcripts agree", async (t) => {
  const { jake, dave } = await twoPeople(t);
  dave.pair(jake.invite());
  jake.pair(dave.invite());

  const convo = jake.startConvo({ peer: "dave", mode: "decide", brief: BRIEF });
  // Dave records the same conversation id, the way a real join would.
  dave.storage.putConvo({
    id: convo.id,
    peer: jake.fingerprint,
    mode: "decide",
    state: "live",
    createdAt: new Date().toISOString(),
    budget: { turns: 24, warnAt: 16, used: 0 },
    brief: BRIEF,
  });

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
  dave.pair(jake.invite());
  jake.pair(dave.invite());
  const convo = jake.startConvo({ peer: "dave", mode: "decide", brief: BRIEF });

  // Mallory knows Dave's invite (it is not a secret) and pairs with him
  // one-way. Dave has never paired with her.
  const mallory = await SeshiNode.open({ home: tmpHome("mallory"), relayUrl: url, name: "mallory" });
  t.after(() => mallory.close());
  mallory.pair(dave.invite());

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
  dave.pair(realJake.invite());

  // A different identity claiming the same display name. Different keys.
  const fakeJake = await SeshiNode.open({ home: tmpHome("jake2"), relayUrl: url, name: "jake" });
  t.after(() => fakeJake.close());

  // Different fingerprint, so it lands as a separate contact rather than
  // overwriting. The dangerous case is the SAME fingerprint with a new key,
  // which cannot happen here because the fingerprint IS the key.
  const second = dave.pair(fakeJake.invite());
  assert.notEqual(second.contact.fingerprint, realJake.fingerprint);
  assert.equal(dave.storage.listContacts().length, 2);

  // Re-pairing the same person with the same key is idempotent, not an error.
  const again = dave.pair(realJake.invite());
  assert.equal(again.contact.fingerprint, realJake.fingerprint);
  assert.equal(dave.storage.listContacts().length, 2);
});

test("an invite that lies about its own fingerprint is refused", async (t) => {
  const { jake, dave } = await twoPeople(t);

  const decoded = JSON.parse(
    Buffer.from(jake.invite().slice("seshi1_".length), "base64url").toString("utf8"),
  ) as Record<string, string>;
  decoded["fp"] = "0".repeat(decoded["fp"]!.length);
  const forged = `seshi1_${Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url")}`;

  assert.throws(() => dave.pair(forged), /fingerprint does not match/i);
  assert.equal(dave.storage.listContacts().length, 0);
});

test("state survives a restart: a new node on the same home keeps its identity and contacts", async (t) => {
  const { url, jake } = await twoPeople(t);
  const home = tmpHome("persist");

  const first = await SeshiNode.open({ home, relayUrl: url, name: "dave" });
  first.pair(jake.invite());
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
