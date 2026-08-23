/**
 * The mailbox must not be enumerable.
 *
 * Measured before this existed: 1,172 take attempts per second on a single
 * connection, against a 25.2-bit code space, is a full sweep in 8.9 hours. With
 * a 24 hour TTL that is every live pairing code guessed nearly three times over.
 *
 * Single-claim caps an attacker at one guess per CODE. It does nothing about
 * guessing which codes exist, which is the actual attack.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startRelay } from "../src/server.ts";

async function connect(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  return ws;
}

const id = (n: number): string => n.toString(16).padStart(64, "0");

test("a connection guessing mailboxes is cut off long before it can enumerate", async (t) => {
  const relay = await startRelay({ port: 0 });
  t.after(() => relay.close());

  const ws = await connect(relay.port);
  const seen: string[] = [];
  let closed = false;
  ws.addEventListener("message", (e) => seen.push(String(e.data)));
  ws.addEventListener("close", () => { closed = true; });

  for (let i = 0; i < 200; i += 1) ws.send(JSON.stringify({ t: "mbox_take", id: id(i) }));
  await new Promise((r) => setTimeout(r, 800));

  assert.ok(closed, "a connection that misses repeatedly must be closed, not served forever");
  const answered = seen.filter((m) => m.includes("mbox_empty")).length;
  assert.ok(answered < 100, `served ${answered} misses before cutting off; that is still enumerable`);
  assert.ok(
    seen.some((m) => /too many|rate|slow down/i.test(m)),
    `the client must be told why it was cut off, got: ${seen.slice(-2).join(" ")}`,
  );
});

test("a legitimate joiner is never affected: one take, one hit", async (t) => {
  const relay = await startRelay({ port: 0 });
  t.after(() => relay.close());

  const putter = await connect(relay.port);
  putter.send(JSON.stringify({ t: "mbox_put", id: id(42), data: Buffer.from("bundle").toString("base64") }));
  await new Promise((r) => setTimeout(r, 150));

  const taker = await connect(relay.port);
  const got: string[] = [];
  taker.addEventListener("message", (e) => got.push(String(e.data)));
  taker.send(JSON.stringify({ t: "mbox_take", id: id(42) }));
  await new Promise((r) => setTimeout(r, 250));

  assert.ok(got.some((m) => m.includes("mbox_data")), `the real joiner must be served: ${got.join(" ")}`);
  putter.close();
  taker.close();
});

test("the TTL is short enough that a code is not live for a whole day", async () => {
  // The invite flow waits ten minutes. A mailbox living for twenty-four hours
  // is 96x more exposure than the product actually uses.
  const { MBOX_TTL_MS } = await import("../src/server.ts");
  assert.ok(
    MBOX_TTL_MS <= 30 * 60_000,
    `a pairing mailbox should live minutes, not ${(MBOX_TTL_MS / 3600_000).toFixed(1)} hours`,
  );
});
