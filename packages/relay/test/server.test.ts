import { test } from "node:test";
import assert from "node:assert/strict";
import { MBOX_TTL_MS, startRelay } from "../src/server.ts";

const FP_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FP_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const FP_C = "cccccccccccccccccccccccccccccccc";

const MAX_FRAME = 256 * 1024;

type Msg = Record<string, unknown>;

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A minimal relay client built on Node's built-in WebSocket, so the tests
 *  exercise the wire protocol rather than the server's own helpers. */
class Client {
  readonly ws: WebSocket;
  private readonly inbox: Msg[] = [];
  private readonly waiters: Array<(m: Msg) => void> = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(String(ev.data)) as Msg;
      const waiter = this.waiters.shift();
      if (waiter) waiter(m);
      else this.inbox.push(m);
    });
    ws.addEventListener("error", () => {});
  }

  static connect(port: number): Promise<Client> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const client = new Client(ws);
      ws.addEventListener("open", () => resolve(client));
      ws.addEventListener("error", () => reject(new Error("relay connect failed")));
    });
  }

  send(m: Msg): void {
    this.ws.send(JSON.stringify(m));
  }

  hello(fp: string): void {
    this.send({ t: "hello", fp });
  }

  /** hello is fire-and-forget, so this round-trips an unknown message off the
   *  same socket to prove the server has processed the hello before another
   *  client sends to this fingerprint. */
  async register(fp: string): Promise<void> {
    this.hello(fp);
    this.send({ t: "__barrier__" });
    assert.equal((await this.next()).t, "error");
  }

  next(timeoutMs = 3000): Promise<Msg> {
    const buffered = this.inbox.shift();
    if (buffered) return Promise.resolve(buffered);
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter = (m: Msg) => {
        if (timer) clearTimeout(timer);
        resolve(m);
      };
      timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error("timed out waiting for a relay message"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async expectSilence(ms: number): Promise<void> {
    await sleep(ms);
    assert.deepEqual(this.inbox, [], "expected this client to receive nothing");
  }
}

async function withRelay(fn: (port: number) => Promise<void>): Promise<void> {
  const relay = await startRelay({ port: 0 });
  try {
    await fn(relay.port);
  } finally {
    await relay.close();
  }
}

test("starts on port 0 and reports the real port it bound", async () => {
  const relay = await startRelay({ port: 0 });
  try {
    assert.equal(typeof relay.port, "number");
    assert.ok(relay.port > 0 && relay.port < 65536, `implausible port ${relay.port}`);
    const c = await Client.connect(relay.port);
    assert.equal(c.ws.readyState, WebSocket.OPEN);
  } finally {
    await relay.close();
  }
});

test("routes a frame between two connected clients", async () => {
  await withRelay(async (port) => {
    const a = await Client.connect(port);
    const b = await Client.connect(port);
    await a.register(FP_A);
    await b.register(FP_B);

    a.send({ t: "send", to: FP_B, frame: b64("sealed-bytes") });

    assert.deepEqual(await b.next(), { t: "deliver", from: FP_A, frame: b64("sealed-bytes") });
    await a.expectSilence(100);
  });
});

test("queues for an offline recipient and drains on reconnect", async () => {
  await withRelay(async (port) => {
    const a = await Client.connect(port);
    a.hello(FP_A);

    a.send({ t: "send", to: FP_B, frame: b64("one") });
    a.send({ t: "send", to: FP_B, frame: b64("two") });
    assert.deepEqual(await a.next(), { t: "queued" });
    assert.deepEqual(await a.next(), { t: "queued" });

    const b = await Client.connect(port);
    b.hello(FP_B);

    assert.deepEqual(await b.next(), { t: "deliver", from: FP_A, frame: b64("one") });
    assert.deepEqual(await b.next(), { t: "deliver", from: FP_A, frame: b64("two") });

    // the queue is emptied by the drain, not replayed on the next hello
    const b2 = await Client.connect(port);
    b2.hello(FP_B);
    await b2.expectSilence(150);
  });
});

test("rejects a frame over 256 KB and delivers one of exactly 256 KB", async () => {
  await withRelay(async (port) => {
    const a = await Client.connect(port);
    const b = await Client.connect(port);
    await a.register(FP_A);
    await b.register(FP_B);

    a.send({ t: "send", to: FP_B, frame: "A".repeat(MAX_FRAME + 1) });
    const err = await a.next();
    assert.equal(err.t, "error");
    assert.equal(typeof err.msg, "string");
    await b.expectSilence(150);

    a.send({ t: "send", to: FP_B, frame: "A".repeat(MAX_FRAME) });
    const ok = await b.next();
    assert.equal(ok.t, "deliver");
    assert.equal(String(ok.frame).length, MAX_FRAME);
  });
});

test("does not deliver to the wrong fingerprint", async () => {
  await withRelay(async (port) => {
    const a = await Client.connect(port);
    const b = await Client.connect(port);
    const c = await Client.connect(port);
    await a.register(FP_A);
    await b.register(FP_B);
    await c.register(FP_C);

    a.send({ t: "send", to: FP_B, frame: b64("for-b-only") });

    assert.deepEqual(await b.next(), { t: "deliver", from: FP_A, frame: b64("for-b-only") });
    await c.expectSilence(200);
  });
});

test("stamps from off the connection and ignores a self-asserted from", async () => {
  await withRelay(async (port) => {
    const a = await Client.connect(port);
    const b = await Client.connect(port);
    await a.register(FP_A);
    await b.register(FP_B);

    a.send({ t: "send", to: FP_B, frame: b64("x"), from: FP_C, fp: FP_C });

    assert.deepEqual(await b.next(), { t: "deliver", from: FP_A, frame: b64("x") });
  });
});

test("caps the per-recipient queue at 500 frames, dropping the oldest", async () => {
  await withRelay(async (port) => {
    const a = await Client.connect(port);
    a.hello(FP_A);

    for (let i = 0; i < 501; i++) a.send({ t: "send", to: FP_B, frame: b64(String(i)) });

    let queued = 0;
    let overflow = 0;
    for (let i = 0; i < 502; i++) {
      const m = await a.next(5000);
      if (m.t === "queued") queued++;
      else if (m.t === "overflow") overflow++;
      else assert.fail(`unexpected reply ${JSON.stringify(m)}`);
    }
    assert.equal(queued, 501);
    assert.equal(overflow, 1);

    const b = await Client.connect(port);
    b.hello(FP_B);

    const got: string[] = [];
    for (let i = 0; i < 500; i++) {
      const m = await b.next(5000);
      assert.equal(m.t, "deliver");
      got.push(Buffer.from(String(m.frame), "base64").toString("utf8"));
    }
    assert.equal(got[0], "1", "the oldest frame should have been dropped");
    assert.equal(got[499], "500");
    await b.expectSilence(150);
  });
});

test("refuses a send before hello and rejects malformed input", async () => {
  await withRelay(async (port) => {
    const a = await Client.connect(port);

    a.send({ t: "send", to: FP_B, frame: b64("early") });
    assert.equal((await a.next()).t, "error");

    a.hello("NOT-A-FINGERPRINT");
    assert.equal((await a.next()).t, "error");

    a.ws.send("{not json");
    assert.equal((await a.next()).t, "error");

    a.hello(FP_A);
    a.send({ t: "send", to: "zz", frame: b64("x") });
    assert.equal((await a.next()).t, "error");

    a.send({ t: "send", to: FP_B, frame: 42 });
    assert.equal((await a.next()).t, "error");

    a.send({ t: "nonsense" });
    assert.equal((await a.next()).t, "error");
  });
});

// ---- pairing mailboxes (spec s8) --------------------------------------------
//
// Every rule below is a security property rather than a nicety, so each has its
// own test and each test says which attack it refuses.

const MBOX_A = "a".repeat(64);
const MBOX_B = "b".repeat(64);
/** Exactly the TTL, so tests can sit either side of the boundary. */
const TTL_MS = MBOX_TTL_MS;

/** A relay on a clock the test moves by hand, so the TTL can be crossed
 *  without a test that waits it out. */
async function withRelayOnClock(
  clock: { ms: number },
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const relay = await startRelay({ port: 0, now: () => clock.ms });
  try {
    await fn(relay.port);
  } finally {
    await relay.close();
  }
}

test("a mailbox is claimed exactly once, and the second claim is empty", async () => {
  await withRelay(async (port) => {
    // No hello anywhere in this test. A mailbox op is deliberately anonymous:
    // it must not tell the relay which identity is behind a pending invite.
    const inviter = await Client.connect(port);
    const claimer = await Client.connect(port);

    inviter.send({ t: "mbox_put", id: MBOX_A, data: b64("jake's bundle") });
    assert.deepEqual(await inviter.next(), { t: "mbox_ok" });

    claimer.send({ t: "mbox_take", id: MBOX_A });
    assert.deepEqual(await claimer.next(), { t: "mbox_data", data: b64("jake's bundle") });

    // SINGLE CLAIM. Whoever comes second is the real invitee finding out, and
    // that is the alarm: a stolen code fails loudly rather than working twice.
    claimer.send({ t: "mbox_take", id: MBOX_A });
    assert.deepEqual(await claimer.next(), { t: "mbox_empty" });

    // Including for the person who wrote it.
    inviter.send({ t: "mbox_take", id: MBOX_A });
    assert.deepEqual(await inviter.next(), { t: "mbox_empty" });
  });
});

test("a wrong code finds an empty mailbox rather than an error", async () => {
  await withRelay(async (port) => {
    const c = await Client.connect(port);
    c.send({ t: "mbox_put", id: MBOX_A, data: b64("bundle") });
    assert.deepEqual(await c.next(), { t: "mbox_ok" });

    // Only that one refusal is coded. A malformed put is just an error, so the
    // code cannot be used to probe anything else.
    c.send({ t: "mbox_put", id: "nope", data: b64("x") });
    assert.equal((await c.next())["code"], undefined);

    // A guess that is one mailbox off learns nothing about whether MBOX_A
    // exists: it gets the same answer an unused relay would give.
    c.send({ t: "mbox_take", id: MBOX_B });
    assert.deepEqual(await c.next(), { t: "mbox_empty" });
  });
});

test("a put over a live mailbox is refused, and the original is untouched", async () => {
  await withRelay(async (port) => {
    const jake = await Client.connect(port);
    const mallory = await Client.connect(port);

    jake.send({ t: "mbox_put", id: MBOX_A, data: b64("jake's bundle") });
    assert.deepEqual(await jake.next(), { t: "mbox_ok" });

    // The attack this refuses: swap your keys in for the inviter's and the
    // invitee pairs with you with no visible symptom at all.
    mallory.send({ t: "mbox_put", id: MBOX_A, data: b64("mallory's bundle") });
    const refusal = await mallory.next();
    assert.equal(refusal.t, "error");
    // Machine readable, because the joiner has to tell this refusal from a
    // network failure: one is an alarm, the other is a bad afternoon.
    assert.equal(refusal["code"], "occupied");

    jake.send({ t: "mbox_take", id: MBOX_A });
    assert.deepEqual(await jake.next(), { t: "mbox_data", data: b64("jake's bundle") });
  });
});

test("a mailbox expires once its short TTL is up", async () => {
  const clock = { ms: 1_700_000_000_000 };
  await withRelayOnClock(clock, async (port) => {
    const c = await Client.connect(port);

    c.send({ t: "mbox_put", id: MBOX_A, data: b64("bundle") });
    assert.deepEqual(await c.next(), { t: "mbox_ok" });

    // One millisecond short of a day is still a live invite.
    clock.ms += TTL_MS - 1;
    c.send({ t: "mbox_take", id: MBOX_A });
    assert.deepEqual(await c.next(), { t: "mbox_data", data: b64("bundle") });

    c.send({ t: "mbox_put", id: MBOX_A, data: b64("bundle") });
    assert.deepEqual(await c.next(), { t: "mbox_ok" });

    // A day exactly is not.
    clock.ms += TTL_MS;
    c.send({ t: "mbox_take", id: MBOX_A });
    assert.deepEqual(await c.next(), { t: "mbox_empty" });

    // And the expiry really deleted it: the id is free to reuse.
    c.send({ t: "mbox_put", id: MBOX_A, data: b64("a later invite") });
    assert.deepEqual(await c.next(), { t: "mbox_ok" });
    c.send({ t: "mbox_take", id: MBOX_A });
    assert.deepEqual(await c.next(), { t: "mbox_data", data: b64("a later invite") });
  });
});

test("expired mailboxes are swept rather than accumulating", async () => {
  const clock = { ms: 0 };
  await withRelayOnClock(clock, async (port) => {
    const c = await Client.connect(port);
    const id = (n: number) => n.toString(16).padStart(64, "0");

    for (let i = 0; i < 50; i++) c.send({ t: "mbox_put", id: id(i), data: b64("x") });
    for (let i = 0; i < 50; i++) assert.deepEqual(await c.next(), { t: "mbox_ok" });

    // Nobody ever claims them. Once the TTL passes they are gone without a
    // take, which is what stops an abandoned invite living in memory forever.
    clock.ms += TTL_MS + 1;

    // Checking 50 misses from one connection would trip the miss budget, which
    // is exactly what that budget is for: nothing legitimate misses repeatedly.
    // So this reconnects, the way an honest client that had 50 abandoned
    // invites would have to.
    let checker = c;
    for (let i = 0; i < 50; i++) {
      if (i > 0 && i % 15 === 0) {
        checker.ws.close();
        checker = await Client.connect(port);
      }
      checker.send({ t: "mbox_take", id: id(i) });
      assert.deepEqual(await checker.next(), { t: "mbox_empty" }, `mailbox ${i} outlived its TTL`);
    }
    if (checker !== c) checker.ws.close();
  });
});

test("the relay refuses to hold more than 10000 mailboxes", async () => {
  await withRelay(async (port) => {
    const c = await Client.connect(port);
    const id = (n: number) => n.toString(16).padStart(64, "0");

    for (let i = 0; i < 10_000; i++) c.send({ t: "mbox_put", id: id(i), data: b64("x") });
    for (let i = 0; i < 10_000; i++) {
      assert.deepEqual(await c.next(20_000), { t: "mbox_ok" }, `put ${i} was refused`);
    }

    // Past the cap a put is refused rather than remembered, so a stranger
    // cannot grow the relay's heap one mailbox at a time.
    c.send({ t: "mbox_put", id: id(10_000), data: b64("x") });
    assert.equal((await c.next()).t, "error");

    // Claiming one frees exactly one slot.
    c.send({ t: "mbox_take", id: id(0) });
    assert.equal((await c.next()).t, "mbox_data");
    c.send({ t: "mbox_put", id: id(10_000), data: b64("x") });
    assert.deepEqual(await c.next(), { t: "mbox_ok" });
  });
});

test("malformed mailbox messages are refused", async () => {
  await withRelay(async (port) => {
    const c = await Client.connect(port);

    // An id that is not 64 hex. A fingerprint-length id is not a mailbox id.
    for (const id of ["", "zz", FP_A, MBOX_A.toUpperCase(), MBOX_A + "a", 42, null]) {
      c.send({ t: "mbox_put", id, data: b64("x") });
      assert.equal((await c.next()).t, "error", `put accepted id ${String(id)}`);
      c.send({ t: "mbox_take", id });
      assert.equal((await c.next()).t, "error", `take accepted id ${String(id)}`);
    }

    // Data that is not a non-empty base64 string.
    for (const data of ["", 42, null, { a: 1 }, "not base64!", "a".repeat(4097)]) {
      c.send({ t: "mbox_put", id: MBOX_A, data });
      assert.equal((await c.next()).t, "error", `put accepted data ${JSON.stringify(data)}`);
    }

    // None of that left anything behind.
    c.send({ t: "mbox_take", id: MBOX_A });
    assert.deepEqual(await c.next(), { t: "mbox_empty" });

    // 4096 characters is the boundary and is allowed.
    c.send({ t: "mbox_put", id: MBOX_A, data: "a".repeat(4096) });
    assert.deepEqual(await c.next(), { t: "mbox_ok" });
  });
});

test("a mailbox never reaches the envelope path", async () => {
  await withRelay(async (port) => {
    const a = await Client.connect(port);
    const b = await Client.connect(port);
    await a.register(FP_A);

    b.send({ t: "mbox_put", id: MBOX_A, data: b64("a bundle nobody asked for") });
    assert.deepEqual(await b.next(), { t: "mbox_ok" });

    // A mailbox is only ever readable by someone who names its id. It is not
    // broadcast, not queued, and not delivered to whoever happens to be online.
    await a.expectSilence(150);
  });
});
