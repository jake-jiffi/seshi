## 1. THE SCRATCHPAD: append-only per-author log, derived document

**Recommendation: two local mirrors of an append-only structured log, one file per author, reconciled by anti-entropy. Not a CRDT. Not a single shared document.**

Each party owns exactly one append-only file it alone writes. Both parties hold a copy of both files. The human-readable scratchpad is a pure function of the union of those files, regenerated on every append.

### Entry shape

Each line of `log/<party-id>.jsonl`:

```json
{"seq":41,"party":"jake","lamport":118,"ts":"2026-08-23T02:11:04.221Z",
 "prev":"sha256:9f3c…","id":"jake/41",
 "kind":"issue.claim","refs":["dave/29"],
 "body":{"issue":"i-07","stance":"…"},
 "vis":"shared"}
```

- `seq` — per-author monotonic counter. Gaps are detectable; that is the whole backfill protocol.
- `lamport` — max(seen lamport)+1 on every append. Gives causal order across authors.
- `prev` — sha256 of the previous entry from the same author. A hash chain per author, so a relay cannot silently truncate or reorder your history without detection. This matters because the relay is untrusted.
- `refs` — explicit causal edges (this entry answers that one). Mirrors Claude Code's own `parentUuid` in its transcript JSONL.
- `vis` — `shared` | `local`. Local entries are the agent's own working notes, never transmitted, and excluded from the derived shared view but included in your own.

### Consistency model, stated honestly

**Per-author total order, cross-author causal order, eventual convergence of the log; no cross-author linearisability and no atomic multi-entry transactions.**

Concretely: if Jake's Claude and Dave's Claude both claim issue i-07 in the same second, both claims are real, both land, and neither is lost. The derived view renders it as a contested claim. Deterministic tie-break at the semantic layer, not the storage layer: lower `lamport`, then lexicographically lower `party` wins the claim; the loser's entry stays in the log as a visible superseded claim and the losing agent is told. That is one rule, in one place, that a human can read.

The derived document is deterministic: sort all `vis:shared` entries by `(lamport, party, seq)` and fold. Identical logs produce byte-identical `SCRATCHPAD.md` on both machines. That is the convergence guarantee, and it is stronger than "the text merged without crashing".

### Reconnection / anti-entropy (this is the whole sync protocol)

On connect, and on every N-th message:

1. Each side sends `{"jake":41,"dave":29}` — its highest contiguous seq per author.
2. Each side replies with every entry the other is missing.
3. Verify the hash chain on receipt. A break means the relay tampered or a party rewrote history; halt and escalate to the human.

Entries are immutable, so there is no merge step. This is correct under arbitrary reordering, duplication and loss, which is exactly what the transport gives you (`send-uncertain` is a literal return value in the host binary). Retraction is a `retract` entry referencing an id, never a deletion.

### Why not Yjs

Yjs is the only CRDT that clears the size bar (2.3MB, one dep, 8M downloads/week — genuinely mature). The objection is semantic, not operational:

- The workload is discrete structured appends by two turn-taking authors, roughly one every 30 seconds. The concurrent-editing problem CRDTs exist to solve does not occur.
- Where genuine concurrency does occur, it is *semantic* (both claimed the same issue), and Yjs converges the characters while leaving the meaning incoherent. A log surfaces it.
- A Y.Doc update stream is an opaque binary. `git diff` on it is nothing. `grep` on it is nothing. A human cannot audit what their Claude sent by reading it. For a tool whose entire value proposition is that a human can watch and step in (g), that is disqualifying.
- Loading a CRDT means the agent reads a materialised doc but cannot cheaply answer "who said what, when, and in response to what". The log answers that by construction.

Yjs buys convergence-without-coordination for a coordination problem that does not exist here, at the cost of auditability that is the product's core promise. Take the log.

### Survival and resumability

Nothing lives in session memory. Everything is on disk under `~/.claude/seshi/sessions/<seshi-id>/`, keyed by a seshi id, **not** by Claude Code pid or sessionId — those churn (the session registry is `~/.claude/sessions/<pid>.json`, and pids die). Resuming is: read `session.json`, read the logs, regenerate `SCRATCHPAD.md`, feed the agent the derived doc plus the last ~20 entries, send a vector clock to the peer. Cold resume a month later works identically because the log is the truth and the transport is stateless.

## 2. FILE LAYOUT

