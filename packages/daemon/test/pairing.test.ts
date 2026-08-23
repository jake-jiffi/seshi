/**
 * Pairing by spoken code, end to end.
 *
 * Two nodes with separate homes, separate keys and separate contact books
 * share nothing but a relay URL and three words. Everything an attacker can do
 * with those three words is here too, because a pairing code is the one secret
 * seshi asks a human to carry.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay } from "@seshi/relay/server";
import { mailboxIds } from "@seshi/core/pairing";
import { SeshiNode } from "../src/node.ts";
import { mailboxPut, mailboxTake } from "../src/mailbox.ts";

const homes: string[] = [];
function tmpHome(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `seshi-pair-${label}-`));
  homes.push(dir);
  return dir;
}
process.on("exit", () => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

/** Fast enough that a test does not sit through the real 2 second poll. */
const QUICK = { pollMs: 20, timeoutMs: 10_000 };

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

const encode = (bundle: string): string => Buffer.from(bundle, "utf8").toString("base64");

/** Rebuild an invite bundle with one field changed, the way a relay operator
 *  or anyone else holding the mailbox id could. */
function tamper(bundle: string, edit: (b: Record<string, unknown>) => void): string {
  const json = JSON.parse(
    Buffer.from(bundle.slice("seshi1_".length), "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  edit(json);
  return `seshi1_${Buffer.from(JSON.stringify(json), "utf8").toString("base64url")}`;
}

test("two people pair with nothing but a spoken code", async (t) => {
  const { jake, dave } = await twoPeople(t);

  // Jake reads three words down the phone. Dave types them in.
  const invite = await jake.invite("dave");
  assert.match(invite.code, /^[1-9]-[a-z]+-[a-z]+$/);

  const waiting = invite.waitForPeer(QUICK);
  const daveSide = await dave.joinWithCode(invite.code);
  const jakeSide = await waiting;

  assert.equal(jakeSide.contact.fingerprint, dave.fingerprint);
  assert.equal(daveSide.contact.fingerprint, jake.fingerprint);

  // The four words are derived from opposite ends of the same ECDH. They agree
  // only if nobody sat in the middle, and they are the only thing that says so.
  assert.equal(jakeSide.safetyWords.length, 4);
  assert.deepEqual(jakeSide.safetyWords, daveSide.safetyWords);

  // Jake's local label wins over what Dave's bundle says about itself, and the
  // self-asserted name is still handed back so a human can see the two agree.
  assert.equal(jakeSide.contact.name, "dave");
  assert.equal(jakeSide.claimedName, "dave");
  assert.equal(daveSide.contact.name, "jake");
  assert.equal(daveSide.claimedName, "jake");

  // Both sides really wrote a contact, so a restart still knows the peer.
  assert.equal(jake.storage.getContact(dave.fingerprint)?.tier, 1);
  assert.equal(dave.storage.getContact(jake.fingerprint)?.tier, 1);
});

test("a code read aloud badly still works", async (t) => {
  const { jake, dave } = await twoPeople(t);
  const invite = await jake.invite();
  const waiting = invite.waitForPeer(QUICK);

  const spoken = `  ${invite.code.toUpperCase().replace(/-/g, " ")}  `;
  const daveSide = await dave.joinWithCode(spoken);
  const jakeSide = await waiting;
  assert.deepEqual(jakeSide.safetyWords, daveSide.safetyWords);

  // Without a local label the contact takes the name out of the bundle, which
  // is self-asserted and therefore only ever a label.
  assert.equal(jakeSide.contact.name, "dave");
});

test("a wrong code finds nothing and pairs nobody", async (t) => {
  const { jake, dave } = await twoPeople(t);
  const invite = await jake.invite();

  const wrong = invite.code.startsWith("1-") ? `2-${invite.code.slice(2)}` : `1-${invite.code.slice(2)}`;
  await assert.rejects(dave.joinWithCode(wrong), /no invite is waiting/);
  assert.deepEqual(dave.storage.listContacts(), []);
  assert.deepEqual(jake.storage.listContacts(), []);

  // And the wrong guess did not disturb the real invite.
  const waiting = invite.waitForPeer(QUICK);
  await dave.joinWithCode(invite.code);
  await waiting;
  assert.equal(dave.storage.listContacts().length, 1);
});

test("a code can only be claimed once, so a thief is loud", async (t) => {
  const { jake, dave, url } = await twoPeople(t);
  const mallory = await SeshiNode.open({ home: tmpHome("mallory"), relayUrl: url, name: "mallory" });
  t.after(() => mallory.close());

  const invite = await jake.invite();

  // Mallory read the code over Jake's shoulder and got there first.
  const stolen = await mallory.joinWithCode(invite.code);
  assert.equal(stolen.contact.fingerprint, jake.fingerprint);

  // Dave, the real invitee, does not quietly succeed alongside her. He fails,
  // and the message tells him to treat it as an attack.
  await assert.rejects(dave.joinWithCode(invite.code), /treat this as an attack/);
  assert.deepEqual(dave.storage.listContacts(), []);
});

test("an answer that is already there stops the join before it commits", async (t) => {
  const { jake, dave, url } = await twoPeople(t);
  const invite = await jake.invite("dave");
  const box = mailboxIds(invite.code);

  // Mallory cannot overwrite Jake's offer, but she knows the code, so she can
  // occupy the answer mailbox and be the one Jake pairs with.
  const mallory = await SeshiNode.open({ home: tmpHome("mallory"), relayUrl: url, name: "mallory" });
  t.after(() => mallory.close());
  await mailboxPut(url, box.answer, encode(mallory.inviteBundle()));

  await assert.rejects(dave.joinWithCode(invite.code), /already answered this code.*attack/s);
  // Dave committed nothing. His half of the pairing never happened, which is
  // the visible failure the spec asks for.
  assert.deepEqual(dave.storage.listContacts(), []);

  // And this is the honest cost: Jake pairs with Mallory, under the name Jake
  // meant for Dave. Two things catch it. The name she asserts is not the name
  // on the contact, and Dave has no pairing at all, so when Jake reads his four
  // words down the phone there is nobody to read them back.
  const jakeSide = await invite.waitForPeer(QUICK);
  assert.equal(jakeSide.contact.fingerprint, mallory.fingerprint);
  assert.equal(jakeSide.contact.name, "dave");
  assert.equal(jakeSide.claimedName, "mallory");
  assert.equal(dave.storage.getContact(jake.fingerprint), null);
});

test("a tampered bundle in the mailbox is refused by the fingerprint check", async (t) => {
  const { jake, dave, url } = await twoPeople(t);

  // A mailbox is untrusted transport, exactly like the relay. Whoever holds
  // the id can write into it, so what comes out gets the same check a pasted
  // blob gets: the fingerprint must be the hash of the keys beside it.
  const code = "4-tandem-verdict";
  const forged = tamper(jake.inviteBundle(), (b) => {
    const signPub = String(b["signPub"]);
    b["signPub"] = signPub.slice(0, 63) + (signPub.endsWith("0") ? "1" : "0");
  });
  await mailboxPut(url, mailboxIds(code).offer, encode(forged));

  await assert.rejects(dave.joinWithCode(code), /fingerprint does not match/);
  assert.deepEqual(dave.storage.listContacts(), []);
  // The join stopped before posting Dave's own bundle, so a garbage offer
  // costs him nothing at all.
  assert.equal(await mailboxTake(url, mailboxIds(code).answer), null);
});

test("garbage in the mailbox is refused as loudly as a forgery", async (t) => {
  const { dave, url } = await twoPeople(t);
  const code = "5-tandem-verdict";
  await mailboxPut(url, mailboxIds(code).offer, encode("just some text"));
  await assert.rejects(dave.joinWithCode(code), /not a seshi invite/);
  assert.deepEqual(dave.storage.listContacts(), []);
});

test("joining your own code is refused before anything is written", async (t) => {
  const { jake, url } = await twoPeople(t);
  const invite = await jake.invite();
  await assert.rejects(jake.joinWithCode(invite.code), /your own invite/);
  assert.equal(await mailboxTake(url, mailboxIds(invite.code).answer), null);
});

test("giving up on an invite spends the code, so a leak cannot be used later", async (t) => {
  const { jake, dave } = await twoPeople(t);
  const invite = await jake.invite();

  await assert.rejects(
    invite.waitForPeer({ pollMs: 5, timeoutMs: 60 }),
    /nobody joined with that code/,
  );

  // The code turns up in Slack scrollback an hour later. It is already dead.
  await assert.rejects(dave.joinWithCode(invite.code), /no invite is waiting/);
});

test("the pasted bundle path still pairs, unchanged", async (t) => {
  const { jake, dave } = await twoPeople(t);
  const jakeSide = jake.pairWithBundle(dave.inviteBundle());
  const daveSide = dave.pairWithBundle(jake.inviteBundle());
  assert.deepEqual(jakeSide.safetyWords, daveSide.safetyWords);
  assert.equal(jakeSide.contact.name, "dave");
});

test("a relay that is not there fails fast rather than hanging or half-pairing", async () => {
  // A port that was listening a moment ago and is not any more. The connection
  // never opens, so the request provably never arrived and the client is free
  // to retry it. What it must not do is hang, or decide the mailbox was empty.
  const relay = await startRelay({ port: 0 });
  const url = `ws://127.0.0.1:${relay.port}`;
  await relay.close();

  const started = Date.now();
  await assert.rejects(mailboxPut(url, "a".repeat(64), "aGk="), /could not reach the relay/);
  await assert.rejects(mailboxTake(url, "a".repeat(64)), /could not reach the relay/);
  // Two ops, three attempts each. The number that matters is that it is nowhere
  // near the 10 second per-attempt timeout, i.e. it refused rather than waited.
  assert.ok(Date.now() - started < 8_000, "an unreachable relay should fail fast");
});
