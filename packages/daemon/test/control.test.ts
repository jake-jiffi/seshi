import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, type Socket } from "node:net";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type Daemon } from "../src/daemon.ts";
import { constantTimeEqual, controlRequest } from "../src/control.ts";

const mode = (p: string): number => statSync(p).mode & 0o777;

function freshHome(): string {
  return join(mkdtempSync(join(tmpdir(), "seshi-control-")), "home");
}

type Msg = Record<string, unknown>;

/** A raw line-protocol client, so the tests exercise the wire rather than a helper. */
class Ctl {
  private readonly socket: Socket;
  private buf = "";
  private readonly inbox: Msg[] = [];
  private readonly waiters: Array<(m: Msg) => void> = [];
  readonly ended: Promise<void>;

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) !== -1) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (line === "") continue;
        const m = JSON.parse(line) as Msg;
        const waiter = this.waiters.shift();
        if (waiter) waiter(m);
        else this.inbox.push(m);
      }
    });
    socket.on("error", () => {});
    this.ended = new Promise((resolve) => socket.on("close", () => resolve()));
  }

  static open(path: string): Promise<Ctl> {
    return new Promise((resolve, reject) => {
      const socket = connect(path);
      const ctl = new Ctl(socket);
      socket.on("connect", () => resolve(ctl));
      socket.on("error", (err) => reject(err));
    });
  }

  send(obj: unknown): void {
    this.socket.write(`${JSON.stringify(obj)}\n`);
  }

  writeRaw(s: string): void {
    this.socket.write(s);
  }

  next(): Promise<Msg> {
    const queued = this.inbox.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for a control reply")), 5000);
      this.waiters.push((m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  }

  /** One request, one reply. */
  async call(req: unknown): Promise<Msg> {
    this.send(req);
    return this.next();
  }

  close(): void {
    this.socket.destroy();
  }
}

async function boot(overrides: { idleTimeoutMs?: number; home?: string } = {}): Promise<Daemon> {
  return startDaemon({
    home: overrides.home ?? freshHome(),
    // Long enough that no test trips it by accident; the exit test sets its own.
    idleTimeoutMs: overrides.idleTimeoutMs ?? 60_000,
  });
}

test("the control socket and the control key are both 0600", async () => {
  const d = await boot();
  try {
    assert.equal(mode(d.socketPath), 0o600);
    assert.equal(mode(join(d.home, "control.key")), 0o600);
    assert.equal(readFileSync(join(d.home, "control.key"), "utf8").trim(), d.token);
  } finally {
    await d.stop();
  }
});

test("a caller with no token is refused and disconnected", async () => {
  const d = await boot();
  try {
    const c = await Ctl.open(d.socketPath);
    const reply = await c.call({ id: 1, verb: "status" });
    assert.equal(reply["ok"], false);
    assert.match(String(reply["error"]), /token/i);
    await c.ended; // the daemon must not keep talking to an unauthenticated caller
  } finally {
    await d.stop();
  }
});

test("a caller with the wrong token is refused, whatever its length", async () => {
  const d = await boot();
  try {
    for (const bad of ["0".repeat(64), "short", "", "x".repeat(4096)]) {
      const c = await Ctl.open(d.socketPath);
      const reply = await c.call({ id: 1, token: bad, verb: "status" });
      assert.equal(reply["ok"], false, `token ${bad.slice(0, 8)} must be refused`);
      assert.match(String(reply["error"]), /token/i);
      await c.ended;
    }
  } finally {
    await d.stop();
  }
});

test("constantTimeEqual is false for unequal lengths and does not throw", () => {
  assert.equal(constantTimeEqual("abc", "abc"), true);
  assert.equal(constantTimeEqual("abc", "abcd"), false);
  assert.equal(constantTimeEqual("", ""), true);
  assert.equal(constantTimeEqual("a", ""), false);
});

test("an authenticated caller can read status, contacts and convos", async () => {
  const d = await boot();
  try {
    d.storage.putContact({
      fingerprint: "aaaaaaaaaaaaaaaa",
      name: "dave",
      signPub: "11".repeat(32),
      sealPub: "22".repeat(32),
      tier: 2,
      verifiedAt: null,
    });
    d.storage.putConvo({
      id: "c-1",
      peer: "aaaaaaaaaaaaaaaa",
      mode: "decide",
      state: "open",
      createdAt: new Date().toISOString(),
      budget: { turns: 24, warnAt: 16, used: 0 },
      brief: { objective: "push or poll", definitionOfDone: [], nonNegotiables: [], facts: [] },
    });

    const c = await Ctl.open(d.socketPath);
    const status = await c.call({ id: 1, token: d.token, verb: "status" });
    assert.equal(status["ok"], true);
    assert.equal(status["id"], 1);
    const result = status["result"] as Record<string, unknown>;
    assert.equal(result["home"], d.home);
    assert.equal(result["pid"], process.pid);

    const contacts = await c.call({ id: 2, token: d.token, verb: "contacts" });
    assert.deepEqual(
      (contacts["result"] as Array<{ name: string }>).map((x) => x.name),
      ["dave"],
    );

    const convos = await c.call({ id: 3, token: d.token, verb: "convos" });
    assert.deepEqual(
      (convos["result"] as Array<{ id: string }>).map((x) => x.id),
      ["c-1"],
    );
    c.close();
  } finally {
    await d.stop();
  }
});

test("an unknown verb is refused", async () => {
  const d = await boot();
  try {
    const c = await Ctl.open(d.socketPath);
    const reply = await c.call({ id: 1, token: d.token, verb: "rm-rf" });
    assert.equal(reply["ok"], false);
    assert.match(String(reply["error"]), /unknown verb/i);
    // A bad verb from an authenticated caller is a mistake, not an attack: the
    // connection stays up.
    const ok = await c.call({ id: 2, token: d.token, verb: "status" });
    assert.equal(ok["ok"], true);
    c.close();
  } finally {
    await d.stop();
  }
});

test("an oversized request line is refused rather than buffered", async () => {
  const d = await boot();
  try {
    const c = await Ctl.open(d.socketPath);
    c.writeRaw("x".repeat(300 * 1024));
    const reply = await c.next();
    assert.equal(reply["ok"], false);
    assert.match(String(reply["error"]), /too large/i);
    await c.ended;
  } finally {
    await d.stop();
  }
});

test("say records the human's words and wakes every watcher", async () => {
  const d = await boot();
  try {
    d.storage.putConvo({
      id: "c-1",
      peer: "aaaaaaaaaaaaaaaa",
      mode: "decide",
      state: "open",
      createdAt: new Date().toISOString(),
      budget: { turns: 24, warnAt: 16, used: 0 },
      brief: { objective: "push or poll", definitionOfDone: [], nonNegotiables: [], facts: [] },
    });

    const watcher = await Ctl.open(d.socketPath);
    const watching = await watcher.call({ id: 1, token: d.token, verb: "watch" });
    assert.equal(watching["ok"], true);

    const c = await Ctl.open(d.socketPath);
    const said = await c.call({
      id: 1,
      token: d.token,
      verb: "say",
      args: { convo: "c-1", text: "Opening position: poll." },
    });
    assert.equal(said["ok"], true);

    const event = await watcher.next();
    assert.equal(event["t"], "event");
    const payload = event["event"] as Record<string, unknown>;
    assert.equal(payload["kind"], "say");
    assert.equal(payload["convo"], "c-1");
    assert.equal(payload["text"], "Opening position: poll.");

    const log = d.storage.readLog("c-1", "self") as Array<{ text: string }>;
    assert.deepEqual(log.map((l) => l.text), ["Opening position: poll."]);

    const unknown = await c.call({
      id: 2,
      token: d.token,
      verb: "say",
      args: { convo: "c-nope", text: "hi" },
    });
    assert.equal(unknown["ok"], false);
    assert.match(String(unknown["error"]), /unknown conversation/i);

    c.close();
    watcher.close();
  } finally {
    await d.stop();
  }
});

test("the socket may lower a tier but never raise one", async () => {
  const d = await boot();
  const fp = "aaaaaaaaaaaaaaaa";
  try {
    d.storage.putContact({
      fingerprint: fp,
      name: "dave",
      signPub: "11".repeat(32),
      sealPub: "22".repeat(32),
      tier: 2,
      verifiedAt: null,
    });
    const c = await Ctl.open(d.socketPath);

    const read = await c.call({ id: 1, token: d.token, verb: "tier", args: { peer: fp } });
    assert.equal((read["result"] as Record<string, unknown>)["tier"], 2);

    const raised = await c.call({ id: 2, token: d.token, verb: "tier", args: { peer: fp, tier: 3 } });
    assert.equal(raised["ok"], false, "raising a tier over the socket must be refused");
    assert.match(String(raised["error"]), /raise|terminal/i);
    assert.equal(d.storage.getContact(fp)?.tier, 2);

    const lowered = await c.call({ id: 3, token: d.token, verb: "tier", args: { peer: fp, tier: 1 } });
    assert.equal(lowered["ok"], true);
    assert.equal(d.storage.getContact(fp)?.tier, 1);

    const missing = await c.call({
      id: 4,
      token: d.token,
      verb: "tier",
      args: { peer: "bbbbbbbbbbbbbbbb" },
    });
    assert.equal(missing["ok"], false);
    assert.match(String(missing["error"]), /unknown contact/i);
    c.close();
  } finally {
    await d.stop();
  }
});

test("the daemon exits when the last client disconnects", async () => {
  const d = await boot({ idleTimeoutMs: 60 });
  const c = await Ctl.open(d.socketPath);
  const status = await c.call({ id: 1, token: d.token, verb: "status" });
  assert.equal(status["ok"], true);
  c.close();
  await d.stopped;
  assert.equal(existsSync(d.socketPath), false, "the socket must be cleaned up on exit");
});

test("a second daemon refuses a live home and takes over a stale socket", async () => {
  const home = freshHome();
  const d = await boot({ home });
  try {
    await assert.rejects(() => boot({ home }), /already running/i);
  } finally {
    await d.stop();
  }
  // stop() removed the socket, so a truly stale file is what is left behind.
  // Recreate one by hand to prove the takeover path, not just the happy path.
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(home, "control.sock"), "");
  const second = await boot({ home });
  try {
    const c = await Ctl.open(second.socketPath);
    const status = await c.call({ id: 1, token: second.token, verb: "status" });
    assert.equal(status["ok"], true);
    c.close();
  } finally {
    await second.stop();
  }
});

