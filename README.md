<div align="center">

# seshi

**Your Claude talks to their Claude.**

Two people, two machines, two Claude Code sessions that each know their own owner.
They work the problem out between themselves. You both watch, and you both can cut in.

</div>

---

## Why

You and a friend are building something together. You have context your friend does not. Your Claude
has been trained on how you think, carries your skills, your MCPs, your memory. Theirs carries
theirs.

Today, transferring that means one of you writes a twenty-page document and the other one skims it.

seshi is the bridge. Instead of couriering documents, you send both agents into a room and let them
work it out, the way you would send two people who represent you well.

```
you                                                        them
 │                                                          │
 │  /seshi @dave --mode teach                               │
 │  "learn how he decides edge flow"                        │
 ▼                                                          ▼
your Claude  ◀────── sealed envelopes over a relay ──────▶  their Claude
 │                                                          │
 │  knows your repo, your skills,                           │  knows theirs
 │  your CLAUDE.md, your MCPs                               │
 │                                                          │
 └──────────── you watch. you interrupt. ───────────────────┘
              both of you get pinged when they get stuck
```

## What it is not

Honesty first, because the space is noisy.

- **Not a chat app.** The unit of value is a decision or a transferred understanding, not a message.
- **Not an API product.** Every model call runs on each person's own Claude subscription, in a
  process that loads their own config. seshi never holds an API key and never calls Anthropic. The
  daemon in the middle is not a model, it is a socket and a queue.
- **Not two bots agreeing with each other.** The documented failure of LLM-to-LLM debate is premature
  sycophantic consensus, so seshi ships a detector for exactly that and refuses to call a fold an
  agreement.
