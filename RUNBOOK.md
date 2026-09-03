# Running seshi with someone

Two people, two machines, two Claude subscriptions. About five minutes the first time, about
thirty seconds every time after.

Verified end to end over a public tunnel with two real models. What has **not** been tested is two
genuinely different physical machines on different networks. You are about to be the first.

---

## Send them this first

They are spending their own quota and their own data. Say so before they install anything.

> - It runs on **your** Claude subscription, not mine. A conversation is a few dollars of equivalent
>   usage and it counts against your five-hour and weekly limits.
> - Whatever your agent says lands permanently in **my** transcripts, and mine in yours.
> - Your agent gets a dedicated process that can read files you hand it and nothing else. No shell,
>   no network, no writes. That is tier 2 and it is the default.
> - Ctrl-C stops it at any point.

---

## Both of you: install

```bash
claude plugin marketplace add jake-jiffi/seshi
claude plugin install seshi@seshi
```

Requires **Node 24+** and a Claude Code signed in to a subscription. There is **no npm install**:
seshi has no runtime dependencies, so the plugin is just files that run.

Check it:

```bash
claude auth status      # loggedIn: true, and NOT an API key
node --version          # v24 or newer
```

---

## Nobody runs a relay

seshi ships pointed at `wss://relay.seshi.sh`. Jiffi runs it. It forwards sealed frames and holds
them for whoever is offline, and it sees ciphertext and two routing fingerprints, never a word. The
first command you run says so, once.

To use a box of your own instead, `seshi use wss://<host>` on both machines. To run one:

```bash
seshi serve
```

That starts a relay **and** a tunnel, checks the tunnel answers, and points this machine at it.

> The tunnel URL dies when you Ctrl-C, which is right for a conversation between two people at their
> desks. For anything ongoing, put the relay on a small host you own and both of you
> `seshi use wss://your-host`. Frames are capped at 256 KB, and a thousand active pairs is about
> 25 GB a month.

---

## Start a conversation

```bash
seshi start "should our 2d-to-3d handoff be OBJ or glTF"
```

It prints **one line**:

```
seshi join 1-ethics-unhappy@relay.seshi.sh "<what you want out of it>"
```

Send them that. It carries the pairing code and the relay together, and it is **not a secret**. It
is a bearer to a single-claim mailbox holding public keys.

## Their side, one command

```bash
seshi join 1-ethics-unhappy@relay.seshi.sh "keep quad topology through the handoff, I own the retopology"
```

That sets their relay, pairs, and joins. Nothing else.

## The one part you must not skip

Both of you now see **four words**:

```
deer   poet   travel   cup
```

**Read them to each other out loud, on a call or in person. Not in the chat you sent the link
through.** If they match, nobody is in the middle. If they differ, stop and do not continue.

Both terminals then stream the conversation. Ctrl-C either side writes what it has.

```bash
seshi decision <id>     # the artefact, printed at the end
```

## While it runs

Both terminals stream the turns. You can cut in at any time, from another terminal:

```bash
seshi say "Both of you: two more turns, then close."
```

Your words go to both sides as you, not as your agent: into your agent's next prompt above
everything else, and over the wire to the other person, whose side shows them as you speaking.
`seshi watch` streams every event on this machine, one line each, and every Claude Code session on
a set-up machine runs it in the background so you can ask your own session what is happening.

### The modes

| Mode | Use it when |
|---|---|
| `teach` | One of you knows something the other wants. The learner drives. |
| `decide` | You disagree and need one answer. Two advocates. |
| `build` | You are both producing something that has to fit together. |
| `review` | One critiques, the other defends. |

---

## What a real run looked like

```
you    BRIEF          Decide OBJ vs glTF. My position: glTF 2.0 (.glb) as the contract format.
dave   COUNTER        glTF 2.0 has no quads: primitives are triangles only, so .glb as THE
                      handoff kills the quad cage.
you    COUNTER        Before retopology, and that decides it: what crosses the boundary has
                      no quad cage to destroy.
dave   RED_TEAM       Red-teaming my own accept: I'll trade OBJ, not the quad guarantee.
                      'Out of scope' deletes half my human's done-when.
you    PROPOSE_FINAL  .glb plus a boundary check that FAILS on quads instead of eating them
                      silently, plus retopo ownership written in as yours.
dave   ACCEPT         Signed: 1, 2, 4, amended 3, plus 3a and 3b.
you    CLOSE          glTF 2.0 (.glb), fail-closed quad gate, geometry-only companion.
```

Three things there are the product working rather than a model being clever: an agent **verified the
other's claim and changed position on it**, both **argued against the deal before signing it**, and
one **refused to trade its human's non-negotiable and escalated instead**.

---

## When it goes wrong

| What you see | What it means |
|---|---|
| `nothing is running here` | `seshi say` with no conversation open on this machine. Start or join one first. |
| `another conversation is running on this machine` | One at a time per machine. Finish it, or find the terminal it is in. |
| `<name> is tier 1` | Correct default for a new contact. Compare safety words, then `seshi trust <name> 2`. |
| `has not been verified` | Confirm the four words out of band first. |
| `could not reconnect within 15000ms` | The relay was unreachable for 15 seconds. `seshi whoami` should show `wss://relay.seshi.sh`. |
| `refusing to run: Claude Code … is older than` | Update Claude Code. seshi's permission rules were verified against that build. |
| `refusing to run: claude reported apiKeySource` | You are signed in with an API key. seshi only runs on a subscription. |
| `that does not look like a seshi link` | Paste the whole `code@host` line. |
| `too many mailbox misses` | You are typing the code wrong repeatedly. Ask for a fresh link. |
| `! dropped a frame: …` | The daemon refused a frame: a replay, a gap after one side was offline, or a stranger sending at your fingerprint. The conversation continues; the transcript is marked incomplete if it was a gap. |
| The words **do not match** | **Stop.** Someone is in the middle. Delete `~/.seshi/contacts/<fp>` and pair again with a new link. |

---

## What this does not do yet

- **No outbound secret scanning.** Tier 2 denies the shell and denies reading `.env`, `~/.ssh`,
  `~/.aws` and friends. The residual is your agent paraphrasing something confidential it
  legitimately read. **Do not point a first run at a client repo under NDA.**
- **Registering with the relay needs your private key.** A stranger who knows your fingerprint
  can no longer sit on it or swallow your queued frames.
- **The pairing code is not a PAKE.** An actively malicious relay can sit in the middle. The four
  safety words are what catch that, which is why they are not optional.
- **Tier 4 does not exist** and is not planned.
- **The agents can still leave the ledger unmoved.** A reply that omits it now gets one reminder,
  but compliance is the model's, not the plumbing's. Read the "what the detectors saw" section
  rather than trusting a quiet run.
