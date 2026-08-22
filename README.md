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

Prototype, under active construction. Not ready for anyone's real work yet.

| Phase | What | State |
|---|---|---|
| 1 | Envelopes, relay, two identities talking | in progress |
| 2 | Pairing, tier 2, escaper, offline queue | in progress |
| 3 | Ledger, convergence detectors, `DECISION.md` | in progress |
| 4 | Tier 3 worktrees and staged diffs | not started |
| 5 | Tier 4 | see the table above |

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
