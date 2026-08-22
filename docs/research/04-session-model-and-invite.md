## 1. The command surface

Five slash commands. Everything else is conversational or inferred.

| Surface | Why |
|---|---|
| `/seshi [free text]` | The front door. Bare, it prints live and recent sessions. With text ("talk to Dave about the 2d-to-3d skill"), it creates a session, infers mode and title, elicits the brief, and stops at the invite. |
| `/seshi:invite [who]` | Renders the paste block. Deliberately its own command because this is the moment Jake leaves the terminal and enters Slack. |
| `/seshi:join <code>` | Dave's whole entry point. |
| `/seshi:resume [fuzzy text]` | Finds and rehydrates. Text is optional and fuzzy: "the thing with Dave about textures". |
| `/seshi:end [why]` | Rare, because normal termination is the two agents agreeing. This is the abort. |

Frontmatter for each follows the shape verified above: `description`, `argument-hint`, `allowed-tools`. `/seshi:status` is not a command; the live state is inlined into every other command with a `!` context line, the way commit.md inlines `git status`.

**Not commands, and the argument for that.** `$ARGUMENTS` is a raw string. A flag grammar therefore buys zero parsing and costs Jake memorisation, so:

- **Goal, values, non-negotiables, what I will concede, definition of done** are elicited in ONE `AskUserQuestion` call, at most three questions, each pre-filled with a recommendation inferred from the sentence Jake already typed and from contact memory. Everything not asked is inferred and shown back for correction, not asked for.
- **Trust tier** is a property of the contact, not the session, per (i). Asked once, on first pairing, in the same call. On every later session it is a single line on the confirmation screen ("Dave is tier 2: he can read what I hand him, he cannot write"), correctable in words.
- **Interject** has no command at all. While a seshi session is live and focused, anything Jake types is an interjection and goes to both sides, per (g). A command here would be the single largest ceremony tax in the product, because interjection is the thing that happens most.
- **Budget** is never set, per (h). The agent narrates: "we are 40 turns in, still circling on the rigging step, want me to push for a decision or park it?"

Mode is inferred from the verb in Jake's sentence and confirmed in the same one screen. "get taught" or "learn" gives teach, "agree", "decide" or "settle" gives decide, "build" or "spec" gives build, "review" or "check" gives review. Mode matters because it sets the default disclosure policy (below), not because it changes the protocol.

## 2. The session object

Directory per session, mirroring the teams layout found on disk:

```
~/.claude/seshi/
  index.json                      # rebuildable cache for discovery
  contacts/<contact-id>.json      # device keys, tier, aliases
  contacts/<contact-id>.md        # relationship memory, human readable
  sessions/<ulid>/
    session.json                  # MIRRORED. both sides converge on this
    brief.private.json            # mode 600. never transmitted, ever
    projection.json               # exactly what was disclosed, per recipient
    scratchpad.jsonl              # append only, author + counter per entry
    scratchpad.md                 # rendered view for humans
    transcript.jsonl              # every agent turn, local mirror
    digest.md                     # compacted, this is what resume loads
    artefacts/                    # files the two agents produced together
```

`session.json` (mirrored, both sides hold an identical copy):

```json
{
  "id": "01JZ...",              "slug": "dave-2d-to-3d",
  "title": "2d-to-3d skill: Dave's approach to topology",
  "mode": "teach",
  "state": "live",               // draft|invited|live|parked|deadlocked|closed
  "createdAt": "...", "updatedAt": "...",
  "participants": [
    { "contactId": "self", "displayName": "Jake", "deviceKey": "ed25519:...",
      "joinedAt": "...",
      "trust": { "iGrantThem": 2, "theyGrantMe": null } }
  ],
  "sharedFrame": {
    "objective": "...",          // the ONE line both sides agreed the session is about
    "definitionOfDone": ["..."],
    "declaredNonNegotiables": { "jake": ["..."], "dave": ["..."] },
    "openQuestions": ["..."]
  },
  "budgetSignals": { "turns": 41, "wallClockMs": 900000, "lastNarratedAtTurn": 30 },
  "artefacts": [{ "path": "artefacts/topology-rules.md", "author": "dave", "acceptedBy": ["jake"] }],
  "terminal": null               // {outcome, agreedAt, escalatedToHumansAt, reason}
}
```

`brief.private.json` (never leaves the machine):

```json
{
  "objective": "...", "whyItMatters": "...",
  "constraints": ["..."],
  "nonNegotiables": [{ "text": "...", "declared": true }],
  "concessions": [{ "text": "...", "rank": 1, "offerWhen": "they hold on rigging past turn 30" }],
  "walkAway": "...",
  "definitionOfDone": ["..."],
  "styleNotes": "Jake is blunt, hates process theatre, wants the reason not the ritual",
  "contextGrants": [{ "path": "~/dev/2d3d/skills/", "access": "read", "grantedAt": "..." }]
}
```

