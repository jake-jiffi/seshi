/**
 * Regressions from the second adversarial review. Each test reproduces the
 * reviewer's own repro before the fix, so reverting a fix must turn one red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay } from "@seshi/relay/server";
import { SeshiNode } from "@seshi/daemon/node";
import type { PublicBrief } from "@seshi/daemon/storage";
import { createWorktree, branchNameFor } from "../src/worktree.ts";

const dirs: string[] = [];
const tmp = (l: string) => {
  const d = mkdtempSync(join(tmpdir(), `seshi-r-${l}-`));
  dirs.push(d);
  return d;
};
process.on("exit", () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const BRIEF: PublicBrief = {
  objective: "o", definitionOfDone: [], nonNegotiables: [], facts: [],
};

function joinConvo(node: SeshiNode, id: string, peer: string): void {
  node.storage.putConvo({
    id, peer, mode: "decide", state: "live",
    createdAt: new Date().toISOString(),
    budget: { turns: 24, warnAt: 16, used: 0 }, brief: BRIEF,
  });
}

async function pairUp(t: { after: (fn: () => void | Promise<void>) => void }) {
  const relay = await startRelay({ port: 0 });
  const url = `ws://127.0.0.1:${relay.port}`;
  const jake = await SeshiNode.open({ home: tmp("jake"), relayUrl: url, name: "jake" });
  const daveHome = tmp("dave");
  const dave = await SeshiNode.open({ home: daveHome, relayUrl: url, name: "dave" });
  dave.pair(jake.invite());
  jake.pair(dave.invite());
  t.after(async () => { jake.close(); dave.close(); await relay.close(); });
  return { relay, url, jake, dave, daveHome };
}

// ---- R3: a gap must not crash the daemon, and the turn must still arrive ----

test("R3: a sequence gap is recorded but does not crash, and the turn is delivered", async (t) => {
  const { jake, dave } = await pairUp(t);
  const convo = jake.startConvo({ peer: "dave", mode: "decide", brief: BRIEF });
  joinConvo(dave, convo.id, jake.fingerprint);

  await jake.send(convo.id, { seq: 1, prev: null, act: "BRIEF", headline: "one", body: "one" });
  await dave.waitForTurn({ timeoutMs: 5000 });

  // A frame the relay dropped on overflow leaves a hole. Reproduce it directly.
  await jake.resend(convo.id, {
    v: 1, convo: convo.id, seq: 5, prev: null, from: "",
    act: "PROPOSE", headline: "jumped", body: "a turn went missing",
  });

  const turn = await dave.waitForTurn({ timeoutMs: 5000 });
  assert.equal(turn.envelope.body, "a turn went missing", "a gapped turn must still be delivered");
  assert.ok(dave.rejects.some((r) => /gap/.test(r.reason)), "and the gap must be recorded");

  // The daemon must still be alive. Proved on a fresh conversation, because
  // the gapped chain has legitimately moved past seq 5 and a lower sequence on
  // it now IS a fork.
  const second = jake.startConvo({ peer: "dave", mode: "decide", brief: BRIEF });
  joinConvo(dave, second.id, jake.fingerprint);
  await jake.send(second.id, { seq: 0, prev: null, act: "EVIDENCE", headline: "after", body: "still alive" });
  const after = await dave.waitForTurn({ timeoutMs: 5000 });
  assert.equal(after.envelope.body, "still alive", "the daemon must survive a gap");
});

// ---- R4: replay protection must survive a daemon restart ----

test("R4: a captured frame replayed after a restart is still refused", async (t) => {
  const { url, jake, dave, daveHome } = await pairUp(t);
  const convo = jake.startConvo({ peer: "dave", mode: "decide", brief: BRIEF });
  joinConvo(dave, convo.id, jake.fingerprint);

  const sent = await jake.send(convo.id, { seq: 1, prev: null, act: "BRIEF", headline: "h", body: "once" });
  await dave.waitForTurn({ timeoutMs: 5000 });
  dave.close();

  // The daemon exits when the last client disconnects. That is the normal
  // lifecycle, so replay protection has to outlive the process.
  const dave2 = await SeshiNode.open({ home: daveHome, relayUrl: url, name: "dave" });
  t.after(() => dave2.close());
  await jake.resend(convo.id, sent);

  await assert.rejects(() => dave2.waitForTurn({ timeoutMs: 1200 }), /timed out/);
  assert.equal(
    dave2.storage.readLog(convo.id, jake.fingerprint).length,
    1,
    "a replay after restart must not be logged a second time",
  );
});

// ---- R6: the participant check had no test at all ----

test("R6: a paired peer cannot send into a conversation that is with someone else", async (t) => {
  const { url, jake, dave } = await pairUp(t);
  const mallory = await SeshiNode.open({ home: tmp("mal"), relayUrl: url, name: "mallory" });
  t.after(() => mallory.close());
  dave.pair(mallory.invite());
  mallory.pair(dave.invite());

  // Dave has a conversation with Jake. Mallory is separately paired with Dave
  // and knows its id.
  const convo = jake.startConvo({ peer: "dave", mode: "decide", brief: BRIEF });
  joinConvo(dave, convo.id, jake.fingerprint);

  mallory.storage.putConvo({
    id: convo.id, peer: dave.fingerprint, mode: "decide", state: "live",
    createdAt: new Date().toISOString(),
    budget: { turns: 24, warnAt: 16, used: 0 }, brief: BRIEF,
  });
  await mallory.send(convo.id, { seq: 1, prev: null, act: "PROPOSE", headline: "h", body: "let me in" });

  await assert.rejects(() => dave.waitForTurn({ timeoutMs: 1200 }), /timed out/);
  assert.ok(
    dave.rejects.some((r) => /not with them|is with/.test(r.reason)),
    `expected a participant rejection, got: ${JSON.stringify(dave.rejects)}`,
  );
  assert.equal(dave.storage.readLog(convo.id, mallory.fingerprint).length, 0);
});

// ---- R5: an ignored file the agent creates must not vanish from the patch ----

test("R5: gitignored files the agent creates still appear in the proposed patch", () => {
  const repo = tmp("repo");
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  writeFileSync(join(repo, ".gitignore"), "secret.txt\n*.log\ndist/\n");
  writeFileSync(join(repo, "README.md"), "x\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");

  const wt = createWorktree({ repo, branch: branchNameFor("dave", "c"), path: join(repo, ".wt") });
  writeFileSync(join(wt.path, "normal.txt"), "visible\n");
  writeFileSync(join(wt.path, "secret.txt"), "the agent wrote this\n");
  writeFileSync(join(wt.path, "app.log"), "and this\n");
  execFileSync("mkdir", ["-p", join(wt.path, "dist")]);
  writeFileSync(join(wt.path, "dist", "bundle.js"), "and this too\n");

  const patch = wt.diff();
  wt.remove();

  // A patch that silently drops files the agent created is worse than no patch:
  // the human reviews an incomplete change and applies it believing it whole.
  for (const f of ["normal.txt", "secret.txt", "app.log", "dist/bundle.js"]) {
    assert.match(patch, new RegExp(f.replace(".", "\\.")), `${f} must be in the patch`);
  }
});