```
~/.claude/seshi/
  config.json                        # party id, display name, default trust tier
  contacts/
    dave-<fingerprint8>/
      contact.json                   # id, name, pubkey, trust tier, memory: on|off
      MEMORY.md                      # index, same format as project memory
      observed/                      # what Dave SAID. provenance-linked. quotable.
        dave-nonnegotiable-topology.md
        dave-taught-uv-unwrap-heuristic.md
      working/                       # my Claude's own notes on how to work with him
        how-dave-claude-argues.md
      nda-terms.txt                  # per-contact outbound denylist (see §5)
      sessions.jsonl                 # one line per past seshi: id, dates, outcome
  sessions/
    2026-08-23-2d3d-shading/
      session.json                   # goal, values, parties, state, trust tier, created/updated
      briefs/
        jake.md                      # my brief (mine to write)
        dave.md                      # their brief, received verbatim, never edited locally
      log/
        jake.jsonl                   # I append only here
        dave.jsonl                   # received entries, verified, append only
      SCRATCHPAD.md                  # DERIVED. regenerated on append. never hand-edited.
      ledger.json                    # DERIVED. open-issue state, for the convergence metric
      artefacts/
        inbound/                     # files Dave's side shared, quarantined, read-only
        outbound/                    # files I shared, exact bytes sent, for audit
        produced/                    # things the two agents made together
      outbound-pending.jsonl         # blocked by filter, awaiting human approval
      audit.jsonl                    # every outbound: verdict, manifest match, bytes, hash
<project>/.seshi/share.yaml          # the share manifest. IN THE REPO. reviewable in a PR.
```

### `SCRATCHPAD.md` (derived, this is what both humans and both agents read)

```markdown
# Seshi: 2D-to-3D shading conventions
Status: converging · Open 3 · Claimed 1 · Proposed 2 · Agreed 7 · Parked 2
Last entry: dave/31 · 2026-08-23T02:14Z

## Briefs
Jake: [briefs/jake.md] · Dave: [briefs/dave.md]

## Open issues (must reach 0)
- i-07 [claimed:dave] Normal-map handedness convention   ← jake/38, dave/29
- i-09 [open]         Whether to bake AO into albedo     ← jake/41
- i-11 [proposed]     Naming for LOD tiers               ← dave/31 awaiting jake

## Agreed
- d-01 Metric units throughout. (jake/12 ← dave/09) 2026-08-23T01:40Z
- d-03 Dave's edge-flow heuristic adopted for hard-surface. (dave/17) TAUGHT→jake

## Parked
- p-01 Real-time vs offline renderer split. Reason: needs Jake's client input.

## Artefacts
- produced/shading-conventions-v1.md (jake/40, dave/30 co-signed)

## Transcript
[log/, 71 entries. Rendered on request.]
```

The status line is the convergence metric and it makes termination (g) checkable rather than vibes: **done requires open+claimed+proposed = 0 and a `done.propose` from both parties.** Deadlock is mechanically detectable too — the ledger has not shrunk in K exchanges — which is exactly the "genuinely tried" gate before escalating to the humans.

### The open-issues ledger state machine

`open → claimed → proposed → agreed | parked | escalated`

Every transition is a log entry. An issue can only be closed by `agreed` (both parties reference it), `parked` (with a stated reason and an owner), or `escalated` (to the humans, with both positions stated). An agent may not delete an issue. This is what forces the conversation to converge instead of drifting, and it is the difference between a scratchpad and a chat log.

## 3. RELATIONSHIP MEMORY

