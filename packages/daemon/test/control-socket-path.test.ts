/**
 * A Unix socket path is capped at 104 bytes on macOS and 108 on Linux. The
 * first live run put a home under a long scratch path and the joining side
 * died with `listen EINVAL` right after pairing. The path has to fit.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../src/storage.ts";
import { startDaemon } from "../src/daemon.ts";
import { controlRequest } from "../src/control.ts";

const dirs: string[] = [];
process.on("exit", () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("a short home keeps its socket inside the home", () => {
  const home = mkdtempSync(join(tmpdir(), "seshi-short-"));
  dirs.push(home);
  const s = Storage.open(home);
  assert.equal(s.controlSocketPath(), join(home, "control.sock"));
});

test("a deep home gets a short, deterministic socket path that actually binds", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "seshi-deep-"));
  dirs.push(base);
  const home = join(base, "a-directory-name-that-goes-on".repeat(4), "home");
  mkdirSync(home, { recursive: true });
  assert.ok(Buffer.byteLength(join(home, "control.sock")) > 104, "the test home must be too long to bind");

  const s = Storage.open(home);
  const path = s.controlSocketPath();
  assert.ok(Buffer.byteLength(path) <= 100, `socket path is still ${Buffer.byteLength(path)} bytes`);
  assert.equal(Storage.open(home).controlSocketPath(), path, "every process must compute the same path");
  assert.notEqual(Storage.open(mkdtempSync(join(base, "other-"))).controlSocketPath(), path, "two homes, two sockets");

  // The proof that matters: the daemon listens on it and a client reaches it.
  const daemon = await startDaemon({ home, idleTimeoutMs: 0, current: () => null });
  t.after(() => daemon.stop());
  const status = (await controlRequest(daemon.socketPath, daemon.token, "status")) as { home: string };
  assert.equal(status.home, home);
});
