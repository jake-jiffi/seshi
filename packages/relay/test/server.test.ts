import { test } from "node:test";
import assert from "node:assert/strict";
import { startRelay } from "../src/server.ts";

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
