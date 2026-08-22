# Corrections to the plan, found after it was written

Applied by the orchestrator between build waves. Each one is a plan defect, not an agent defect.

## C1. Fingerprint length: 64 bits is too short

**Plan said:** `fingerprint()` returns 16 lowercase hex chars.

**Wrong because:** the fingerprint is a TOFU identity pin. Impersonating a pinned contact is a
second-preimage attack, 2^64 for a 64-bit digest. That is grindable. `retalk` uses 128 bits
(`sha256(identity|signing)[:32]`, `user.py:71-74`) and is right to.

**Fix:** 32 lowercase hex chars, 128 bits. Bind BOTH public keys into the digest, not just the
signing key, so a contact cannot be re-pointed at a different sealing key while keeping its identity:

```ts
export function fingerprint(signPub: Uint8Array, sealPub: Uint8Array): string {
  return bytesToHex(sha256(concatBytes(signPub, sealPub))).slice(0, 32);
}
```

Every `/^[0-9a-f]{16}$/` assertion becomes `/^[0-9a-f]{32}$/`.

## C2. Inbound peer delivery IS gated, by the receiver's permission mode

**Research said:** inbound auth is Windows-only (`authRequired = t.requireAuth ?? ati()`), there is no
peer allowlist, so a peer message just lands. Our own `SESHI-IMPOSTOR` probe confirmed it by landing
in a live session mid-turn with no prompt.

**Incomplete, because:** that session was running in bypass permissions mode. A later probe against a
session in a stricter mode produced, verbatim:

```
Your message to another session was held for the recipient user's approval
Your message to another session was denied by the recipient user
```

**So:** cross-session delivery is gated by the RECEIVING session's permission mode, not by the bus.
Claude Code already ships a human consent gate for peer messages.

**Effect on the design:** better than we assumed. seshi does not have to invent the consent gate for
the local hop, and should not bypass it. Anything in seshi that would only work in bypass mode is
relying on the user having disarmed their own protection, and must be treated as unsupported.

## C3. Subagents address the peer bus AS their parent session

**Observed:** a message sent by a subagent produced a delivery notice addressed to the parent
("*your* message"). `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` are exported
into the environment of every Bash tool call, and subagents inherit them.

**Effect on the design:** this is the concrete justification for the spec's rule that every peer
process denies `SendMessage` and `ListAgents`. Any subagent, or any shell command, running inside a
peer process would otherwise be able to address the human's own live sessions with no further
permission. Demonstrated, not theorised.

### C1 applied, and it closed a real attack

Fixing the length surfaced a second, worse problem. The fingerprint covered only the SIGNING key, so
an interceptor could take a real invite, leave `signPub` untouched (they cannot forge a signature
anyway) and swap in **their own sealing key**. The fingerprint check still passed. The victim paired
happily, and every message they sent "to Jake" was encrypted to the interceptor, who could read all
of it. They could not send as Jake, only read everything sent to him.

Demonstrated as a failing test before the fix, in
`test/e2e/two-people.test.ts` → *"an invite cannot have its sealing key swapped while keeping the
fingerprint"*.

`fingerprint()` now takes both public keys and binds them into one digest, at 128 bits:

```ts
export function fingerprint(signPub: Uint8Array, sealPub: Uint8Array): string {
  const bound = new Uint8Array(64);
  bound.set(signPub, 0);
  bound.set(sealPub, 32);
  return bytesToHex(sha256(bound)).slice(0, 32);
}
```

## C4. The detectors were inert in the running system

Found by adversarial review, and it is the most important defect in the project so far. Every
detector unit test passed while the detectors could not fire at all in production, because the tests
synthesised histories the real `Conversation` never produced.

Three independent wiring gaps, all confirmed by grep:

1. **Self turns carried `from: ""`.** `detect()` filters parties with an empty `from`, so `parties`
   only ever held the peer. `agreement` and `deadlock` both return null below two parties, so
   neither could ever fire. Worse, the capitulation arm iterated `parties`, so **our own agent
   folding was invisible** — the one case the human most needs told about.
2. **`Ledger.transition()` was called nowhere in `packages/*/src`.** No issue ever left `open`, so
   `uncontestedSeededAgreements()` (which requires `agreed`) was dead, and `agreement`'s
   `openCount() === 0` gate was permanently false.
3. **`namedConcessions` was never supplied by any caller**, so the third fold condition was dead.