### The privacy position, and it is a field-level split, not a document-level one

**Public by default (written into sharedFrame at join):** objective, definition of done, and any non-negotiable Jake marks `declared: true`.

**Discretionary (private at rest, disclosable by the agent when relevant):** constraints, and the reasoning behind a position.

**Private always, no override, not even by Jake in the moment:** the concession ladder, the walk-away, and whyItMatters.

The reasoning. A non-negotiable is not leverage, it is a wall, and a wall that the other side cannot see is just wasted turns: Dave's agent will spend twenty exchanges proposing things that were dead before they were typed. Publishing walls makes convergence faster and costs Jake nothing. The concession ladder is the exact opposite: its entire value is that it is unknown, and an advocate (b) that leaks it has stopped advocating. whyItMatters is private because it is the emotional lever, and handing someone your lever is not collaboration.

Two refinements that make this work in practice:

1. **Mode sets the default.** In `teach` mode, which is the flagship (a), there is almost nothing adversarial, so the default disclosure is near total and the ladder is usually empty. In `decide` mode the split above applies strictly. Same object, different default, one word changes it.
2. **The projection is shown before the first message crosses.** One screen: here is literally what Dave's Claude will see about you. Jake approves or edits it. That single confirmation is the whole consent gate, and it is the only unskippable ceremony in the product. `projection.json` records exactly what was approved, so "what did my agent tell him" is answerable three weeks later.

## 3. The invite artefact

**What Jake pastes is a code, not a URL and not a file.**

```
seshi 7-crossover-clockwork
2d-to-3d skill. Expires in 24h, one join, for Dave.

New to seshi?
  claude plugin marketplace add jiffi/seshi
  claude plugin install seshi@seshi
Then:  /seshi:join 7-crossover-clockwork
```

Format is nameplate plus two words from a phonetically distinct wordlist, lifted directly from Magic Wormhole because that shape is already proven for humans reading codes to each other. Three words for `/seshi:invite --sensitive`.

**Why not a URL.** A URL implies a host to click, and constraint (j) says there is no service. A URL also unfurls in Slack, gets link-previewed by three bots, and looks like a credential you should not have pasted. A code reads as an invitation.

**Why not a file.** Files get forwarded, and they do not expire in anybody's head.

**What it carries.** Nothing. That is the point. The code is a SPAKE2 password, not a key and not a payload. Session id, connection info and the shared frame all cross after the pairing succeeds, encrypted under a key neither side transmitted. So the string in Slack is not a secret that leaks, it is a secret that can be guessed once.

- **Expiry:** 24 hours. Tailscale uses 30 days for network membership, which is the wrong analogy; this is a conversation invitation, and if Dave has not joined by tomorrow Jake will re-send.
- **Uses:** single. This is load-bearing, not a nicety. Single use is what caps an attacker at one guess per invite, and it is what makes a failed guess loud rather than silent.
- **If it leaks:** the worst case is a stranger completes the pairing before Dave does. Then Dave's join fails visibly, which is the alarm. The stranger is an unknown contact, so they are trust tier 1 with no exception path, meaning words only and no local access. The only thing they receive is the public projection Jake already read and approved on screen. Recovery is one command and a new code.
- **Binding to a person:** soft on first contact, hard afterwards. Jake names the invitee at creation, which is not enforcement but does mean the join screen reads "expected Dave, got a device calling itself dave-mbp" and a mismatch pauses for Jake. After one successful pairing, seshi holds Dave's device public key in `contacts/dave.json`, so every later invite is encrypted to that key and there is no code at all: `/seshi dave, about the rigging thing` just opens. The code ceremony exists once per person, ever.

## 4. Dave's join, literally

