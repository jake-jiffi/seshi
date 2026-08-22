# seshi — design

Two different people's Claude Code sessions, talking to each other, so the humans stop couriering
documents between them.

Status: design approved for prototype. Grounded in three research rounds (16 agents, 3 adversarial
passes) recorded in `docs/research/`.

---

## 1. The problem, in Jake's words

> "My mate Dave and I are working on a skill that helps build 2d-to-3d. I have some things that are
> awesome, he does too, and he's trained his AI on specific things. I just really wanted a bridge so
> my AI could talk to his AI to get taught their way of thinking."

> "It's like 2 or more people that you would send into a room to figure it out because they represent
> you so well."

The unit of value is not a message. It is a **decision or a transferred understanding**, reached by
two advocates who each carry their own person's context, with both humans watching.

## 2. Constraints

| # | Constraint | Source |
|---|---|---|
| C1 | **No API usage.** Each side thinks on its own subscription-authenticated session, with full local knowledge (skills, MCPs, CLAUDE.md, memory). | Jake, hard |
| C2 | Per-peer trust tiers, set per contact. | Jake |
| C3 | Human watches live, can interrupt; interjections go to both sides; both humans pinged when stuck. | Jake |
| C4 | Realtime when both online, queued when not. | Jake |
| C5 | Four modes with different done-conditions: teach, decide, build, review. | Jake, approved |
| C6 | Pairing feels like AirDrop. No accounts, no website. | Jake |
| C7 | Open source. Strangers install it, so the trust model must be real. | Jake |
| C8 | Sessions resume weeks later. | Jake |

**C1 is the one that kills branches.** Verified on this machine: `claude -p` runs on the subscription
with `apiKeySource = none`, loads 162 tools, 191 skills, 18 MCP servers and the project memory dir.
`--bare` cannot read OAuth at all and is therefore disqualified from every seshi code path.

## 3. What we do not build, and why

Three plausible designs were killed by evidence. Recording them so nobody re-proposes them.

**Peer-bus impersonation.** A process can write `~/.claude/sessions/<pid>.json`, serve a socket, and
Claude Code will deliver its messages to a real session. We proved it: a process named
`SESHI-IMPOSTOR` delivered into this very session, mid-turn. Inbound auth is Windows-only
(`authRequired = t.requireAuth ?? ati()`, `ati()` returns true only on Windows) and there is no peer
allowlist. It still loses:

- The bus is same-uid, same-machine by construction. It cannot cross the boundary seshi exists to
  cross, so every hard part remains unbuilt.
- The whole inbox sits behind `CLAUDE_CODE_HARBOR_KITE` / `tengu_harbor_kite`, which **defaults to
  false**. Jake sees peers because the flag is on for him. A stranger cloning the repo sees nothing.
- `verifiedPeerPid` occurrences went 9 → 9 → 12 across 2.1.231/235/239 while every other peer symbol
  stayed flat. That path is being actively hardened.

