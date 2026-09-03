/**
 * Smoke test against a live relay: the whole handshake, then a ping.
 *
 *   node test/smoke/relay-smoke.ts wss://relay.seshi.sh
 *
 * Fresh identity, so it proves the relay is up, greets with a challenge,
 * accepts a signed hello, derives the fingerprint the way core does, and
 * answers a ping. Exits non-zero on any other outcome, including silence.
 * Not part of `npm test`: it needs the internet.
 */

import { fingerprint, generateIdentity, signBytes } from "../../packages/core/src/identity.ts";

const url = process.argv[2] ?? "wss://relay.seshi.sh";
const id = generateIdentity();
const expectFp = fingerprint(id.sign.pub, id.seal.pub);
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

const fail = (why: string): never => {
  console.error(`${url}: ${why}`);
  process.exit(1);
};
const timer = setTimeout(() => fail("no answer within 15s"), 15_000);

const ws = new WebSocket(url);
let stage: "challenge" | "welcome" | "pong" = "challenge";
ws.onerror = () => fail("could not connect");
ws.onmessage = (event) => {
  const m = JSON.parse(String(event.data)) as Record<string, unknown>;
  if (stage === "challenge") {
    if (m["t"] !== "challenge" || typeof m["nonce"] !== "string") return fail(`expected a challenge, got ${String(event.data)}`);
    const sig = signBytes(
      Buffer.concat([Buffer.from("seshi-hello-v1", "utf8"), Buffer.from(m["nonce"], "hex")]),
      id.sign.priv,
    );
    ws.send(JSON.stringify({ t: "hello", signPub: hex(id.sign.pub), sealPub: hex(id.seal.pub), sig: hex(sig) }));
    stage = "welcome";
    return;
  }
  if (stage === "welcome") {
    if (m["t"] !== "welcome") return fail(`hello refused: ${String(event.data)}`);
    if (m["fp"] !== expectFp) return fail(`relay derived ${String(m["fp"])}, core derived ${expectFp}`);
    ws.send(JSON.stringify({ t: "ping" }));
    stage = "pong";
    return;
  }
  if (m["t"] !== "pong") return fail(`expected pong, got ${String(event.data)}`);
  clearTimeout(timer);
  console.log(`${url}: challenge, signed hello, welcome, pong: ok`);
  ws.close();
};
