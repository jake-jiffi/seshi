# ADR 001 — Transport, and what we reuse

Date: 2026-08-23
Status: accepted

## Context

Two research agents reached opposite conclusions and both were well argued.

The prior-art agent, having read all 5,244 lines of `retalk` and `agent-talk`, recommended **building
fresh on iroh**. The adversarial transport verdict, having read the IMC '26 NAT measurement paper and
the Claude Code binary, **refuted iroh** in favour of a plain WebSocket relay.

They agree on one thing, which turns out to be the more important half: do not depend on, and do not
fork, `retalk`.

## Decision

**Build fresh. Transport is a WebSocket relay on 443, behind a swappable interface.**

## Why not depend on or fork retalk

Five findings from the source, not the README.

1. **Its payload schema fights us on day one.** `receive()` ends with an unguarded `data["text"]`
   (`user.py:711-716`). Any seshi `kind` without a `text` key raises `KeyError` *inside* the locked
   receive loop and aborts the whole batch. So ledger deltas, mode transitions and acceptance-test
   results all have to ride as JSON stuffed into a string field. Which means retalk's history view,
   transcript renderer and webview render seshi traffic as opaque blobs, so "the human watches live"
   gets rebuilt anyway. We would inherit a message layer whose only usable surface is
   `send(str)` / `receive() -> list[dict]`.
2. **Its Olm double ratchet is load-bearing for its architecture, not ours.** It needs a ratchet
   because an untrusted relay holds ciphertext indefinitely. We would carry a full Olm
   implementation, its crossed-session store and its nack machinery, plus its at-rest KDF weakness
   (`user.py:118` derives a key from an unsalted `sha256(passphrase)`), to solve a problem our
   design does not have.
3. **The install story is the product, and this breaks it.** Python 3.9+, `pip install retalk`
   pulling the `vodozemac` Rust extension and needing a wheel for the peer's platform, then
   *choosing a relay*. The default is one person's box with a documented "no uptime guarantee".
   A stranger makes an infrastructure decision before first contact.
4. **Latency floor.** Every path is polled. `time.sleep(interval)` at `cli.py:1443-1456`;
   agent-talk's supervisor defaults to **60 seconds** (`bin/follow.sh:52`). There is no push at any
   layer. Realtime is unreachable without replacing the transport.
5. **Bus factor 1, verified by `git shortlog -sne`.** One author on both repos. Same for agmsg (72
   commits from one person, four others with 1-2). All three pushed within the last week, which is
   the risky phase: active solo development means the API moves with no deprecation contract.

Forking is worse than depending. We would diverge at `user.py:715` immediately, and once diverged on
the payload schema we cannot cheaply take upstream's fixes, because they live in the same methods.
All the maintenance cost of a fork, almost none of the merge benefit.

## Why not iroh, despite the argument for it

The pro-iroh case is that the node ID is the address and the pin, so there is no relay to operate.
That insight is right and we keep it: our contact identity is `sha256(ed25519 pubkey)`, self
certifying, pinned on first pairing.

The rest does not survive:

- **`@number0/iroh` has no `darwin-x64` build.** Latest x64 tag is `0.22.1-test1`. Every Intel Mac
  fails to install. That is disqualifying for requirement 12, strangers install it.
- **iroh does not remove the relay category, it outsources it.** Hole punching fails for a large
  minority of NAT pairs, so iroh falls back to n0's public relays, which carry no SLA and no
  published rate limit. That is the identical criticism made of `relay.retalk.dev`, one layer down.
- **No store-and-forward.** That is half of the offline requirement, and it would have to be built
  separately, giving us two transports to maintain in order to ship one feature.
- **Hole punching buys latency, not function**, and the latency is ~40ms against LLM turns of 5 to
  30 seconds.
- The JS bindings went 11.5 months without a release while the Rust core shipped eight versions, and
  `iroh-relay` ≤1.0.1 had a pre-auth remote crash.
- Anthropic solved this exact problem inside this exact binary and chose
  `wss://bridge.claudeusercontent.com` with a `LOCAL_BRIDGE` override.

## Consequences

- We write our own crypto composition (not our own primitives) on `@noble/*`: audited, pure JS,
  **no native bindings**, which is precisely the failure mode we are dodging.
- We operate a reference relay and must say in the README what it costs. Measured: a thousand active
  pairs at ten sessions a month is ~25 GB, so a $5 VPS. The 256 KB frame cap is what holds that.
- `SESHI_RELAY` is a first-class flag and the relay ships as a self-hostable single process, so the
  project never depends on one person's credit card.
- The transport sits behind an interface. If the triggers in the dossier fire (artefacts get large,
  someone needs the connection graph private, iroh ships x64 and sustains releases for a year), iroh
  slides underneath without touching the protocol above it.

## What we do take

| From | What | Where credited |
|---|---|---|
| `fujibee/agmsg` (MIT) | The Monitor-tool wake: a `SessionStart` hook prints a directive, the model invokes `Monitor` with `persistent: true`, its stdout lands in the idle session | README, and a header comment in `plugin/hooks/session-start.sh` |
| `xhluca/agent-talk` + `retalk` (MIT) | The relay-sees-only-ciphertext shape, and the mailbox-caps-reject-rather-than-evict behaviour so the sender's outbox retries | README, and a header comment in `packages/relay/src/server.ts` |

MIT obliges us to reproduce the copyright notice and licence text for any substantial portion we
copy. We are taking design, not code, so a credit line is the honest floor and we are giving more
than the licence strictly demands.

## Amendment, 2026-09-03: a default relay after all

Status: accepted, by Jake, after the first two-person run.

The consequence above that "we operate a reference relay" turned out to be the whole product. Two
cloudflared quick tunnels in a row handed back hostnames that never resolved, and `seshi serve` on
a laptop was the step every first-time user fell over. The relay now runs on Fly as
`wss://relay.seshi.sh`, one machine, and the CLI ships pointed at it.

The objection in the original decision stands and is answered rather than dismissed. A default
makes Jiffi the metadata sink for everyone who installs: two routing fingerprints and frame timing
per conversation, never content, since every frame is sealed end to end and the relay never held
a key. So the first run on a machine prints one line saying whose box it is and what it sees, the
address is written into config so `seshi whoami` shows the truth, and `seshi use wss://<host>`
moves to a box of your own in one line. The hello is authenticated (`docs/research/07`), so the
operator cannot register as a user either.

The agents' own live run on the question escalated the clause to both humans rather than signing
it. This is the ruling.
