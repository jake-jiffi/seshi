## The call

Hybrid, but with a specific asymmetry that I think is the whole design: **Jake's Claude conducts the interview and writes the artefact. Nothing authored by Dave ever lands on Jake's disk as a file.**

Ranking the four options against the evidence:

- **Dave exports a distilled SKILL.md.** Rejected as the primary path. It forces Dave to do work before he knows what Jake is missing, it produces a task-level artefact which arXiv:2608.20274 shows is the representation most likely to drop the receiver below its no-memory baseline, it makes the review gate a full third-party skill audit against an ecosystem where 13.4% of files carry critical flaws, and it collides with the constraint that Dave may not want to hand over his skill at all.
- **Raw context dump.** Rejected outright. Maximum privacy leak, maximum injection surface, minimum distillation.
- **Interview only.** Rejected alone, because self-report is unfaithful (Lanham et al.; arXiv:2503.08679). Dave's Claude will produce a confident, coherent, possibly fictional account of its own method.
- **Interview to find the gap, then a targeted artefact.** Taken, with the author flipped to Jake's side and a read-back loop added to fix the faithfulness problem.

Why flipping the author matters. It answers Dave's IP concern for free, because he never hands over anything. It sizes the artefact to Jake's actual gap rather than to Dave's idea of a complete skill. It changes the review gate from "audit a stranger's file" to "review your own agent's write-up plus the transcript that produced it", which is a job Jake can actually do. And it means the only bytes crossing the wire are conversational turns plus quoted excerpts, so the transport stays dumb and the trust model stays simple.

## The protocol

Seven phases. Phases 2 to 5 are the loop.

**1. SCOPE.** Jake's Claude states the gap out loud before any question is asked: what it already knows (it can read `~/.claude/projects/-Users-you-Documents--Product-Builds-2d-to-3d/memory/MEMORY.md`, which already has the millimetre convention and the Gemini-to-Tripo pipeline), what it thinks it is missing, and what a good outcome looks like. Dave's Claude replies with a scope offer: what it is willing to teach and what it is holding back. Both are written into `session.json` and shown to both humans. Getting the holdback declared up front, instead of discovered by refusal halfway through, is the thing that keeps this from feeling like extraction.

**2. INTERVIEW.** Jake's Claude drives. Three mandatory question classes, from the evidence:

- *Anchor questions.* Every method claim must be pinned to something concrete: a named artefact Dave's Claude can quote, or a specific past instance. Unanchored claims get tagged `unanchored` and carry that tag all the way to the final file. This is the mitigation for post-hoc rationalisation.
- *Failure questions.* "What did you try that did not work, and how did you know it was not working." This is the ExpeL result and it is where the tacit knowledge lives. A distilled SKILL.md almost never contains it, which is a large part of why distilled skills cargo-cult.
- *Boundary questions.* "When does this approach stop applying." Specificity and abstractness only predict transfer jointly (arXiv:2608.20274), so an artefact without stated boundaries is one that will fire in the wrong situations.

Dave's Claude may quote excerpts inline, capped and rendered in the transcript as untrusted quoted content. It never sends a file.

**3. DRAFT.** Jake's Claude writes into `draft/`, in the house memory shape already used on this machine (frontmatter with name, description, metadata.node_type, metadata.type; `[[wikilinks]]`; one file per idea) plus a seshi provenance block:

```yaml
seshi:
  learned_from: dave
  session: <id>
  session_date: 2026-08-23
  transcript: ~/.claude/seshi/sessions/<id>/transcript.jsonl
  anchored: [claim-1, claim-3]
  unanchored: [claim-2]
  read_back: pending
  acceptance_test: pending
```

Granularity rule, straight from the negative result: write sub-task principles, not one task-level skill. Four small anchored files beat one confident big one.

**4. READ-BACK.** The draft goes back over the wire as text for Dave's Claude to correct. This is the faithfulness gate. Dave's Claude marks each claim `correct`, `wrong`, or `right words, wrong reason`, and the third category is the valuable one because it is precisely surface form captured without the reasoning. Dave's human sees this too, and it is the moment where he confirms nothing he wanted held back has leaked into Jake's write-up.

**5. VERIFY.** Every draft carries an acceptance test: one concrete task with an expected outcome, agreed in the session, that Jake's Claude runs locally before anything is promoted. This is the Voyager self-verification step, and without it the whole pipeline is unfalsifiable. A draft that cannot express an acceptance test is a signal the transfer did not actually happen, and should be said out loud rather than papered over.

**6. QUARANTINE.** Nothing installs at session end. Received material sits in `inbox/`, drafts in `draft/`, neither on any skills search path.

**7. PROMOTE.** A separate, explicit human act.

## On-disk layout

```
~/.claude/seshi/
  contacts/dave.json                    # trust tier, key, relationship pointer
  relationships/dave.md                 # cross-session memory, origin-tagged
  sessions/<id>/
    session.json                        # mode, goal, values, scope offer, state
    transcript.jsonl                    # append-only, both sides, resumable
    scratchpad.md                       # the shared working surface from (e)
    inbox/                              # received excerpts, quarantined, never loaded
    draft/                              # Jake's Claude's write-up
    verify/                             # acceptance test and its result
```

Resumability (f) falls out of `transcript.jsonl` plus `session.json`. Relationship memory (e) is `relationships/dave.md`, written in the house convention, with every line origin-tagged as an assertion by Dave's Claude on a date rather than as fact. That tagging has to be structural, because the multi-agent memory literature is clear that downstream agents inherit shared memory as ground truth and have no channel to signal error.

## The consent and review gate

**Quarantine rules for `inbox/`, adopted verbatim from Claude Code's own shared-memory-skill handling** (bundle offset 93712162):