test("several requests pipelined into one packet are not mistaken for one huge one", async () => {
  const d = await boot();
  try {
    const c = await Ctl.open(d.socketPath);
    const one = JSON.stringify({ id: 1, token: d.token, verb: "status" });
    const two = JSON.stringify({ id: 2, token: d.token, verb: "contacts" });
    c.writeRaw(`${one}\n${two}\n`);
    const first = await c.next();
    const second = await c.next();
    assert.equal(first["id"], 1);
    assert.equal(first["ok"], true);
    assert.equal(second["id"], 2);
    assert.equal(second["ok"], true, "replies must stay in request order");
    c.close();
  } finally {
    await d.stop();
  }
});

test("inherited object properties are not reachable as verbs", async () => {
  const d = await boot();
  try {
    const c = await Ctl.open(d.socketPath);
    for (const verb of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const reply = await c.call({ id: 1, token: d.token, verb });
      assert.equal(reply["ok"], false, `${verb} must not resolve to a handler`);
      assert.match(String(reply["error"]), /unknown verb/i);
    }
    c.close();
  } finally {
    await d.stop();
  }
});

test("controlRequest does one round trip and surfaces daemon errors", async () => {
  const d = await boot();
  try {
    const status = (await controlRequest(d.socketPath, d.token, "status")) as Record<string, unknown>;
    assert.equal(status["home"], d.home);
    await assert.rejects(
      () => controlRequest(d.socketPath, d.token, "say", { convo: "c-nope", text: "hi" }),
      /unknown conversation/i,
    );
    await assert.rejects(
      () => controlRequest(d.socketPath, "0".repeat(64), "status"),
      /token/i,
    );
  } finally {
    await d.stop();
  }
});