**Peer-to-peer NAT traversal (iroh, libp2p).** Refuted. Hole punching buys ~40ms on a 5-to-30-second
LLM turn. The cited 70% for libp2p is a conditional rate whose prerequisites fail 29% of the time, so
from cold it is roughly a coin flip (IMC '26, 4.43M attempts). `@number0/iroh` has no
`darwin-x64` build, so every Intel Mac fails to install. Its JS bindings went 11.5 months without a
release. `iroh-relay` ≤1.0.1 had a pre-auth remote crash. And iroh has no store-and-forward, which is
half of C4. Decisive: Anthropic solved this exact problem in this exact binary and chose
`wss://bridge.claudeusercontent.com` with a `LOCAL_BRIDGE` override, not P2P.

**Tier 4, full agency both ways.** Not in v1, and probably not in v2. The threat model is not "my
friend is malicious", it is "my friend's Claude read a poisoned README an hour ago". Tier 4
instantiates untrusted input, private data and external communication on both machines at once. The
marginal value over tier 3 is a patch a human applies in five seconds.

## 4. Architecture

Five components.

```
  Jake's machine                                      Dave's machine
  ─────────────────                                   ─────────────────
  Jake's real session                                 Dave's real session
    │  /seshi @dave "..."          ┌──────────┐          │
    │  ▲ Monitor stream            │  relay   │          ▲ │
    ▼  │                           │  wss:443 │          │ ▼
  ┌─────────────┐   envelope       │          │   envelope   ┌─────────────┐
  │   seshid    │ ───ciphertext──▶ │ forwards │ ◀────────────│   seshid    │
  │             │ ◀──────────────  │ + queues │ ─────────────▶             │
  └──────┬──────┘                  └──────────┘              └──────┬──────┘
         │ stdin/stdout (stream-json)                               │
         ▼                                                          ▼
  ┌─────────────────────────┐                        ┌─────────────────────────┐
  │ peer agent              │                        │ peer agent              │
  │ claude -p               │                        │ claude -p               │
  │ --setting-sources user  │                        │ --setting-sources user  │
  │ --settings tier2.json   │                        │ --settings tier2.json   │
  └─────────────────────────┘                        └─────────────────────────┘
```

### 4.1 `seshid` — the local daemon

One per machine, spawned on demand, exits when the last client disconnects. This mirrors Claude
Code's own daemon, which explicitly disabled launchd install with the note *"the daemon runs on
demand and exits when the last client disconnects"*.

Owns: identity keypair, contact book, per-peer trust tier, relay connection, offline outbox,
append-only conversation log, ledger state, peer-agent supervision, and the outbound audit trail.

It is **not a model**. It never calls Anthropic. This is what makes C1 true by construction: the only
tokens seshi spends are the tokens each person's own agent spends on its own machine.

### 4.2 `seshi-relay` — the boring middle

A WebSocket server on `wss://` 443. Authenticates two endpoints, forwards opaque ciphertext, queues
for whoever is offline. It never sees plaintext. Self-hostable as a single process; `SESHI_RELAY` is
a first-class flag, not a footnote.

Payload hard cap: 256 KB per frame, enforced at the relay. At measured Claude Code message sizes
(5,153 bytes mean over 106,820 messages), a thousand active pairs at ten sessions a month is ~25 GB,
which is a $5 VPS. The cap is what keeps it there.

### 4.3 The peer agent — one `claude -p` per conversation

```
claude -p --input-format stream-json --output-format stream-json \
  --setting-sources user \
  --settings <tier>.json \
  --session-id <stable-uuid-for-this-conversation> \
  --add-dir <scoped-dir>
```

**This is the load-bearing decision.** A `PreToolUse` hook receives `session_id` and never an
originator, so the only way a permission rule can know "Dave at tier 2 caused this tool call" is for
the process to *be* Dave-at-tier-2. Per-peer trust tiers are unenforceable any other way.

`--setting-sources user` is mandatory. Without it a hostile repo's `.claude/settings.json` can set
`disableAllHooks: true` and disarm seshi, because project settings beat user settings.

### 4.4 The Monitor bridge — how the human sees it live

Borrowed from agmsg, which solved this with a supported mechanism. A `SessionStart` hook prints plain
English at the model asking it to invoke the built-in `Monitor` tool with `persistent: true`, pointed
at `seshi watch`. That background task's stdout arrives in the human's own live session as
notifications, waking it when idle.

No impersonation, no private wire format, no feature flag. Degrades to a plain terminal pane if the
Monitor tool is unavailable.

### 4.5 The record

```
$SESHI_HOME/
  identity.json              # Ed25519 signing + X25519 sealing keys, 0600
  contacts/<fingerprint>/
    contact.json             # name, pubkeys, tier, verified-at
    memory/                  # relationship memory, provenance-linked
  convos/<convo-id>/
    convo.json               # mode, briefs (public halves), state, budget
    brief.private.json       # 0600, concession ladder, NEVER transmitted
    log/<party>.jsonl        # append-only, hash-chained, per author
    LEDGER.json              # derived, authoritative on disk
    SCRATCHPAD.md            # derived, regenerated on append
    DECISION.md              # the artefact
    audit.jsonl              # every outbound frame, hashed
```

Keyed by a durable `convo-id`, never by pid. `/tmp/cc-socks` currently holds 502 entries against 18
live sessions, which is what pid-keying gets you.

## 5. The wire protocol

One JSON envelope per turn. Signed with Ed25519, sealed to the peer's X25519 key with
XChaCha20-Poly1305. The relay sees ciphertext plus a routing header.

```jsonc
{
  "v": 1,
  "convo": "01JZ...",
  "seq": 14,
  "prev": "sha256:...",        // hash chain, per author
  "from": "ed25519:...",       // set by the RECEIVING daemon from the transport, never read from the body
  "act": "PROPOSE",
  "headline": "...",           // <= 200 chars
  "body": "...",               // <= 1200 chars, truncated by seshid, not by asking the model nicely
  "ledger": [ { "id": "i-07", "state": "proposed" } ],
  "artefact": { "diff": "...", "sha256": "..." }   // optional
}
```

**Acts:** `BRIEF ASK EVIDENCE PROPOSE COUNTER ACCEPT REJECT REFUSE CONCEDE PARK NOT_UNDERSTOOD
RED_TEAM PROPOSE_FINAL CLOSE`.

**Control frames** (wrapper-generated, do not consume a turn): `ACK STUCK HUMAN_NOTE HUMAN_RULING
BUDGET_WARN HARD_STOP PEER_OFFLINE PEER_RATE_LIMITED`.

**Turn taking is strict alternation with an explicit token.** One message, one act, at most one
blocking question. This is not style: messages drain at the receiver's next tool round, so concurrent
sends mean both agents reason on stale state. Single-writer alternation also removes the merge
problem entirely, which is why the shared artefact needs no CRDT.

### 5.1 Identity is never self-asserted

The hardest-won rule in the whole design, learned by watching our own impostor probe arrive with
`<seshi-peer from="dan" key="ed25519:FAKE">` in its body.

> A peer never authors its own identity. `from` is stamped by the **receiving** daemon from the
> authenticated transport session. Any identity field inside a message body is decoration and is
> never read for a trust decision.

A `tier_asserted` field on the wire may only make delivery **more** restrictive, never less.

## 6. The trust ladder

| Tier | What it means | Enforced by |
|---|---|---|
| 1 words only | No Claude process exists for the peer. seshid renders remote text in its own pane. If Jake wants his Claude to see it, he pastes it, and it arrives as his own words. | Process absence. Zero tool surface. |
| 2 read-only | Dedicated process. Bare-name `permissions.deny` on `Bash Write Edit NotebookEdit WebFetch WebSearch Task SendMessage ListAgents mcp__*`, plus scoped denies on `.env*`, `~/.ssh`, `~/.aws`, `~/.claude`, `$SESHI_HOME`, `*.pem`, `id_*`. | Permission rules + process boundary. |
| 3 propose writes | Tier 2 plus `Edit`/`Write` inside a throwaway `git worktree` on a `seshi/<peer>/<convo>` branch. Bash stays denied. Output is a patch and a rationale. | Permission rules, `PreToolUse` exit 2 on path escape, worktree boundary. |
| 4 full agency | Not in v1. Would need a separate OS user or container. | — |

Non-negotiable mechanics:

- **Deny beats allow at every scope**, survives `bypassPermissions`, and a `PreToolUse` hook
  returning `"allow"` cannot override it. Express tiers as deny lists, never allow lists.
- **Deny `SendMessage` and `ListAgents` in every peer process.** Without it, a peer process hops out
  of its box into the human's own live sessions on the same machine, reachable with no extra
  permission.
- Read/Edit denies do not bind subprocesses. `python -c "open('.env').read()"` walks straight past
  them. Any tier keeping Bash needs the OS sandbox with `failIfUnavailable: true`. Tier 2 and 3 deny
  Bash outright, which is why they are safe without it.
- The tier lives in a 0600 file, changed only by a human in their own terminal, re-read from disk per
  inbound message.

### 6.1 Inbound framing

Peer text is escaped before wrapping: every codepoint whose NFKD-normalised, mark-stripped form is
`<` or `>` maps to an entity; C0 controls plus U+2028/U+2029 are stripped; close tags are rewritten.
A CI fixture corpus of fullwidth, zero-width-joined and literal close-tag attacks guards it.

We reuse **Anthropic's own preamble wording** for external-channel content and permission laundering
rather than writing new prose, because it is already tuned against the model.

**Honest limit:** prompt framing gets zero security credit. Spotlighting drops static attack success
from >50% to <2%, and search-based adaptive attacks push it back above 95%. The wrapper stops lazy
attacks. The permission layer and the process boundary are the actual controls.

### 6.2 Outbound

One tool, `seshi_send(text, attachments?, cite?)`. There is no other path to the wire. Attachments
resolve against a `.seshi/share.yaml` manifest in the repo, default deny, `never` beats `share`, and
tier 3 widens the manifest rather than bypassing it. Every send is scanned (secretlint plus an
entropy pass), and everything sent is shown to the sending human before it leaves.

When asked for something outside the manifest, the agent must emit `share.refuse` naming what it
cannot share. It must not answer from the unshareable material in its own words. That closes the
paraphrase hole, which no scanner can catch.

## 7. The conversation protocol

### 7.1 Modes

| Mode | Symmetry | Ends when | Artefact |
|---|---|---|---|
| **teach** | Learner drives, source responds | Learner restates the method and passes an acceptance test | Draft files in the learner's `draft/`, one per sub-task principle |
| **decide** | Symmetric advocates, strict alternation | Ledger empty, both RED_TEAM'd, both sign the same artefact hash | `DECISION.md` |
| **build** | Symmetric producers | Both artefacts exist and are cross-read | Files plus a joint integration note |
| **review** | Critic drives, author responds | No open findings, or open findings explicitly accepted | Findings list with dispositions |

Mode is set at creation and may change mid-flight, logged as an event. A teach often becomes a decide
the moment the learner disagrees.

### 7.2 The brief

Six fields. Four public, exchanged in full before turn one: objective, definition of done, up to
three non-negotiables **with their reasons**, and hard facts. The reason is what makes a
non-negotiable tradeable later.

Two private, never transmitted: the ranked concession ladder and the human's private notes.

Publishing walls makes convergence faster and costs nothing, because a wall the other side cannot see
just wastes twenty turns. The concession ladder is the exact opposite: its whole value is that it is
unknown, and an advocate that leaks it has stopped advocating.

On receipt both daemons compute the conflict set deterministically and seed a numbered ledger, so
turn one opens on real disagreements instead of pleasantries.

**The hard rule: an agent may propose trading one of its human's non-negotiables. Only the human can
grant one. At every tier.**

### 7.3 Convergence, four local deterministic detectors

- **Agreement** — ledger empty, RED_TEAM completed both sides, both sign the same artefact hash.
- **Deadlock** — three unchanged position fingerprints, confirmed over two consecutive rounds.
- **Looping** — ledger has not moved in four turns.
- **Degenerate agreement** — the one that matters most, because the literature says premature
  sycophantic consensus, not deadlock, is the dominant failure of LLM-to-LLM debate. Fires on a
  capitulation rate above 0.7, on any seeded conflict item reaching "agreed" without ever being
  contested, or on a RED_TEAM turn where an agent cannot name a position it gave up and what that
  cost its human.

### 7.4 The stuck ping

A wrapper control frame, fired locally on both sides, never relayed by the agents, because a wedged
agent is exactly when relay fails. Payload is one screen: the blocking issue as a question, both
positions in 25 words each, which detector fired and after how many rounds, what it blocks, and two
to four options with a recommended default plus "type your own". **Present a decision, not a
situation.**

### 7.5 Budgets

Jake does not want hard caps; he wants the agent to say what is going on. So: 24 turns with a warning
at 16, 20 minutes live or 24 hours queued, tokens and dollars published in every envelope. Measured
cost is ~$0.094 of Opus-equivalent per turn, so a 24-turn conversation is a few dollars a side.

On exhaustion, enter `WRAP`: one extra turn each, no new proposals, each side writes its final
position on every open issue, then close partial. **Never auto-agree at the buzzer**, which is the
failure mode alternating-offers protocols are famous for.

One genuine hard stop, and only one: a wall-clock ceiling when no human is present.

### 7.6 Compaction hazard

Auto-compact is on by default and time-based microcompaction clears tool results, so the ledger and
the protocol brief **will** be summarised out of context mid-negotiation. This is a silent
correctness failure, the hardest kind to catch in a demo.

Mitigation: the ledger is authoritative on disk and re-injected every turn from the daemon rather
than trusted to memory, with a `PostCompact` re-anchor. One test must run long enough to actually
compact.

## 8. Pairing

`/seshi invite dave` puts one line on the clipboard:

```
claude plugin marketplace add jiffi/seshi && \
  claude plugin install seshi@seshi --config pairing_code=7-TANDEM-VERDICT
```

Nameplate plus two words from a phonetically distinct list, the Magic Wormhole shape, because it is
proven for humans reading codes aloud. Three words for `--sensitive`.

**The code carries nothing.** It is a PAKE password, not a key and not a payload. Session id,
connection info and the shared frame all cross after pairing succeeds, under a key neither side
transmitted. So the string in Slack is not a secret that leaks, it is a secret that can be guessed
once.

- Expiry 24 hours, single use. Single use is load-bearing: it caps an attacker at one guess and makes
  a failed guess loud rather than silent.
- The mailbox dies on the first failed decryption.
- If it leaks, worst case a stranger pairs first, Dave's join fails visibly (that is the alarm), and
  the stranger is tier 1 with no exception path.
- Both humans then confirm the same four words derived from the session key. Optional at tier 1,
  a **hard gate** the first time a contact is raised to tier 2 or above.
- A known contact presenting a new key hard-fails into fresh pairing. It never warns and continues.
  A stranger claiming to be Dave-on-a-new-laptop is the one realistic social attack, so that screen
  says in words: confirm this with Dave over a different channel.

After one pairing, the contact's public key is pinned and there is no code ever again:
`/seshi @dave` just opens.

## 9. Multi-party

**v1 is strictly two-party**, as a correctness position rather than a compromise: the advocate model
has no coherent answer to "two agree, one does not", and deadlock detection breaks because
two-agreeing-one-holding looks like progress.

Five seams keep three-party a config change rather than a rewrite:

1. `participants` is an array from day one, never `peerA`/`peerB`.
2. Every message carries `from`, `to[]` and a counter, even while `to` has exactly one element.
3. The scratchpad is append-only per-author JSONL, rendered to markdown, never a shared mutable file.
4. The projection is a pure function of (brief, recipient tier) that already takes a list.
5. Invites are per-invitee. There is never a room code, at any N.

## 10. Build order

| Phase | Goal | Done when |
|---|---|---|
| **1** | "Boom, they're talking" | Two seshid instances, local relay, tier 1, envelopes flowing, both humans watching. Keys pasted by hand. |
| **2** | Pairing and tier 2 | Short code, PAKE, verification phrase, pinned contacts, tier-2 deny lists, escaper with fixture corpus, outbound scanner, offline queue. |
| **3** | The conversation protocol | Envelope acts, alternation, mirrored ledger, four detectors, `DECISION.md`, stuck ping with ruling return path. |
| **4** | Tier 3 | Throwaway worktree, staged diffs, human applies in their own session. |
| **5** | Tier 4 | Or never. Separate OS user or container, default-deny egress, enforced two-sided presence, published red-team harness. |

Each phase is independently useful. Phase 1 alone is a shared scratchpad between two people's agents.

## 11. Known risks

1. **Anthropic's consumer terms.** §3 prohibits automated access except via API key "or where we
   otherwise explicitly permit it" (the SDK support article is that carve-out). §2 prohibits making
   your account available to anyone else, and that is where tier 4 has genuine exposure. Mitigation:
   human presence is an enforced precondition, ship tiers 1 and 2 first, never build the idle-wake
   path, and put the question in the repo openly.
2. **Confidentiality across the company boundary.** Whatever seshi sends lands permanently in the
   peer's transcripts under their account and their training opt-in. Mitigation: show what is
   leaving, per message, before it leaves; default scope is personal and open-source work.
3. **The premise may not hold.** The literature says two-agent debate converges on polite agreement
   and extra rounds add nothing. The genuine asymmetry here is *different owner context*, which is
   currently an assumption. Mitigation: run the manual test — one real decision, both humans
   copy-pasting between their own sessions for twenty minutes — before trusting the automation.
4. **Cost on the friend's account.** Both sides burn their own five-hour and weekly buckets, shared
   with claude.ai. Mitigation: make the peer's spend a per-conversation consent, not something the
   invite silently commits them to.
5. **Version and model skew.** `notify_idle` does not exist before 2.1.236 and is missing from 8 of
   Jake's 18 sessions. No model field exists anywhere, so seshi cannot tell if the peer is on Opus or
   Haiku. Mitigation: negotiate protocol version in the handshake, state a minimum Claude Code
   version, read `peerFeatures` rather than assuming, validate framing against the weakest model.
6. **seshi as an exfiltration channel.** seshid's socket gives every same-uid process an outbound leg
   it did not have, including a prompt-injected session sitting on a client repo. Mitigation:
   authenticate local callers, block on the outbound scanner, and hold "everything sent is shown to
   the sender first" as a global invariant.

## 12. Open questions

Carried, not resolved. None of them block phase 1.

1. Does a session originating inside the **Claude desktop app** register in `~/.claude/sessions/`?
   All 18 entries here are `entrypoint=cli`. Thirty-second check before any desktop promise.
2. Fresh peer process, or `--resume <id> --fork-session` to give the peer agent live working context?
   Fidelity is the pitch; it is also the confidentiality problem. Ship fresh, test forked, add
   `--with-context` as an explicit opt-in that names what it shares.
3. Default hosted relay under Jake's account, or self-host only? Recommend both, default to Jake's,
   `SESHI_RELAY` first-class.
4. What does one real 24-turn conversation actually cost on both sides? Nobody has run one.

---

## Attribution

seshi borrows two mechanisms from prior art, both MIT:

- The **Monitor-tool wake** (SessionStart hook prints a directive; the model invokes `Monitor` with
  `persistent: true`) is from [`fujibee/agmsg`](https://github.com/fujibee/agmsg).
- The **relay-sees-only-ciphertext** shape is from
  [`xhluca/agent-talk`](https://github.com/xhluca/agent-talk) and its `retalk` CLI.

Both must be credited in the README and in source headers wherever code or protocol design is taken.
