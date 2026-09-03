/**
 * `seshi watch` polls for the socket every two seconds and the invite is
 * broadcast the instant the socket exists, so a watcher reliably missed the
 * one line the human has to send. Recent events are replayed on subscribe.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { startDaemon } from "../src/daemon.ts";

test("a watcher that subscribes late is handed the recent events first", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "seshi-replay-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const daemon = await startDaemon({ home, idleTimeoutMs: 0, current: () => null });
  t.after(() => daemon.stop());

  daemon.broadcast({ kind: "invite", link: "seshi join 1-a-b@relay" });
  daemon.broadcast({ kind: "words", words: "one two three four" });

  const lines: string[] = [];
  const socket = connect(daemon.socketPath);
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      lines.push(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  });
  await new Promise((r) => socket.once("connect", r));
  socket.write(`${JSON.stringify({ id: 1, token: daemon.token, verb: "watch" })}\n`);
  const deadline = Date.now() + 3000;
  while (lines.length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  socket.destroy();

  const ack = JSON.parse(lines[0]!) as { ok: boolean; result: { replayed: number } };
  assert.equal(ack.ok, true);
  assert.equal(ack.result.replayed, 2);
  const events = lines.slice(1).map((l) => (JSON.parse(l) as { event: { kind: string } }).event.kind);
  assert.deepEqual(events, ["invite", "words"], "replayed in order, oldest first");
});