1. Capability frontmatter (`allowed-tools`, `hooks`, `model`, `shell`) ignored.
2. Inline shell (`!` commands) does not run.
3. Symlinked files not loaded.
4. Any `SKILL.md` over 128KB skipped.
5. Additionally, and this is seshi's own: `inbox/` is never on a skills search path, and its contents are read only through a wrapper that labels them as untrusted third-party text.

**What Jake sees before anything lands.** A `/seshi accept` review screen with five panes:

1. **The artefact**, rendered, with anchored claims and unanchored claims visually separated.
2. **The description field**, called out on its own, because it goes into every future session's system prompt whether the skill is ever invoked or not. This is the pane people would otherwise skim.
3. **Provenance**: which session, which turns produced each claim, deep-linked into the transcript so Jake can read the actual exchange rather than trusting the summary.
4. **The read-back result** from Dave's side, including anything he marked wrong or right-words-wrong-reason.
5. **The acceptance test and its result**, run locally, before promotion.

Plus a **hygiene bar** that normalises the text and flags what a human diff-read misses: base64 blobs, Unicode homoglyphs and zero-width characters, any URL, any imperative aimed at the agent rather than at the reader ("run", "install", "ignore previous", "disable"), and any reference to a script or file path. Every one of those is a documented ToxicSkills pattern and none of them is legible in a rendered diff.

**Where it lands on accept.** `~/.claude/skills/<name>/SKILL.md`, installed with `skillOverrides: {"<name>": "user-invocable-only"}` so the model cannot auto-trigger it. Jake invokes it deliberately a few times, sees it behave, then promotes it to auto-trigger. That is a real mechanism in 2.1.239, not a proposal. The durable end state for anything that proves itself is a PR into `jiffi-claude-plugins`, which already exists and already has CI.

## Trust tiers

Mapping (i) onto this, with one deliberate deviation:

- **Tier 1, words only.** No `inbox/`. Excerpts inline in the transcript, capped. Draft and promote still available, because the artefact is Jake's Claude's own writing.
- **Tier 2, plus local read-only.** Jake's Claude may read Jake's files to answer Dave's Claude's questions. Symmetric teaching becomes possible. Still nothing installs.
- **Tier 3, plus propose writes.** Dave's Claude may propose specific edits into `draft/`. Promotion still requires Jake at the review screen.
- **Tier 4, full agency.** Pre-approved promotion into one named directory, still logged, still hygiene-barred, still acceptance-tested.

**The deviation, and I want to flag it rather than bury it: even tier 4 should not auto-install skills.** A skill's description is a permanent injection into every future session's system prompt, and skills can reference scripts. Tier 4 should raise the ceiling on what Dave's Claude can *read* and *draft*, not on what can silently become part of how Jake's agent thinks. If Jake wants tier 4 to mean genuinely everything, the honest version is auto-promotion with a notification and a one-click undo, and a hard carve-out for anything touching hooks, settings or MCP config.

## Modes

Yes, declare the mode up front, in `session.json`, before the first turn. It is the cheapest possible alignment device and it sets four things that otherwise get negotiated badly mid-session.

| | TEACH | DECIDE | BUILD | REVIEW |
|---|---|---|---|---|
| Symmetry | Asymmetric, one learner one source | Symmetric advocates | Symmetric producers | Asymmetric, author and critic |
| Turn taking | Learner drives, source responds | Strict alternation, neither speaks twice | Free, claim a work item before starting | Critic drives, author responds |
| Convergence signal | Learner can restate the method in its own words and pass the acceptance test | Both advocates state the same decision and can name what their side gave up | Both artefacts exist and are cross-read | Critic has no open findings, or open findings are explicitly accepted by the author |
| Artefact | Draft files in the learner's `draft/`, one per sub-task principle | One decision record, both positions and the tradeoff recorded | Two sets of files plus a joint integration note | A findings list with dispositions |
| Escalation to humans | Source declines to answer, or acceptance test fails twice | Genuine deadlock after both have moved at least once | Merge conflict of intent, not of text | Author rejects a finding the critic will not drop |
| Scratchpad role | Running list of open questions and unanchored claims | Running list of agreed points and live disagreements | Shared work-item board | Findings register |

The most important per-mode difference is the termination test, because (g) says the Claudes end it themselves and escalate only after genuinely trying. "Genuinely trying" needs a mode-specific definition or it collapses into whoever gets bored first. TEACH ends on a demonstration, not on agreement, which is a genuinely different bar from the other three and the reason it deserves its own mode rather than being DECIDE with a nicer label.

Two mode notes. Sessions should be able to change mode mid-flight, logged as an event, because a TEACH often turns into a DECIDE the moment the learner disagrees with something. And REVIEW is the mode to ship first if you want an early signal, because its artefact is small, its termination is crisp, and it does not touch the skill directory at all.

## What genuinely transfers, and what does not

Worth stating plainly, because it sets expectations for the flagship use case.

**Transfers well:** decision rules with stated boundaries; failure catalogues ("we tried X, here is how it broke"); vocabulary and the distinctions a person makes that others do not; concrete numeric conventions (2400mm walls, 110mm thickness); named references and why each one was chosen.

**Transfers poorly:** taste calibration, which is why `calm-is-not-motionless.md` needed a whole feedback cycle plus a measured failure to produce one sentence of doctrine; the judgement of when a rule stops applying; and anything whose justification is "you can see it when you look at it".

**Does not transfer and should not be attempted:** hooks, MCP config, settings, credentials, and the accumulated feel of having read a thousand outputs. Say this in the product. A TEACH session that ends with "here are four principles that survived read-back and one acceptance test that passed, and here are the three things Dave could not put into words" is a far more honest and more useful result than a shiny installed skill that quietly makes Jake's agent worse.