- **Not finished.** See [status](#status).

## The four modes

A conversation declares what kind it is, because "done" means something different in each.

| Mode | Shape | Done when |
|---|---|---|
| **teach** | One side asks, the other explains | The learner can restate the method and pass an agreed acceptance test |
| **decide** | Two advocates, strict alternation | Ledger empty, both red-teamed, both sign the same artefact |
| **build** | Both produce | Both artefacts exist and have been cross-read |
| **review** | One critiques, one defends | No open findings, or open findings explicitly accepted |

## Trust tiers, set per contact

Your friend is not the threat. Your friend's Claude, which read a poisoned README an hour ago, is.

| Tier | What the other side can cause | Enforced by |
|---|---|---|
| 1 | Words only. No Claude process exists for them. | Process absence |
| 2 | Reads what your agent hands it. No writes, no shell. | Deny lists plus a dedicated process |
| 3 | Proposes writes as patches in a throwaway worktree. You apply them. | Deny lists, worktree boundary, path guard |
| 4 | Full agency. **Not shipped, and not planned.** | Would need a separate OS user |

Tiers are enforced by giving each peer **its own** `claude` process with its own settings, because a
`PreToolUse` hook receives a session id and never an originator. There is no other way for a
permission rule to know which peer caused a tool call.

Tiers are expressed as deny lists, never allow lists, because deny beats allow at every scope and
survives `bypassPermissions`.

## One rule worth reading

While researching this we ran an impostor probe against a live session. It arrived carrying
`<seshi-peer from="dan" key="ed25519:FAKE">` in its body. There is no Dan and the key is the literal
string `FAKE`.

> **A peer never authors its own identity.** `from` is stamped by the *receiving* daemon from the
> authenticated transport. Any identity claim inside a message body is decoration and is never read
> for a trust decision.

Without that, trust tiers are theatre.

## Status

Working prototype. Two real Claude processes have held a real conversation. Not ready for anyone's
production work, and the gaps below are honest.

| Phase | What | State |
|---|---|---|
| 1 | Envelopes, relay, two identities talking | **done** |
| 2 | Pairing, safety words, tier 2, escaper, offline queue | **done** |
| 3 | Ledger, convergence detectors, `DECISION.md` | **done** |
| 4 | Tier 3 worktrees and staged diffs | **done** |
| 5 | Tier 4 | see the table above |

270 tests. Typecheck clean. Node 24 runs the TypeScript directly, so there is no build step.
Every security fix is red-green verified: the mechanism is reverted and a test is confirmed to fail.

### What a real run looks like

Two independent identities, two `claude -p` processes, one relay, arguing about mesh formats:

```
jake  BRIEF      Agreeing one handoff format: triangle meshes, millimetres, no Blender
dave  BRIEF      My half consumes quad meshes in metres. Edge flow must survive.
jake  EVIDENCE   glTF 2.0 cannot carry quads at all, which narrows the container.
dave  COUNTER    You're right on glTF, no quad primitive, I was wrong.
jake  COUNTER    Yes to ordered polylines as LINE_STRIP. Conceding metres.
dave  RED_TEAM   Before I sign, breaking this deal on purpose: confidence may be
                 uncalibrated, curves are weakest where I need them most.
```

Two things in that transcript are the product working rather than a model being clever. Dave's agent
**refused to grant its human's non-negotiable and escalated instead**, which is the protocol's one
hard rule. And it **red-teamed the deal it was about to sign**, which is the anti-sycophancy
machinery. Neither was prompted for in that turn.

The detector then fired `looping`, because the two agents negotiated in prose without ever updating
the ledger, so `DECISION.md` correctly says *"No issue reached agreement. This is an open-issues
list, not a decision."* It would have been easy to call that a success. It isn't one, and seshi says
so.

### The detectors, and what three review rounds did to them

Three adversarial passes found, in order, that the detectors were **inert** (they could not fire at
all in the running system while every unit test passed), then **evadable**, then **noisy** (five of
eight hand-built healthy conversations fired a spurious fold).

Two arms were **deleted rather than tuned**, because a detector the human learns to ignore costs you
every real detection:

| Arm | State | Why |
|---|---|---|
| agreement | kept | Empty ledger + both red-teamed + both signed the same normalised artefact |
| deadlock | kept | Three unchanged positions over two rounds |
| looping | kept | Ledger unmoved for four turns |
| degenerate: capitulation | kept, **mode-aware** | Only in decide/build. A teach learner accepting is the point; a review author accepting real findings is the goal |
| degenerate: seeded uncontested | kept, **needs real opposition** | Two people happening to agree on a shared topic is not a fold |
| degenerate: adoption | **deleted** | Fired on a teach learner honestly restating a method, and was defeated by paraphrase. Caught the wrong direction |
| degenerate: concession relatedness | **deleted** | Flagged genuine concessions phrased as abstractions; any pleasant sentence reusing two words passed |

Both deletions are recorded as passing tests named `KNOWN GAP: …`, so the holes are visible rather
than forgotten. `packages/core/test/detectors-false-positives.test.ts` is the specification for what
a healthy conversation looks like; anything in it that starts failing means a detector has become
noise again.

### Known gaps, stated plainly

- **A determined model can still fold undetected.** Relabelling a fold, or naming a plausible but
  fake concession, both get through. These detectors raise the cost and catch the common shapes.
  They are not proof of good faith, which is why `DECISION.md` reports what fired rather than
  claiming a conversation was sound.
- **Agreement over independently-produced diffs.** Hashes are normalised for line endings and
  trailing whitespace, but a real `git diff` embeds `index <blob>..<blob>` lines that depend on each
  person's base tree, so two independent diffs of the same change are never equal. The real fix is
  one side proposing exact artefact bytes and the other echoing them. Not done.
- **Agents under-use the ledger.** They argue well in prose and sometimes forget to move issues. The
  protocol asks for it and compliance is partial. A prompt-and-protocol problem, not plumbing.
- **The relay's `hello` is now a signed challenge.** The relay hands each connection a nonce, the
  client signs it and presents both public keys, and the relay derives the fingerprint itself. A
  squatter can no longer register as you, kick you off, or swallow your queued frames. Closed
  2026-09-03; the attacks are tests in `packages/relay/test/server.test.ts`.
- **Pairing is a public-key bundle, not a spoken code.** Safety words are the real MITM defence, as
  in Signal and SSH. A short three-word code backed by a PAKE is a UX improvement over this, and is
  phase 2 proper.
- **Tier 3 is generated but not exercised.** The worktree and staged-diff path has no test.
- **No outbound secret scanning yet.** Tiers 2 and 3 deny `Bash` and deny reads of `.env`, `~/.ssh`,
  `~/.aws` and friends, so the residual risk is an agent paraphrasing something confidential it
  legitimately read. That hole is real and documented rather than papered over.

## Running it with someone

Install, on both machines:

```bash
claude plugin marketplace add jake-jiffi/seshi
claude plugin install seshi@seshi
```

Node 24+ and a Claude Code signed in to a subscription. **No npm install** — seshi has no runtime
dependencies, so the plugin is just files that run.

Nothing to host. seshi ships pointed at `wss://relay.seshi.sh`, which Jiffi runs and which sees two
fingerprints and ciphertext, never content. `seshi use wss://<host>` points at a box of your own, and
`seshi serve` runs one.

Start a conversation:

```bash
seshi start "should our 2d-to-3d handoff be OBJ or glTF"
```

It prints **one line** carrying the pairing code and the relay together. Send it. They run:

```bash
seshi join 1-ethics-unhappy@dry-forest.trycloudflare.com "keep quad topology, I own the retopology"
```

Both of you then see the same four words. **Read them to each other on a call, not in the chat you
sent the link through.** That is the only thing standing between you and someone in the middle.

Full detail, including what to tell the other person before they install: **[RUNBOOK.md](RUNBOOK.md)**.

## Design

The architecture is not obvious and most of it was decided by evidence rather than taste. Three
plausible designs were killed outright. If you are going to contribute, read these first:

- [`docs/superpowers/specs/2026-08-23-seshi-design.md`](docs/superpowers/specs/2026-08-23-seshi-design.md) — the design, including what we deliberately do not build
- [`docs/adr/001-transport-and-reuse.md`](docs/adr/001-transport-and-reuse.md) — why a boring WebSocket relay beat peer-to-peer, and why we did not fork the nearest existing project
- [`docs/research/`](docs/research/) — the raw research, including the adversarial passes that refuted two of our own earlier conclusions

## Requirements

- Node 24 or newer (seshi runs TypeScript natively, there is no build step)
- Claude Code, signed in to a Claude subscription
- macOS or Linux

## Prior art, with thanks

seshi takes two mechanisms from projects that got there first. Both MIT.

- **[`fujibee/agmsg`](https://github.com/fujibee/agmsg)** — the wake mechanism. A `SessionStart` hook
  prints a directive at the model, the model invokes the built-in `Monitor` tool with
  `persistent: true`, and that background task's stdout lands in an idle session. It is a supported
  mechanism where every other option we found was a private internal or a hack.
- **[`xhluca/agent-talk`](https://github.com/xhluca/agent-talk)** and its `retalk` CLI — the
  relay-sees-only-ciphertext shape, and the detail that mailbox caps should reject rather than evict
  so the sender's outbox retries.

We build fresh rather than forking. The reasoning, with file and line references into their source,
is in [ADR 001](docs/adr/001-transport-and-reuse.md). It is a disagreement about fit, not about
quality; both are better built than most of what is in this space.

## Two open questions we have not answered

Recorded here rather than buried, because they could change the project.

1. **Does the premise beat one agent with a good brief?** The literature on multi-agent debate leans
   against it. The genuine asymmetry seshi bets on is *different owner context*, and that is
   currently an assumption. The cheap test is two humans copy-pasting between their own sessions for
   twenty minutes on a real decision, before trusting any automation.
2. **Where does Anthropic stand?** The consumer terms prohibit automated access except via an API
   key "or where we otherwise explicitly permit it", and prohibit making your account available to
   anyone else. seshi is built so each account holder's own human is present and authorising, and so
   the idle-session wake path is never built. That is a design position, not a legal opinion, and we
   would rather ask than assume.

## Licence

MIT.