Net effect: "degenerate agreement", which the spec calls the detector that matters most, reduced to
a capitulation check applied only to the remote peer.

**Fixed by:** stamping self turns with our own fingerprint; applying declared ledger states through
`#applyLedgerView` (illegal transitions ignored, local ledger stays authoritative so a peer still
cannot add or resurrect an issue); adding `concessions` to the envelope and requiring it on
`RED_TEAM` in the protocol text.

**The lesson, which is the reason this entry is long:** a unit test that calls `detect()` directly
cannot catch this class of bug. `test/e2e/detector-wiring.test.ts` now drives the real
`Conversation` against a fake `claude` on PATH. That file must keep existing for as long as the
detectors matter.

## C5. No replay protection, and inbound was not scoped to a conversation

Also from the review, with a working reproduction: one sealed frame re-injected three times was
accepted and logged three times. `Chain` existed, was fully tested, and was imported by nothing.
Generated envelopes always carried `prev: null`.

Separately, a paired peer could name **any** conversation id, and `appendLog` would create
`convos/<id>/log/<peer>.jsonl` on the receiver's disk for a conversation they never started.

**Fixed by:** `SeshiNode` now keeps a `Chain` per `(conversation, party)`. `send()` takes `seq` and
`prev` from our own chain rather than the caller. `#deliver()` refuses an envelope whose conversation
we never joined, refuses one whose conversation belongs to a different peer, and refuses a `fork`
verdict as a replay. A `gap` is recorded but delivered, because a known-incomplete transcript beats
pretending it is complete.

## C6. Known, accepted, not yet fixed

- **`contested` is peer-influenced.** `observe()` marks an issue contested from the peer's
  COUNTER/REJECT ledger references without proving a real contest happened, so a peer could suppress
  the "seeded conflict agreed uncontested" arm. Latent rather than urgent, and it needs a definition
  of "genuine contest" that is not itself gameable.
- **Peer env is a blocklist, not an allowlist.** `buildEnv` strips nine named variables; anything
  else in the daemon's environment is inherited. Mitigated because tiers 2 and 3 deny `Bash`,
  `WebFetch` and every MCP, so the child has no tool with which to read or exfiltrate it. An
  allowlist is still the right end state.
- **The relay's `hello` is unauthenticated.** Squatting a fingerprint can swallow queued frames. It
  cannot read them (no private key) or forge them (signatures verify at the receiver). Fix is a
  signed challenge at connect.

## C7. Second adversarial review: six more, five fixed, one design pass

### R2 — false agreement from an unverified hash (fixed)
`agreement` required "both signed the same artefact hash", but the hash was whatever the model typed
and nothing checked it against the diff it travelled with. Two agents could each write `sha256:
"agreed"` over **completely different documents** and it counted as a shared signature. `artefactHash()`
now recomputes over the diff and a mismatch is not a signature.

### R3 — the replay fix crashed the daemon (fixed)
`#deliver` recorded a gap and then called `chain.append()`, which throws on any non-`ok` verdict. The
throw was uncaught, so it propagated out of the ws message handler and killed `seshid`, and the turn
was never delivered despite the comment saying otherwise. Reachable **without an attacker**: the relay
drops the oldest frame on queue overflow, so a queue overflow produced a gap and a crash on reconnect.
`append()` now takes `tolerateGap`. A fork is still never tolerated.

### R4 — replay protection did not survive a restart (fixed)
Chains were in-memory only, and the daemon exits when the last client disconnects, which is the normal
lifecycle. Anyone holding a captured frame could replay it after the next restart. Chains are now
rehydrated from the append-only log on first use.

### R5 — the proposed patch silently dropped ignored files (fixed)
`git add -A` honours `.gitignore`, so any file the agent created matching an ignore rule vanished from
the patch. A human would review an incomplete change and apply it believing it whole. Now `add -A -f`,
which is safe because the worktree starts from HEAD, so the only ignored files present are ones the
agent just created and seeing them is the point.

### R6 — a stay-green test gap (fixed)
Replacing the `convo.peer === contact.fingerprint` participant check with `if (false)` left the whole
247-test suite green. The check was right; nothing guarded it. Now tested.

### R1 — folds were still evadable. This one needed a design pass, not a patch.
Three separate holes:
- **The act label was the whole signal.** A fold labelled `PROPOSE` or `EVIDENCE` scored zero. There is
  now an adoption detector that compares position fingerprints: restating the other side's position
  verbatim is a fold whatever the turn is called. (Guarded against empty fingerprints, which otherwise
  match each other and flag every short turn.)
