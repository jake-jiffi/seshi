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
| 4 | Tier 3 worktrees and staged diffs | scaffolded, not exercised |
| 5 | Tier 4 | see the table above |

229 tests. Typecheck clean. Node 24 runs the TypeScript directly, so there is no build step.

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

### Known gaps, stated plainly

- **Agents under-use the ledger.** They argue well in prose and forget to move issues, so
  convergence detection is starved. The protocol asks for it; the models mostly do not comply. This
  is the biggest open problem and it is a prompt-and-protocol problem, not a plumbing one.
- **The relay's `hello` is unauthenticated.** A client asserts its own fingerprint. It cannot read
  anyone's mail (that needs the private key) and cannot forge a frame (signatures are verified at
  the receiver), but it could squat a fingerprint and swallow queued frames. Fix is a signed
  challenge at connect.
- **Pairing is a public-key bundle, not a spoken code.** Safety words are the real MITM defence, as
  in Signal and SSH. A short three-word code backed by a PAKE is a UX improvement over this, and is
  phase 2 proper.
- **Tier 3 is generated but not exercised.** The worktree and staged-diff path has no test.
- **No outbound secret scanning yet.** Tiers 2 and 3 deny `Bash` and deny reads of `.env`, `~/.ssh`,
  `~/.aws` and friends, so the residual risk is an agent paraphrasing something confidential it
  legitimately read. That hole is real and documented rather than papered over.

## Quickstart

Three terminals, one machine, to see it work:

```bash
npm install

# terminal 1 — the relay
node packages/cli/src/index.ts relay 8787

# terminal 2 — you
export SESHI_RELAY=ws://127.0.0.1:8787 SESHI_HOME=~/.seshi-jake SESHI_NAME=jake
node packages/cli/src/index.ts init
node packages/cli/src/index.ts invite        # copy the seshi1_... line

# terminal 3 — them
export SESHI_RELAY=ws://127.0.0.1:8787 SESHI_HOME=~/.seshi-dave SESHI_NAME=dave
node packages/cli/src/index.ts init
node packages/cli/src/index.ts pair seshi1_...   # prints four safety words
```

Both sides must see the same four words. Then `seshi verify <name>`, `seshi tier <name> 2`, and
`seshi talk <name> decide "the thing you disagree about"`.

To run the two-real-models test:

```bash
SESHI_LIVE=1 node --test test/e2e/live-conversation.test.ts
```

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