Lives at `~/.claude/seshi/contacts/<contact-id>/`, **not** under `~/.claude/projects/<slug>/memory/`. The project store is keyed by cwd (120 such slugs on this machine, one of them for this scratchpad's temp dir) — a contact is not a directory. The project memory instead gets one pointer file: `contact_dave.md` → "seshi contact dave-a91f3c2e; see ~/.claude/seshi/contacts/…".

Reuse the on-machine format exactly, with added provenance:

```markdown
---
name: dave-taught-uv-unwrap-heuristic
description: Dave's rule for seam placement on hard-surface, taught 2026-08-23
metadata:
  node_type: memory
  type: contact
  contact: dave-a91f3c2e
  class: observed
  source: seshi:2026-08-23-2d3d-shading#dave/17
  quoted: true
  modified: 2026-08-23T02:11:04Z
---

Dave's rule: seams follow the silhouette break, not the material break…

**Why:** stated in the shading-conventions session when we disagreed about AO baking.
**How to apply:** use it for hard-surface. He explicitly did NOT claim it for organics.
```

Two classes, and the split is the whole privacy design:

- **`observed/`** — things Dave or Dave's Claude actually said, with a `source` pointing at a specific log entry, so any claim is checkable against the transcript. Domain strengths (as he stated them), non-negotiables (as he stated them), decisions and their later outcomes, and — critically for the flagship teaching use case — a **taught-ledger**: what has been transferred in each direction, so next month's session opens with "we already covered edge flow, start from the organics gap" instead of re-teaching.
- **`working/`** — your Claude's own notes for working with him: how his Claude argues, where it goes rigid, what unblocks it. This is the useful stuff and it is also the dossier-shaped stuff. It is capped (I would say 10 files), expires after 180 days or 3 idle sessions unless promoted, and it is never transmitted.

Unresolved disagreements live in the *session* as `escalated`/`parked`, and are only promoted to contact memory as an `observed` fact if they recur across two sessions. One-off friction is not a personality trait.

## 4. PRIVACY — the position

**Take the strict default: seshi records only what was said, never what was inferred, and memory is OFF for a new contact until the human turns it on.**

Five rules:

1. **Provenance or it does not get written.** Every `observed` fact carries a `source:` pointing at a log entry, and `quoted: true` when it is a paraphrase of a specific statement. If your Claude cannot cite where Dave said it, it does not go in `observed/`. This single rule kills the dossier problem for the shared half of the store, because everything in it is something Dave said to you, on purpose, in a session he was in.
2. **Inferences are quarantined and mortal.** Character judgements ("Dave gets defensive about topology") are strategy, not fact. They go in `working/`, are never transmitted, are capped, and expire. They are not deleted on a timer to be coy — they expire because a year-old read on how someone argues is usually wrong anyway.
3. **Symmetric on request, not symmetric by default.** `/seshi memory show dave` renders your `observed/` store exactly as it would be sent, and the protocol carries a `memory.request` message. Answering is voluntary; **refusing is visible to the other side.** Do not force mutual mirroring — that pushes the honest notes into a private file outside seshi and you lose the audit trail entirely. Make disclosure cheap and refusal legible. `working/` is explicitly out of scope for disclosure and both sides are told that up front, once, in plain words. A privacy model that lies about what it covers is worse than a narrow one that does not.
4. **Third parties are never contact facts.** Dave's employer, Dave's clients, their numbers: these may appear in a session log (scoped, deletable, `/seshi purge <session>` removes it) but must never be promoted into `contacts/`. A hard write-time check against a third-party-entity list, plus the `nda-terms.txt` denylist doing double duty on the inbound side. This is the rule that stops relationship memory becoming a slow-accreting file on Dave's employer that outlives the project.
5. **Retention.** `observed` kept indefinitely (it is provenance-linked and disclosable, so indefinite is defensible). `working` 180 days. Session logs 12 months then archive-or-purge prompt. Both sides see a retention line in the join handshake.

**On open source pairing strangers:** memory defaults OFF for any contact not manually promoted, trust tier defaults to 1 (words only), and first contact shows both humans a one-screen statement of what the other side will retain — generated from the actual config, not from a template, so it cannot drift from behaviour. The moment this pairs strangers, "my AI keeps notes on you" stops being a feature and becomes something you need consent for, and the consent has to be shown at the point of contact rather than buried in a README. I would also ship `/seshi forget <contact>` as a first-class command with a tested purge path, because the first support request from a stranger pairing will be exactly that.

## 5. LEAK PREVENTION — make (d) structural, not aspirational

The failure mode to design against is not the agent maliciously exfiltrating. It is the agent being *helpful*: Dave's Claude asks a good question, Jake's Claude has a file open that answers it, and it paraphrases. Paraphrasing an NDA document is still a breach, and no secret scanner catches it. So the mechanism has to be structural.

**Five layers, in order of load-bearing:**

**1. No raw path to the wire (the actual mechanism).** The agent has exactly one outbound tool:

```
seshi_send(text, attachments?: [{path, reason}], cite?: [entry_id])
```

There is no other way to transmit. `attachments[].path` is resolved against the manifest and refused if unmatched — the agent cannot inline file contents into `text` as a workaround because layer 3 scans `text` too, and because sharing a file is a *verb with an audit record*, not a paste. Attaching requires a `reason` string that lands in the log, which makes the agent state its case and gives the human something to review.

**2. Declared-shareable manifest, default deny.** `<project>/.seshi/share.yaml`, in the repo, reviewable in a PR:

```yaml
contacts:
  dave-a91f3c2e:
    tier: 2
    share:
      - docs/shading/**.md
      - src/geometry/*.ts
    never:
      - "**/.env*"
      - clients/**
      - "**/*credential*"
```

`never` beats `share` always. Nothing outside `share` is attachable at any tier. Tier 4 ("full agency", from (i)) widens the manifest; it does not bypass it — otherwise the trust tiers are just a label.

**3. Outbound scanner on everything, including inline text.** `@secretlint/node` 13.0.4 with `secretlint-rule-preset-recommend` (~690KB total, verified on npm today, no shell binary needed since gitleaks/trufflehog are not installed here). Plus a Shannon-entropy pass for high-entropy tokens the preset misses. Block on high confidence, hold-for-human on heuristic. This is the *last* net and should be described as such internally, or people will over-trust it — it catches API keys, it will never catch a client's margin.

**4. Per-contact NDA term denylist.** `contacts/<id>/nda-terms.txt`: client names, project codenames, unreleased product names. Any outbound message containing one is held, not rewritten — an auto-redacting filter teaches the agent to route around it. Populated by the human at contact setup and appended whenever a hold fires.

**5. The refusal rule, which closes the paraphrase hole.** When the remote asks for something outside the manifest, the local agent must emit `share.refuse` naming what it cannot share and why. It must not answer from the unshareable material in its own words. Say this as an explicit rule in the seshi system prompt, and make the refusal a first-class log entry so the human can see the shape of what was asked for over time — a counterpart repeatedly probing the edge of the manifest is a signal worth surfacing.

**Everything blocked goes to `outbound-pending.jsonl` and surfaces in the CLI for approval. Nothing is silently dropped and nothing is silently sent.** Every send writes to `audit.jsonl` with scanner verdict, manifest rule matched, byte count and content hash, so "what did we ever send Dave" is one grep, in perpetuity. Given (j) — everything stays local — that audit file is the only thing standing between Jake and an unanswerable question from a client, so treat it as the highest-integrity file in the system: append-only, hash-chained like the log.
