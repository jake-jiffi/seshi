# Adversarial review, 3 September 2026

Scope: the whole repository as it stood after the first two-person run, plus the relay deployed to
Fly that afternoon. Brief from Jake: prevent issues and find speed, do not break what works.

Method: read every source file (6,062 lines), then attack each module across boundaries, hostile
input, hidden assumptions, state, failure modes and scale. Every finding below was measured or
reproduced before it was fixed. Every fix carries a test aimed at the spot where it would fail.
The relay fix was proven red by disabling the guard and watching its test fail.

Result: 341 tests, 339 pass, 0 fail, 2 skipped (both pre-existing). Was 327.

## Verdict

The cryptographic core holds. Sign-then-seal, with the signature inside the ciphertext and the
recipient bound into the signed bytes. A fresh ephemeral key per message. Both public keys in the
fingerprint. One error message for every decrypt failure. A per-author hash chain that refuses
replays and records gaps. I attacked it for an afternoon and found nothing to change.

Everything that broke was around the crypto, not in it. Five real defects, one of them a remote
out-of-memory on the public relay from a single unauthenticated socket.

## Findings, ranked

### 1. One socket could take the public relay down. Fixed.

**Claim attacked:** the relay bounds what it holds for offline recipients.

**What was true:** the only bound was 500 frames per recipient. A sender names a new recipient per
frame, and recipients are free to mint, so there was no bound at all. Nothing needed a credential:
`hello` with any fingerprint, then `send`.

**Measured**, relay in its own process, one socket, 1,200 frames at the 256 KB cap:

| | RSS before | RSS after | Socket |
|---|---|---|---|
| Relay at HEAD | 92 MB | 369 MB, still accepting | open |
| Relay fixed | 91 MB | 107 MB | closed by the relay after 84 replies |

The machine on Fly has 256 MB. The first probe of the day reported 86 MB to 979 MB, which was
wrong: it ran the attacker and the relay in one process and counted the attacker's own send
buffers. The table is the clean measurement.

**Fixed** in `packages/relay/src/server.ts`, all exported and tested:

- 32 MB total across every queue (`MAX_QUEUED_BYTES`). Refused with code `full`.
- 64 frames waiting per sender across all recipients (`MAX_QUEUED_PER_SENDER`). Refused with
  code `backlog`. A real conversation has one turn in flight.
- Queued frames expire after 6 hours (`QUEUE_TTL_MS`), swept lazily like the mailboxes. Without
  this the byte cap becomes a slow leak: frames for fingerprints that never return accumulate
  until the relay refuses everyone.
- 20 refusals and the socket is closed (`MAX_REFUSALS`). A refusal still costs a parse of up to
  256 KB, so without this a capped sender could keep the CPU busy at line rate.
- 20 mailbox puts per connection (`MBOX_MAX_PUTS`), mirroring the existing miss budget. One
  connection could previously fill all 10,000 mailboxes and stop everyone pairing for 15 minutes.
- 32 concurrent connections per client address (`MAX_CONNS_PER_IP`). Fingerprints and
  connections are free to mint, addresses are not, so this is what makes filling the byte
  budget from one box cost something. The address is `Fly-Client-IP` behind Fly and the socket
  peer elsewhere; `X-Forwarded-For` is deliberately not trusted.

Three existing tests encoded exactly the attack shape (one connection parking 500 frames, one
connection creating thousands of mailboxes) and were rewritten to use many connections.

**Residual:** an attacker with many addresses can still fill the 32 MB and hold store-and-forward
in refusal for up to six hours. Before the fix the same attacker crashed the box. The next step
is authenticated hello, below.

### 2. Every session start told the model to run a command that does not exist. Fixed.

**Claim attacked:** the SessionStart hook's directive is runnable.

**What was true:** `hooks/session-start.sh` prints, on every session start on any machine with an
identity, a directive to start a persistent Monitor of `seshi watch`, and later mentions `seshi
say`. Neither is dispatched by the CLI. On this machine, the hook was firing on every session
since the first pairing that afternoon. A test enshrined the bug by asserting the hook names
`watch`.

**Fixed:** the hook asks the CLI for its help text and stays silent unless both `seshi watch` and
`seshi say` appear in it. Verified: on this machine the hook now prints zero bytes. The test
was rewritten to run both ways, and a new one asserts silence against the CLI as it ships. Cost:
one `seshi help` invocation per session start, about 100 ms.

This is the second time today an instruction file drifted from the CLI. The skill told sessions to
run `invite`, `talk` and `join-convo`, none of which exist, and that is what stopped the other
person's side four times in a row. `test/plugin/commands.test.ts` now fails if any instruction
file names a command the dispatcher does not have.

### 3. A turn finishing inside a reconnect window was lost, and the crash left no artefact. Fixed.

**Claim attacked:** a conversation survives the relay socket dropping.

**What was true:** an idle socket through the tunnel died at 125.8 seconds (measured that
afternoon), and reconnect fired two seconds after a close. `node.send()` appended to the chain and
the log, then `#push` rejected because the socket was not open. In `runLoop` that rejection
propagated to `process.exit(1)` and `DECISION.md` was never written. The peer saw a gap, the
human saw a stack trace.

**Fixed** in `packages/daemon/src/relay-client.ts` and `packages/cli/src/index.ts`:

- A send that finds no socket waits up to 15 seconds for one, kicking the reconnect immediately
  rather than waiting for the timer. Test: knock a client off the relay, send inside the gap,
  assert delivery.
