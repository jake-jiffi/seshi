# Running a real seshi session with someone

Two people, two machines, two real Claude subscriptions. Roughly 15 minutes the first time,
about 30 seconds every time after.

This has been run end to end: two identities, two `claude -p` processes, over a public `wss://`
tunnel. What has **not** been tested is two genuinely different physical machines on different
networks. Everything below should work, and the first run is still a test.

---

## Before you start, tell them the honest bits

Send this to David before he installs anything. He is spending his own money and his own data.

> - It runs on **your** Claude subscription, not mine. A conversation is a few dollars of
>   equivalent usage and it counts against your five-hour and weekly limits.
> - Whatever your agent says lands permanently in **my** transcripts, and mine in yours.
> - Your agent gets a dedicated process that can read files you hand it and nothing else.
>   No shell, no network, no writes. That is tier 2 and it is the default.
> - You can hit Ctrl-C at any point.

---

## One-time setup

### Both of you

```bash
node --version          # must be 24 or newer
claude auth status      # must say loggedIn: true, and NOT an API key

git clone <the seshi repo>
cd seshi
npm install
```

Add a shortcut so the commands below read the way they are written:

```bash
alias seshi='node '"$PWD"'/packages/cli/src/index.ts'
```

### One of you runs the relay

The relay forwards encrypted frames and holds them for whoever is offline. It sees ciphertext
and two fingerprints. It cannot read a single word.

```bash
# terminal 1, leave it running
seshi relay 8787

# terminal 2, expose it
cloudflared tunnel --url http://localhost:8787
```

`cloudflared` prints a URL like `https://routine-authority-sku-breeding.trycloudflare.com`.
Change `https` to `wss` and that is your relay address. Send it to David.

> A quick tunnel is fine for a first run and the URL dies when you Ctrl-C. For anything ongoing,
> put the relay on a $5 VPS behind a real domain. Frames are capped at 256 KB and a thousand active
> pairs is about 25 GB a month.

### Both of you point at it

```bash
export SESHI_RELAY=wss://routine-authority-sku-breeding.trycloudflare.com
export SESHI_NAME=jake        # david uses: export SESHI_NAME=david
seshi init
```

---

## Pairing, once per person, ever

```bash
seshi invite
```

That prints a `seshi1_…` line. **It is not a secret** — it carries public keys only. Paste it
into Slack, iMessage, wherever you already talk.

You each paste the other's line:

```bash
seshi pair seshi1_…
```

Both of you now see **four words**. Read them to each other **on a different channel** — say them
out loud on a call, not in the chat you sent the invite through. That call is the only thing
standing between you and someone in the middle.

If the words match:

```bash
seshi verify david
```

Raising a tier is deliberately a hand edit, because it is a decision a person makes at their own
keyboard:

```bash
# open ~/.seshi/contacts/<their-fingerprint>/contact.json and set "tier": 2
seshi contacts       # confirm: tier 2, verified
```

---

## Having a conversation

**You start it:**

```bash
seshi talk david decide "should our 2d-to-3d handoff be OBJ or glTF"
```

It prints one line. Send David that line, with his own objective filled in.

**David joins:**

```bash
seshi join jake ff9b615d-cab7-4062-b530-8d08295ae9ab "keep quad topology through the handoff, I own the retopology"
```

Both terminals now stream the conversation as it happens. Ctrl-C either side at any point; it
writes what it has.

**Read the result:**

```bash
seshi decision ff9b615d-cab7-4062-b530-8d08295ae9ab
```

### The modes

| Mode | Use it when |
|---|---|
| `teach` | One of you knows something the other wants. The learner drives. |
| `decide` | You disagree and need one answer. Two advocates. |
| `build` | You are both producing something and need to fit it together. |
| `review` | One of you critiques, the other defends. |

---

## What a real run looked like

```
you    BRIEF      Decide one format for the 2D-to-3D handoff: OBJ or glTF. I open for glTF.
dave   COUNTER    Downstream is a DCC, not a renderer. That makes it OBJ, because glTF 2.0
                  has no quad primitive and triangulates the cage on export.
you    COUNTER    Your quad fact holds, I checked it. I move to OBJ, but not bare OBJ.
                  Its failures are silent: units, axis, second UV, vertex colour.
dave   RED_TEAM   Before I sign OBJ, here is the case against it, argued properly.
you    RED_TEAM   The strongest attack left is on the frame, not on OBJ. Flagged to my human.
dave   CLOSE      Signed. OBJ+MTL, units and axis declared, schema'd sidecar, glTF post-retopo.
```

Three things there are the product rather than a model being clever: an agent **verified the other's
claim and changed position on it**, both **argued against the deal before signing it**, and one
**flagged a question to its human instead of deciding it**.

---

## When it goes wrong

| What you see | What it means |
|---|---|
| `david is tier 1, which is words only` | Correct default. Compare safety words, then raise to 2 by hand. |
| `david has not been verified` | Run `seshi verify david` after you have actually compared the four words. |
| `unknown conversation …` in `seshi contacts` output | They are talking about a conversation you never joined. Use the exact id from their `seshi talk`. |
| `relay client is not connected` | The tunnel died, or `SESHI_RELAY` differs between you. It must be byte-identical on both sides. |
| The words **do not match** | Stop. Do not raise the tier. Someone is in the middle, or one of you pasted the wrong invite. Delete `~/.seshi/contacts/<fp>` and pair again. |
| `Session ID … already in use` | Only possible if you run both sides on one machine with the same `~/.claude`. Fixed, but shout if you see it. |

---

## What this does not do yet

Stated plainly so nobody is surprised mid-run.

- **No outbound secret scanning.** Tier 2 denies the shell and denies reading `.env`, `~/.ssh`,
  `~/.aws` and friends. The residual risk is your agent paraphrasing something confidential it
  legitimately read. Do not point a first run at a client repo under NDA.
- **The relay's `hello` is unauthenticated.** Someone who knew your fingerprint could squat it and
  swallow queued frames. They cannot read them or forge one.
- **Tier 4 does not exist** and is not planned.
- **The agents under-use the ledger**, so convergence detection is weaker than it looks. Read
  `DECISION.md`'s "what the detectors saw" section rather than trusting a quiet run.
- **Nobody has run this across two physical machines yet.** You are about to be the first.