- **The limit was strictly greater-than.** Exactly 7/10 slipped through. Now `>=`.
- **A concession was any non-empty string.** "we will be extra friendly in code review" passed. A
  concession must now share substance with something actually argued or an issue actually raised.
- **The CLI seeded an empty ledger** (`nonNegotiables: []`), which made the whole seeded-conflict arm
  structurally dead *in the shipped product* while the tests passed because their fixtures had
  non-negotiables. The CLI now seeds the objective as an issue and **says out loud** that convergence
  detection is weaker without a real brief.

**Honest residual:** a determined model can still fold in a way no local heuristic catches. These
detectors raise the cost and make the common cases visible. They are not a proof of good faith, and
the artefact says what fired rather than claiming a conversation was sound.

### Also fixed
- Tier 3 was unreachable from the CLI (`talk()` never passed `repo`). Now passes the cwd and says so.
- The CLI's final `writeDecision` called a bare `detect()` without `namedConcessions` or the ledger
  trail, so the written report was weaker than the live one. Now uses `detections()`.
- An unhandled `error` event on a connected WebSocket printed an undici stack trace on teardown.
  Unhandled errors hide real ones.

## C8. Third review: the detectors were false-positive heavy. Three now, not four.

The third adversarial pass attacked the new heuristics for FALSE POSITIVES rather than evasion, and
that was the right question: **five of eight hand-built healthy conversations fired a spurious fold**,
across all four arms. A detector the human learns to ignore costs you every real detection, which is
the bar this project set for itself.

(The 5/8 is hand-authored transcripts, not live-model traffic. Read it as "these healthy shapes
misfire", not as a rate.)

### The adoption detector is DELETED, not tuned

I added it in C7 to catch folds that dodge the act label. It was the wrong instrument in both
directions:

- It fired on a **teach learner restating the method to confirm understanding**, which is the
  behaviour teach mode explicitly instructs. It punished the instruction.
- It was **defeated by paraphrase**: "poll every thirty seconds" → "survey on a half-minute cadence"
  produces a disjoint fingerprint and sails through.

It caught honest echoing and missed the rephrased sycophant. Deleted. The gap is now recorded as a
passing test named `KNOWN GAP: a fold that avoids ACCEPT/CONCEDE in decide mode is NOT caught`, so it
is visible rather than forgotten.

### Capitulation is now mode-aware

`detect()` took no mode, so it could not tell an advocate folding from a learner learning. Measured
false positives: a teach learner at 75% ACCEPT, and a review author accepting three real findings at
100%. Both are the healthiest possible version of their mode. The arm now runs only in `decide` and
`build`, and `Conversation` passes `mode` through (with its own red-green test, because a fix that
never reaches the caller is the exact bug the first review found).

### Seeded-conflict needs real opposition

The conflict set is a heuristic guess off two briefs and over-includes. Requiring every seeded item to
receive a COUNTER before it may be agreed treated "we happened to agree" as a fold. Issues now carry
`opposed`, and only genuinely opposing brief positions count.

### Concession relatedness is DELETED

Requiring ≥2 shared content words flagged **genuine** concessions stated as abstractions ("I dropped
my latency requirement" when the debate said "freshness"), while any pleasant sentence reusing two
words passed. Lexical overlap is the wrong instrument for a semantic property. Only the ABSENCE of a
concession is a signal we can read honestly, so that is all we read. Recorded as
`KNOWN GAP: a plausible but fake concession is NOT caught`.

### The C7 hash fix had made agreement a false NEGATIVE

Verifying the hash was right; demanding identical bytes was not. Two sides generate artefacts
independently, so a trailing newline or CRLF blocked agreement entirely. `canonicaliseArtefact`
normalises line endings and trailing whitespace before hashing.

**Still unsolved, and stated rather than hidden:** a real `git diff` embeds `index <blob>..<blob>`
lines that depend on each person's base tree, so two independently produced diffs of the same logical
change are never equal however they are normalised. The real fix is one side proposing exact artefact
bytes and the other echoing those bytes. That is a protocol change and it is not done.

### The standing rule this establishes

Ship three detectors that work over four where one cries wolf. `packages/core/test/detectors-false-positives.test.ts`
is the specification for what "healthy" looks like; anything in it that starts failing means a
detector has become noise.