- A keepalive ping every 25 seconds, answered by the relay with `pong`. Well inside every idle
  timeout measured or documented. Test: a counting server sees pings. Against a relay that
  predates `pong` the ping draws an ignorable error and still keeps the socket alive.
- The CLI loop writes the artefact before rethrowing on any mid-conversation failure.

### 4. Rejected frames were invisible. Fixed.

**Claim attacked:** a human can tell a slow peer from a dropped turn.

**What was true:** `node.rejects` records every replayed, forked, gapped or unpaired frame, and
nothing in the CLI ever read it. A gap looked exactly like a quiet peer. The list was also
unbounded, and anyone holding an invite link knows a fingerprint and can throw garbage at it.

**Fixed:** the loop prints `! dropped a frame: <reason>` as they arrive. The list keeps the 256
newest. A daemon that throws while filing a turn (a corrupt log line, say) now produces a reject
instead of an uncaught exception inside a socket handler. Tests: a stranger floods 300 frames and
the list stays at 256, and a throwing handler yields a reject.

### 5. One side's say-so printed as a decision. Fixed.

**Claim attacked:** the "Decision" section of `DECISION.md` lists what both sides agreed.

**What was true:** `#applyLedgerView` applies any legal transition a peer declares, and
`open → proposed → agreed` is legal. A peer declaring `agreed` on its own moved the local ledger,
and the artefact printed that issue under "Decision". The footer says neither copy is
authoritative; the section people read said otherwise.

**Fixed:** an issue is a decision only when both parties' most recent ledger views call it
`agreed`. Otherwise it appears under "Still open" as `[agreed by one side only]`. The state
machine is untouched. Tests: peer-only agreement is not a decision; both-sides agreement is.

## Attacked and held

- Envelope, identity, pairing, chain: see the verdict. Attacks that failed, and why:
  - Re-sealing a signed turn to a third party. The recipient is in the signed bytes.
  - Swapping the sealing key while keeping the fingerprint. Both keys are hashed.
  - A 33-byte key. The DER length is checked.
  - Replaying a turn. The chain reports a fork.
  - Delivering a mid-conversation act as an opener. `#tryOpen` requires `BRIEF` at seq 1.
  - A peer adding or deleting a ledger issue. The local ledger is authoritative.
- Tiers: deny lists over allow lists, every shell denied, both spellings of the subagent tool,
  the peer bus stripped from the environment, symlinked `$SESHI_HOME` resolved. Nothing to add.
- Storage: every external path component validated by allow list, secrets 0600 and verified on
  read, atomic writes, single-`writeSync` appends.
- Control socket: token checked first and in constant time, unauthenticated callers answered once
  and closed, tier can be lowered but never raised over the socket.
- Peer text escaping: no angle bracket survives in any encoding, invisible and bidi characters
  stripped, stacking marks capped.

## Not changed, deliberately

- **Authenticated hello.** Still self-asserted, still documented. Anyone who knows a fingerprint
  can register as it, kick the real session off, swallow its queued frames, and now also spend
  its 64-frame sender budget. The fix is a signed challenge at connect: the relay sends a nonce,
  the client answers with both public keys and an Ed25519 signature over `nonce ‖ fingerprint`,
  the relay derives the fingerprint itself. About 60 lines across both sides plus tests, and a
  protocol change to the deployed relay, so it is the first thing to do next rather than a thing
  to slip into a review.
- **`warnAt` in the budget** is written and never read. Spec 7.5 wants the human warned; nothing
  does. Left for the budget work.
- **`getContact` returns unvalidated JSON.** A hand-edited `contact.json` with `tier: 9` reaches
  `tierSettings`, which throws. Harmless today; validate when contacts grow fields.
- **Six-hour queue TTL** means a person offline longer than that loses frames. The chain records
  the gap and the human now sees it. Raise it if real use says so.
- **The default relay** ships in the two commands as `relay.seshi.sh`. ADR 001 refuses a baked-in
  default and has not been amended. That is Jake's ruling to make, and the agents escalated the
  same clause to both humans in the afternoon's live run.

## Speed

Every fix above shortens something a person waits for, but honestly, the wall clock in a seshi
conversation is the model. Two turns of `claude -p` per exchange. A cold start plus a priming turn per
side. And the joiner's agent cannot start until the opener's first frame arrives, because the
opener chooses the conversation id. What was measurable and safe:

- Keepalive removes the reconnect-and-drain path from the normal case, so a queued turn no
  longer waits for a two-second timer plus a handshake.
- A send no longer fails during the reconnect gap, so no conversation restarts from scratch.
- The relay now refuses in constant work rather than parsing a flood, and the machine stays up.

Candidates that need a measurement before anyone touches them:

- The joiner could pre-warm its agent while waiting for the opener, saving ten to fifteen seconds
  per conversation, if the joiner chose the conversation id. Protocol change.
- The full protocol preamble is resent on every turn inside one persistent session. Context grows
  by roughly three kilobytes a turn, which slows later turns and risks compaction. Sending it
  once might be safe, or might lose the rules on compaction. Measure first.
- The mailbox poll opens a fresh TLS socket every two seconds for up to ten minutes. Correct by
  design and human-speed, but it is a TLS handshake per poll through Fly.

## Files

Changed: `packages/relay/src/server.ts`, `packages/daemon/src/relay-client.ts`,
`packages/daemon/src/node.ts`, `packages/daemon/src/conversation.ts`, `packages/cli/src/index.ts`,
`hooks/session-start.sh`, and their tests. New tests: 14. Deployed: the bounded relay to
`seshi-relay` on Fly, one machine, syd.