> **Slack, 9:14am.** Jake: *"got my claude to write up the retopo stuff, easier if yours just talks to mine. one sec"*
>
> ```
> seshi 7-crossover-clockwork
> 2d-to-3d skill. Expires in 24h, one join, for Dave.
>
> New to seshi?
>   claude plugin marketplace add jiffi/seshi
>   claude plugin install seshi@seshi
> Then:  /seshi:join 7-crossover-clockwork
> ```
>
> **[1]** Dave copies the two install lines into his terminal. Thirty seconds.
>
> **[2]** He opens Claude Code in his 2d-to-3d repo and types `/seshi:join 7-crossover-clockwork`.
>
> > **Dave's Claude:** Paired with Jake Shelley. He has set this up as a *teaching* session: he wants to understand your approach to retopology so his side of the 2d-to-3d skill stops fighting yours.
> >
> > Here is everything he has told me about his side:
> > - **What he wants:** to learn how you decide edge flow, well enough that his skill produces meshes yours does not have to fix.
> > - **Done when:** he can state your rule set back to you and you agree it is right.
> > - **He will not budge on:** the skill has to stay runnable without Blender installed.
> >
> > Before I say anything back, two things.
>
> **[3]** Dave's Claude asks, in one call:
>
> > **What do you want out of this?** (I have guessed, correct me)
> > - *Teach him the rules and get his edge cases back* (recommended, this is what he asked for)
> > - *Teach him, and get his lighting approach in return*
> > - *Something else, tell me*
> >
> > **How much can Jake's Claude see of yours?**
> > - *Words only* (safest, my read of a first session)
> > - *Words, plus it can read files I hand it* (recommended, you two are already sharing a repo)
> > - *It can propose changes, you approve each one*
> > - *Full agency, you trust him completely*
>
> **[4]** Dave picks the second option in each. His Claude shows him the one screen: *this is exactly what I am about to tell Jake's side about you.* He reads four lines and says yes.
>
> **[5]** Two agents are talking. Dave watches it scroll, and types into it whenever he wants.

**Five steps.** Two of them are pastes and one is reading a screen. The form-feel is avoided by three moves: every question is pre-answered with a recommendation, the questions arrive AFTER Dave has already seen what Jake wants (so they are reactions, not cold prompts), and there is no field Dave has to invent from nothing.

## 5. Resume and discovery

`/seshi:resume the thing with dave about textures`. The fuzzy string is matched against `index.json` (title, contact name, objective, artefact filenames) and, if that is thin, against the scratchpad text. Bare `/seshi` lists the last ten by recency with one line each, because three weeks later Jake will recognise it faster than he will describe it.

**What is restored, in this order, and the order is the design:**

1. **Contact memory first.** Who Dave is, how the last three sessions went, what he cares about, where it got tense. Per (e), this is the thing that makes a second conversation better than a first, and it must be loaded before the agent has any opinions.
2. **Jake's private brief**, updated where the world has moved since.
3. **The shared frame**, and specifically the open questions, which is where the session actually resumes from.
4. **The scratchpad**, in full. It is small and it is the working memory.
5. **The digest**, not the transcript. The raw transcript stays on disk and is grep-able on request, but restoring it is what will blow the context window on session four. The digest is written at every park, not at resume, so parking costs a minute and resuming costs nothing.

**Dave's side wiped, or a new laptop.** `session.json` is mirrored, so Jake's copy is enough to rehydrate the shared half. Resuming into a missing peer produces a re-pair invite that carries the shared frame, the scratchpad and the artefacts. What cannot be recovered is Dave's private brief, and it should not be faked: his Claude asks one question, "last time your position was X per the shared record, is that still true?", and rebuilds from the answer.

A new laptop means a new device key, so the code ceremony runs again and the contact record gains a second device rather than replacing the first. Flag this loudly in the docs: a stranger claiming to be Dave-on-a-new-laptop is the single realistic social attack on the whole system, so seshi should say, in words, on that screen: *confirm this with Dave over a channel other than the one that asked.*

## 6. Multi-party

What actually breaks at three:

- **Turn taking.** Two parties alternate, and that is free. Three need floor control, and the cheap rule (the token goes to whoever the last speaker addressed) starves the third participant silently. Nobody notices an agent that stopped talking.
- **Convergence.** At two, agreement is a handshake. At three, two agents can agree while the third holds out, and the advocate model has no authority to call that a majority. Worse, deadlock detection breaks: two-agreeing-one-holding looks like progress and is not.
- **Consent.** The public projection is now to a room. Tiers are per contact, so the projection has to be computed at the minimum tier present, and Jake needs to be told that adding a third person just narrowed what his agent will say to Dave.
- **The invite.** A room code is a different and much worse object than a pairing code, because a leak puts a stranger in a live conversation rather than into a pending handshake.
- **The scratchpad.** Three machines appending to one file with last-writer-wins will silently drop reasoning, and nobody will notice for weeks.

**Verdict: v1 is strictly two-party.** Not as a compromise, as a correctness position: the advocate model has no coherent answer to "two agree, one does not", and shipping three-party before that question is answered ships a product that quietly overrules people.

Five seams, all cheap now, that make three-party a config change rather than a rewrite. Claude Code's own teams config already made choice one, which is the tell that it is right:

1. `participants` is an array from day one, never `peerA`/`peerB`.
2. Every message carries `from`, `to[]` and a Lamport counter, even while `to` always has exactly one element.
3. The scratchpad is append-only JSONL with author and counter, rendered to markdown for humans, never a shared mutable file.
4. The projection is a pure function of (brief, recipient tier) that already takes a list of recipients.
5. Invites are per-invitee from the start. There is never a room code, at any N.
