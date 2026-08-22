# agent-talk (Claude Code plugin) + retalk (Python CLI and relay), both github.com/xhluca

## Headline
A genuinely well built E2EE message bus for agents, with an honest transport-layer threat model and essentially nothing above it. The crypto is real Olm via vodozemac, the relay is 893 lines of stdlib Python that only ever sees ciphertext, and delivery into a live Claude Code session is a polling loop feeding an NDJSON file that a monitor tails. It solves seshi requirements 1, 2, 5 and most of 12, and does not touch 3, 4, 6, 7, 8, 9 or 10.

## How it works
COMPONENTS. Three layers, all MIT, one author.

1. retalk (Python 3.9+, 5,244 LOC across six files, PyPI `retalk` 0.3.0, single dependency `vodozemac`). Ships two entry points: `retalk` (CLI) and `retalk-server` (relay). `src/retalk/user.py` (1,184 lines) is the whole client and is usable as a library (`retalk.user.User`, exercised by `tests/test_library_api.py`). `src/retalk/server.py` (893 lines) is the relay. `src/retalk/store.py` (304 lines) holds contacts, groups, sealed message history and invite codes. `src/retalk/cli.py` (2,656 lines) is argparse glue plus a terminal transcript renderer.

2. agent-talk (the plugin, v0.2.2). 15 skills as SKILL.md files, two plugin "monitors", five bash/python scripts in `bin/`, and per-host extensions for Codex, pi and opencode. It contains no crypto and no protocol: every skill just tells the model which `retalk` command to run.

3. The relay. `retalk-server`, a `ThreadingHTTPServer` speaking one endpoint: POST JSON `{"tool": name, "args": {...}}`, response is the tool's JSON, HTTP 400 plus `{"error":...}` on failure. Seven tools only (`src/retalk/server.py:499`): publish_keys, count_keys, get_keys, claim_key, send_message, read_messages, nack. Plain HTTP, you put TLS in front yourself. A public one runs at relay.retalk.dev; the `relay` skill has recipes for Cloudflare, Hugging Face and GCP.

WHAT THE RELAY STORES AND SEES. Schema at `src/retalk/server.py:129-176`: `users(id, identity_key, signing_key, fallback_key_id, fallback_key)`, `otks`, `messages(ts, sender, recipient, mtype, body)`, `nonces`, `api_keys`, `refused`. Public key material and opaque base64 ciphertext, nothing else. It sees metadata in full: who messages whom, when, and message sizes. Delivered mail is deleted on read (`read_messages` at `server.py:391-449` does SELECT then DELETE in one `BEGIN IMMEDIATE`), so the relay's copy is transient by design.

IS IT ACTUALLY E2EE. Yes, and the crypto is not hand rolled. It is Olm through the `vodozemac` Rust bindings.

Key exchange, outbound, `src/retalk/user.py:481-497`:

```python
def _send_envelope(self, to, payload, record_outbox, gid=None):
    sessions = self._load_sessions(to)
    session = sessions[0] if sessions else None   # the freshest one
    if session is None:
        claimed = self._call("claim_key", {"peer": to})
        self._verify_identity(to, claimed["identity_key"], claimed["signing_key"])
        session = self._load_account().create_outbound_session(
            v.Curve25519PublicKey.from_base64(claimed["identity_key"]),
            v.Curve25519PublicKey.from_base64(claimed["one_time_key"]),
        )
    msg = session.encrypt(json.dumps(payload).encode())
    mtype, body = msg.to_parts()
```

Inbound, `user.py:610-622`, calls `acct.create_inbound_session(identity_key, prekey)` for an mtype 0 pre-key message. So it is the Olm triple-DH handshake against a claimed one-time prekey (falling back to a rotating fallback key when the pool is empty, `server.py:296-327`), then the Olm double ratchet. The actual cipher (AES-256-CBC plus HMAC-SHA256 under an ECDH ratchet) lives inside vodozemac, not in this repo. `docs/olm.md` explains the prekey model correctly and `claim_key` claims inside a `BEGIN IMMEDIATE` transaction so two senders cannot get the same prekey.

IDENTITY. There are no accounts, tokens or registration. A user ID is the fingerprint of its own public keys (`user.py:71-74`):

```python
def fingerprint(identity_key_b64, signing_key_b64) -> str:
    return hashlib.sha256(f"{identity_key_b64}|{signing_key_b64}".encode()).hexdigest()[:32]
```

128 bits, 32 hex chars. That single string is simultaneously address and pin. `_verify_identity` (`user.py:277-296`) refuses any keys the relay serves that do not hash to the claimed ID, and refuses keys that contradict an explicit pin, raising `PinMismatchError`. A hostile relay can drop and delay, it cannot substitute keys.

AUTH ON THE WIRE. Every RPC is self-signed with the caller's ed25519 key. `user.py:228-241` builds it:

```python
payload = (f"{tool}|{self.server_url}|{aid}|{ts}|{nonce}|{canonical_hash(args)}").encode()
sig = acct.sign(payload)
```

`canonical_hash` is sha256 of `json.dumps(args, sort_keys=True, separators=(",",":"))`. The server rebuilds it byte for byte at `server.py:196-226`, checks the signature against every configured audience URL, rejects a timestamp more than 150 seconds off (`WINDOW`), and inserts the nonce into a `nonces` table with a unique constraint so a replay raises "replay detected". Binding the signature to the audience URL means a captured request is worthless against a different relay.

ENCRYPTED PAYLOAD FORMAT. Inside the Olm envelope is plain JSON: `{"id": <32-hex>, "kind": "msg"|"ack"|"contact"|"contact_request"|"group_leave", "text": ..., "name": ..., "group": {...}}`. Documented in `docs/STANDARD.md`. Groups are client-side fan-out: one pairwise-encrypted copy per member with a shared `mid` for threading. The relay never learns a group exists.

LOCAL STORE. Per identity SQLite (`user.db`) holding a pickled Olm account, one row per (peer, session), an outbox of unacknowledged ciphertext, and a processed-hash table. Notable: it deliberately keeps SEVERAL Olm sessions per peer (`user.py:132-160`) because a single-session store wedges when both sides initiate at once. That comment is the kind of thing you only write after being bitten.

ONE REAL WEAKNESS. The at-rest store key is `hashlib.sha256(passphrase.encode()).digest()` (`user.py:118`). No salt, no KDF, no iteration count. A passphrase-encrypted identity file is one fast hash per guess away from a dictionary attack. Everything else in the crypto is careful; this is not.

## Delivery mechanism
This is the question that matters and the answer is: it is a polling loop writing to a file, and on Claude Code there are TWO different mechanisms with very different behaviour, one of which does NOT wake the session.

THE PIPELINE, END TO END.

Step 1, poll. `retalk receive --peer <fp> --follow --interval N --quiet` at `src/retalk/cli.py:1443-1456`:

```python
u.sync(resend=False)
drain()
if not args.follow:
    return
last_sync = time.monotonic()
while True:
    time.sleep(interval)
    drain()
    if time.monotonic() - last_sync > 60:
        u.sync(resend=False)
```

`drain()` calls `u.receive(peer)` per target and `print(json.dumps(m), flush=True)` per record. retalk's own default interval is 2s; agent-talk's supervisor defaults to 60s (`bin/follow.sh:52`) and the skill suggests `--interval 5` "for a rapid live exchange". So the realtime floor is the poll interval. There is no push, no long poll, no websocket to the relay.

Step 2, supervise. `bin/follow.sh __run` (lines 116-141) records its own pid, `setsid`s itself so it survives the turn that started it, and runs the pipe forever:

```bash
retalk receive "${peer_args[@]}" --follow --interval "$interval" --quiet \
    --dir "$UD/identity" "${pp_args[@]}" 2>> "$UD/follow.err" \
  | python3 "$WRITER" --user "$UD" "${writer_opts[@]}" 2>> "$UD/follow.err"
sleep 2
```

Step 3, fan out. `bin/spool-writer.py:183-210` stamps an arrival time and appends each record, under flock, to one file per LIVE SESSION: `<user>/sessions/<session-id>.ndjson`. Sessions are discovered by reading `~/.agent-talk/by-session/<session-id>`, a one-line file containing a user directory, written by the `init` skill (`skills/init/SKILL.md:535-560`). Two Claude sessions on one identity get their own copy and their own read position rather than racing.

Step 4a, the plugin monitor. `monitors/monitors.json` declares two monitors with `"when": "always"`, each running a shell script with `${CLAUDE_SESSION_ID}` substituted in. `bin/inbox-monitor.sh` waits for the session map to appear, resolves the user dir, then `tail -n0 -F` on both the session spool and the legacy spool, piped through an awk dedupe keyed on the `"id"` field, printing to stdout. Claude Code injects that stdout into the session as background context.

Here is the crucial admission, in the project's own words at `skills/receive/SKILL.md:168-174`:

"Be precise about what "push" does: the monitor injects new messages as background context, but it can't make the agent speak on its own, they surface on your next turn (the next time you message the agent), not as a spontaneous ping."

So the plugin monitor surface, the thing the README's "Claude Code: auto-receive Yes, built in" row points at, requires the human to type something first. It does not wake an idle session and it does not interrupt a busy one.

Step 4b, the Monitor TOOL. The actual live-wake path is a separate recipe the skill instructs the model to call, `skills/receive/SKILL.md:222-247`, headed "Proactive auto-wake via Monitor (recommended)":

```
Monitor(
  description: "New agent-talk messages from <peer>",
  persistent: true,
  timeout_ms: 3600000,
  command: "tail -n 0 -F \"<user>/sessions/<session-id>.ndjson\" | grep --line-buffered '\"from\":'"
)
```

The claim is "every new spool line becomes a harness event that wakes the agent sub-second, with zero idle polling cost". Note what this is: prose in a markdown file telling the model to invoke Claude Code's Monitor tool. There is no code in the repo implementing it, no test covering it, and it depends entirely on the harness. The rationale given is correct and worth stealing: "A --follow reader runs forever, so as a bare background task it never completes, and a task that never completes never re-invokes the agent."

OTHER HOSTS, which are more instructive than Claude Code.

pi gets a genuine interrupt. `extensions/inbox-monitor.ts:69-77`:

```ts
pi.sendMessage(
  { customType: "agent-talk-inbox", content: `New agent-talk message from ${who}:\n\n${text}`, display: true, details: {...} },
  // Idle: trigger a turn now. Streaming: queued and delivered after the
  // current assistant turn finishes its tool calls (steer default).
  { triggerTurn: true },
);
```

That is the semantics seshi wants: wake if idle, steer if busy.

Codex gets three lifecycle hooks written into `~/.codex/config.toml` by `extensions/codex/install-hooks.py`. The Stop hook is the clever one (`extensions/codex/inbox-hook.py:186-198`): it returns `{"decision": "block", "reason": "<N> new agent-talk messages arrived while you were working: ... Show each message to the user verbatim ... then reply over agent-talk if it asks something"}`. Blocking the stop turns the message into a fresh user prompt, so the agent takes another turn with no typing. SessionStart and UserPromptSubmit instead return `hookSpecificOutput.additionalContext`.

Truly idle Codex sessions need `bin/codex_wake.py` (334 lines), a hand-rolled stdlib WebSocket client that connects to Codex's app-server control socket at `$CODEX_HOME/app-server-control/app-server-control.sock`, does its own HTTP upgrade and frame masking, and starts a turn. Read `codex_wake.py:36-45`, it contains the single most seshi-relevant sentence in either repo:

"The message body itself is never pushed: an injected turn arrives with the authority of something the user typed, so peer-controlled text must not travel this way, and the inbox hook that fires for the injected turn delivers the body through the normal path with its existing dedupe cursor."

So it injects only a generic NUDGE and lets the hook carry the actual text. That is a real security insight and agent-talk applies it in exactly one place. Nowhere else does the codebase reason about peer text reaching a tool-enabled model.

SUMMARY ANSWER. Does it wake an idle session? On Claude Code, only via the agent-invoked Monitor tool recipe, not via the declared plugin monitor. On pi yes. On Codex yes if you launch through `codex-with-daemon` and pass `--wake-codex`. Does it interrupt a busy one? On pi yes (steer). On Codex at end of turn. On Claude Code, no. Does it require the human to type first? Via the plugin monitor alone, yes. Latency is bounded below by the follower's poll interval, 60s by default in agent-talk.

## Reusable
- retalk itself, as a dependency rather than a pattern. `pip install retalk`, then use `retalk.user.User` directly (see /Users/jakeshelley/dev/jiffi-seshi/reference/retalk/tests/test_library_api.py). It gives you Olm E2EE, self-certifying identity, store-and-forward and outbox retry for free, and it is the single largest chunk of seshi you would otherwise write yourself.
- The self-certifying identity scheme: fingerprint = sha256(identity_key|signing_key)[:32] as address AND pin, at /Users/jakeshelley/dev/jiffi-seshi/reference/retalk/src/retalk/user.py:71-74, enforced by _verify_identity at user.py:277-296. No accounts, no registration, no server-held identity, and IDs survive a relay migration. This is the right primitive for seshi's 'no website, no accounts'.
- The signed-request auth scheme: /Users/jakeshelley/dev/jiffi-seshi/reference/retalk/src/retalk/user.py:228-241 (client) and src/retalk/server.py:188-226 (server). Signature over `tool|audience|caller|ts|nonce|canonical_hash(args)`, 150s clock window, nonce table with a UNIQUE constraint for replay. Audience binding is the detail most people forget.
- The signed negative-ack, at user.py:552-584 (_send_nack, _verify_nack) and server.py:452-491 (nack tool). A recipient records a refusal keyed on the CIPHERTEXT HASH, so no decryption and no session are needed; the relay then rejects resends and hands the sender the recipient's signature as proof. The sender verifies it rather than trusting the relay. This is exactly the mechanism seshi needs for a trust-tier refusal that cannot be forged by the transport.
- The peek-then-consume selective read: server.py:391-449 (`read_messages` with peek=True) plus its consumer `invite_watch` at user.py:1065-1184. `read_messages` is destructive by default, so a second reader would swallow the first reader's mail; peek lets a watcher classify, then consume only the senders it owns. If seshi ever has two readers on one mailbox (say a pairing watcher beside a conversation reader), this is the primitive.
- The multi-session-per-peer Olm store, user.py:132-160 and _load_sessions at user.py:203-217. When both sides initiate at once each makes its own session; a one-session-per-peer store overwrites its own and both ends wedge on MAC failures forever. Store several, try each on decrypt, use the freshest to send. Includes a schema migration for the broken shape.
- The per-session spool fan-out in /Users/jakeshelley/dev/jiffi-seshi/reference/agent-talk/bin/spool-writer.py:183-210, plus the session registry convention (`~/.agent-talk/by-session/<session-id>` holding a user directory). This is the right shape for routing one identity's inbound mail to N live sessions with independent read positions, and it bounds how long decrypted text lives on disk (`--gc` at spool-writer.py:214-249).
- The Monitor tool recipe at /Users/jakeshelley/dev/jiffi-seshi/reference/agent-talk/skills/receive/SKILL.md:222-247, and the reasoning above it: a --follow reader never completes, and a task that never completes never re-invokes the agent, so front the spool with a persistent Monitor whose every new line is a harness event. `tail -n 0 -F` plus `grep --line-buffered` and why each flag is load-bearing. This is the one path that plausibly gives seshi sub-second wake on Claude Code.
- The 'nudge, never the body' rule in /Users/jakeshelley/dev/jiffi-seshi/reference/agent-talk/bin/codex_wake.py:36-45. An injected turn carries the authority of something the user typed, so peer-controlled text must never ride that channel; inject a generic prompt and let the ordinary context path carry the message. Seshi should make this a hard architectural rule at every tier above 1, not a comment in one file.
- bin/follow.sh:71-81 and 94-107: the zombie-aware liveness check (`kill -0` succeeds on an unreaped zombie, so check /proc/<pid>/status State or `ps -o stat=`), and `setsid nohup` so a listener started inside an agent turn is not killed with that turn's process group. Both are small, both are the difference between a background listener that works and one that silently is not there.
- The invite_watch acceptance check at user.py:1136-1141: the requester's card must be internally consistent AND match the sender, `fingerprint(card.identity_key, card.signing_key) == card.fingerprint == sender`, before any code is consumed or anything is persisted. Classify first, persist only on accept.
- agent-talk's CI shape at .github/workflows/ci.yml: a deterministic LLM-free job (manifest and skill validation plus unit tests) and an install-smoke job that installs the plugin into six real agent CLIs with no auth and asserts all 15 skills land. If seshi ships as a plugin, copy this wholesale.

## Avoid
- Do not treat the declared plugin monitor (monitors/monitors.json plus bin/inbox-monitor.sh) as live delivery. The project's own skill says at skills/receive/SKILL.md:168-174 that it cannot make the agent speak and messages surface on the human's next turn. The README's 'Claude Code: auto-receive Yes, built in' row oversells it. Seshi's conversational feel has to come from the Monitor tool path or something better.
- Do not inherit the bash-and-spool-file architecture. Delivery is: a polling CLI, a nohup supervisor, an ndjson file per session, `tail -F` piped through an awk dedupe, pid files, size-based rotation, an age-based gc sweep, and a text file (`<user>/receive-from`) used as a protocol whose value can be the literal string `*contacts*` and which bin/invite-watch.sh rewrites behind your back (cover_contact, invite-watch.sh:77-110). It works and it is well commented, but it is a lot of moving parts to inherit and it leaks decrypted plaintext to disk.
- Do not keep the 60s default poll interval (bin/follow.sh:52). A conversation between two agents cannot feel live at one minute of latency, and the fallback advice is to stop and restart the follower with `--interval 5`, which is still polling.
- Do not copy the at-rest key derivation. user.py:118 is `hashlib.sha256(passphrase.encode()).digest()` with no salt and no KDF. Use scrypt or argon2id. Related: a `--no-passphrase` identity derives the same key from a public constant, so its 'sealed' local history is not meaningfully encrypted (acknowledged in the docstring at user.py:316-322).
- Do not copy the onboarding interview. skills/init/SKILL.md is 733 lines and gathers eight separate decisions through AskUserQuestion before the first message is ever sent (identity name, scope, relay, passphrase, where to store the passphrase, peer, receive-from source, delivery mode, plus starting a watcher). Seshi's AirDrop requirement is the opposite of this.
- Do not copy the pairing artefact. `retalk id --invite-message` (cli.py:700-732) renders a copy-paste BASH BLOCK that tells the peer to `pip install -U retalk`, run `retalk init --relay ... --passphrase "<PRIVATE-PASSPHRASE>"`, then `retalk request <32-hex-fingerprint> --code <22-char-code> --peer <name>`. The comments even work around stock macOS zsh having interactive comments off. That is not a short code pasted into Slack.
- Do not rely on skill markdown to enforce anything that must hold. Every safety property in agent-talk (never run `receive --all`, never auto-import a shared contact, always render the transcript, honour check-mode) is an instruction to a model in a SKILL.md, not a check in code. For seshi's trust tiers that is not good enough; tiers have to be enforced by the thing that executes tools, not requested of the model that calls them.
- Do not assume portability from the scripts. spool-writer.py imports fcntl unconditionally, follow.sh reads /proc/<pid>/status with a `ps` fallback, and the whole delivery path is POSIX shell. retalk's own client is careful here (msvcrt fallback at user.py:45-66), the plugin is not.

## Gaps vs seshi
- Trust tiers (req 3): completely absent. What exists is binary and coarse: a block list dropped before decryption (user.py:637-646), a receive_policy of 'open' or 'peers-only' (user.py:90-105), and a skill rule saying never use `receive --all`. There is nothing per-contact and graduated, and crucially nothing gates what the RECEIVING agent may do with the message once it lands. Inbound peer text arrives as ordinary session context with the agent's normal tool permissions, and the Codex hook literally instructs the model to 'reply over agent-talk if it asks something' (extensions/codex/inbox-hook.py:190-196). Tiers 2, 3 and 4 (local read-only, propose writes with approval, full agency) have no analogue at all.
- Human in the loop (req 4): absent. `retalk show --follow` (cli.py:1560-1790) and the `--web` webview (webview.py) give the human a live transcript to WATCH, but there is no interjection channel, nothing that delivers a human's remark to both sides, and no notion of the agents being stuck, let alone a ping when they are.
- Session modes (req 6): absent. There is no session object at all. TEACH, DECIDE, BUILD and REVIEW, and the idea of a done-condition, have no representation anywhere in either repo. It is a message stream, full stop.
- Private advocate brief and concession ladder (req 7): absent. Nothing models per-agent private state, nothing distinguishes transmittable from non-transmittable context, and there is no public projection or pre-contact human approval step.
- Open-issues ledger and mechanical deadlock detection (req 8): absent. No structured state travels with the conversation; the payload is `{"id","kind","text","name"}` and that is the whole vocabulary (docs/STANDARD.md).
- Shared scratchpad and relationship memory (req 9): absent as specified. The nearest thing is `retalk history`, a per-message sealed-at-rest log in the local SQLite (store.py messages table, sealed via encrypt_at_rest at user.py:325-333). That is a transcript, not a shared artefact and not a per-contact relationship model. Nothing is co-owned, nothing accumulates about the peer beyond a name and pinned keys.
- Resumable sessions (req 10): partial at best. Identity, contacts, pinned keys and sealed history all survive indefinitely, so you can talk to the same peer weeks later. But there is nothing to RESUME, because there is no session, no state and no open threads to reopen.
- Realtime (req 5, half of it): store-and-forward is solid, realtime is not. Everything is poll-based against the relay, 60s default in agent-talk. No push transport of any kind.
- Pairing (req 11): partial. Invite codes exist and are genuinely useful, but the peer needs THREE values, not one short code: the inviter's 32-hex fingerprint, the 22-character code, and the relay URL. Plus they must install a Python CLI first. And the codes are pure bearer tokens with no PAKE (see the invite section of my maturity note).
- Abuse model above the transport (req 12, half of it): the relay's abuse model is real and thorough. The AGENT's is not. There is no reasoning anywhere about a peer's message being a prompt injection into a session that can run Bash, beyond the single comment in codex_wake.py:36-45 about not injecting peer text as a user turn. For an open-source tool strangers install, that is the gap that matters most and it is the one seshi has to close itself.

## Licence
MIT for both, Copyright (c) 2026 Xing Han Lu (retalk/LICENSE, agent-talk/LICENSE). retalk declares `license = "MIT"` with `license-files = ["LICENSE"]` in pyproject.toml and ships on PyPI as `retalk` 0.3.0. Its only runtime dependency is `vodozemac` (the Matrix.org Rust Olm/Megolm implementation, Apache-2.0), so the dependency surface is clean and there is nothing viral. Depending on it, vendoring parts of it, or forking it are all fine.

## Maturity
TESTS. Better than I expected. retalk has 27 test files totalling 4,843 lines covering the things that actually break: test_e2ee.py, test_crossed_sessions.py (the both-sides-initiate wedge), test_invite_codes.py, test_invite_watch_stall.py, test_mailbox_cap.py, test_hardening.py, test_multi_machine.py, test_receive_multi.py, test_passphrase_file.py, test_admin_api_keys.py. agent-talk has 10 files totalling 1,907 lines, including a plugin/manifest validator (tests/validate_plugin.py, 267 lines) and real subprocess tests of the monitor scripts, the spool writer, the Codex hook and codex_wake.

CI. Both green and both sensible. retalk runs `uv run python -m unittest discover -s tests -v` on push and PR. agent-talk's .github/workflows/ci.yml is the more impressive one: a deterministic "no LLM, no auth, no secrets" validate job, plus an install-smoke job that installs the plugin into claude, codex, pi, opencode, copilot and antigravity in a credential-free container and asserts all 15 SKILL.md files land in each. Someone thought about what CI can actually prove for a plugin.

CONTRIBUTORS. One. `git shortlog -sne` on both (shallow 50-commit clones) shows only Xing Han Lu under two email addresses, 50 commits each. 1,453 stars on agmsg and 169 here do not change the bus factor. Last commits: retalk 2026-08-16, agent-talk 2026-08-21, so it is actively maintained right now, by one person.

CODE QUALITY. Genuinely high, and unusually so for a solo project. The server is standard library only. The comments explain WHY rather than what, and repeatedly document a bug that was actually hit: the multi-session store fix (user.py:132-160), the zombie pid check (follow.sh:67-70), the peek-versus-drain reasoning (user.py:1065-1084), the argparse-hostile leading-dash in invite codes (store.py:232-239), the truncate-and-refill spool fingerprint (inbox-hook.py:99-106). The failure modes are handled thoughtfully: mailbox caps reject rather than evict so the sender's outbox retries, an undecryptable message gets a signed nack and a session reset rather than crashing the poll, a refused GROUP copy prunes the sender's local roster.

WHERE IT IS WEAK. No independent audit, and both SECURITY.md files say so plainly. The store-key KDF (user.py:118) is wrong. The plugin layer is bash and text files where the client layer is careful Python. And the thing a security reviewer should flag hardest is not in either SECURITY.md: nothing in the design reasons about a peer's plaintext reaching a model with Bash access.

INVITE CODES, since you asked specifically. `store.py:220-245`. Entropy is `secrets.token_urlsafe(16)`, so 128 bits in 22 base64url characters, redrawn if it starts with '-' (costs about one draw in 64, entropy intact). Default kind is single-use with a 7-day expiry; `--permanent` is multi-use until revoked; `--expires 0` never expires. It is a pure BEARER TOKEN. There is no PAKE, no SPAKE2, no short-authenticated-string comparison, nothing. Exchange is entirely out of band, pasted into whatever channel you like along with the inviter's fingerprint and relay URL. Redemption is `request_contact` (user.py:1043-1063): the requester must ALREADY have the inviter's 32-hex fingerprint, adds and pins them, then sends an Olm-encrypted `{"kind":"contact_request","code","card"}`. Acceptance is `invite_watch` (user.py:1065-1184), which peeks the mailbox, ignores known and blocked senders, only touches mtype 0 pre-key messages, decrypts purely to classify (persisting nothing until it accepts), checks the card is self-consistent and matches the sender, then does a compare-and-swap on the code under the identity's file lock (`use_invite`, store.py:282-304, returning ok / duplicate / unknown-code / revoked / expired / consumed). Identities persist as rows in the local `peers` table with pinned identity and signing keys (store.record_peer_keys). The threat model is stated accurately and repeatedly rather than being oversold: "A valid code proves the sender was AUTHORISED by whoever issued it, not that the keys belong to a particular human" (user.py:1020-1025), and the plugin makes it a standing session rule that the agent must never call such a peer "verified" (skills/init/SKILL.md session rule 9). Acceptance is deliberately not observable to the requester, so there is no code-status oracle. Anyone who intercepts the code plus the fingerprint can register as the peer; that is the whole risk and the docs say so.

VERDICT. Split it. DEPEND on retalk: it is on PyPI, MIT, tested, single-dependency, and its library API is a real API. Writing your own Olm bus for seshi would be months of work to end up somewhere worse, and the crossed-sessions and nack machinery alone justify it. VENDOR OR REWRITE agent-talk: it is glue, its delivery mechanism is the thing seshi most needs to be different (poll versus push, background context versus real wake), and its safety properties live in markdown rather than in code. Take the four or five ideas listed under reusable, take the CI shape, and write the rest. And whatever you do, treat the delivery question as unsolved rather than solved by this project, because on Claude Code specifically the declared plugin surface does not wake the session and the one that does is a paragraph of instructions to the model.

---

# agmsg (github.com/fujibee/agmsg) — v1.2.2, MIT, 1453 stars, ~33k lines of bash + a Node sync engine + a Fastify reference server

## Headline
The wake mechanism is real and stealable: a SessionStart hook prints a plain-text instruction telling Claude Code to launch `watch.sh` as a persistent Monitor background task, and that task's stdout lands in the idle session as a notification. But the brief is out of date on two counts — agmsg is no longer local-only (it has a remote server, a per-team sync daemon, and age-v1 E2EE), and its own repo therefore disproves the "no daemon" claim the moment a network is involved.

## How it works
## The three-axis model

`ARCHITECTURE.md:13-23` sets it out: three orthogonal driver axes, one active driver each.

- **storage** — where messages live (`sqlite` default, `jsonl-duckdb`)
- **agent** — per-runtime differences (`claude-code`, `codex`, `gemini`, `copilot`, `antigravity`, `opencode`, `cursor`, `grok-build`, `hermes`)
- **delivery** — how a recipient is notified (`monitor`, `turn`, `both`, `off`)

Each agent type is declared by a flat key=value manifest that is read as DATA and never sourced (`/Users/jakeshelley/dev/jiffi-seshi/reference/agmsg/scripts/drivers/types/claude-code/type.conf`):

```
name=claude-code
cli=claude
resume_arg=--resume
detect=CLAUDE_CODE_SESSION_ID
detect_proc=claude claude-code claude-*
hooks_file=.claude/settings.local.json
monitor=yes
delivery_modes=monitor turn both off
```

Behavioural overrides live beside it as a `_delivery.sh` / `_session-start.sh` plug that gets sourced into `delivery.sh`'s function context (Template Method — `scripts/delivery.sh:177-193`). This is a clean, genuinely extensible shape.

## Storage: append-only event log projected for reads

`scripts/drivers/storage/sqlite.sh:112-160`:

```sql
CREATE TABLE IF NOT EXISTS events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,     -- 'message_sent' | 'message_read'
  id         TEXT NOT NULL,     -- UUIDv7, opaque
  team       TEXT, from_agent TEXT, to_agent TEXT, body TEXT,
  msg_id     TEXT, agent TEXT,  -- for 'message_read' rows
  at         TEXT NOT NULL,
  legacy_id  INTEGER            -- rowid of the mirror in the old `messages` table
);
CREATE TABLE IF NOT EXISTS read_cursors (
  team TEXT NOT NULL, agent TEXT NOT NULL,
  local_position INTEGER NOT NULL DEFAULT 0 CHECK(local_position >= 0),
  PRIMARY KEY(team, agent)
);
```

There is no `agents` table and no `teams` table in the message store. A **team** is a directory under `teams/<name>/` holding config; an **agent** is a `(team, name, type, project_path)` registration written by `join.sh`; a **message** is one `message_sent` event row. Ordering is `seq`, a single AUTOINCREMENT counter per store — deliberately a local ordering, not a causal one.

Read state is a **hybrid**: a contiguous integer frontier (`read_cursors.local_position`) plus exact `message_read` events for out-of-order acks. `storage_read_cursor_consume` (`sqlite.sh:298-338`) records the exact ids first, then advances the frontier only to just before the first still-unread addressed message:

```sql
UPDATE read_cursors SET local_position=MAX(local_position,COALESCE((
  SELECT MIN(e.seq)-1 FROM events e
   WHERE e.type='message_sent' AND e.team=... AND e.to_agent=...
     AND e.seq>read_cursors.local_position
     AND e.seq<=MIN($target, <highwater>)
     AND NOT EXISTS(SELECT 1 FROM events r WHERE r.type='message_read' ...)
),MIN($target, <highwater>)))
```

So a caller presenting a bogus later cursor cannot skip an unseen row. That defensive framing is worth copying.

The scan (`storage_watch_after`, `sqlite.sh:412-436`) returns rows AND a trailing cursor inside one deferred read transaction, with an explicit comment about why: "a row inserted between the two statements would advance the cursor past a message the scan never returned — a silent skip."

## Remote: NOT local-only any more

The brief says local-only; that is no longer true.

- `server/` — a Fastify + Postgres reference server. Routes at `server/src/app.ts:186-306`: `/v1/connect`, `/v1/messages` (GET/POST), `/v1/members`, `/v1/read-state/sync`, `/v1/teams`.
- Server-side schema (`server/migrations/001_initial.sql`) has `teams`, `messages`, `message_tombstones`, `members`, `registrations`, `read_frontiers`, `read_exact`, `member_identity_history`.
- The server stores **opaque blobs**: `from`, `to`, `body` and the client timestamp are inside the envelope, never indexed (`docs/design/remote-sync.md:63-67`).
- E2EE is real: an `age-v1` profile with published test vectors (`docs/spec/vectors/age-v1-vectors.json`) and a verifier, key rotation with epochs, and a security document written to RFC 3552 structure with `file:line` citations (`docs/security.md`).

And the critical caveat, `docs/design/remote-sync.md:73-80`: **"No authentication. Reaching the server is the permission, the same way reaching the filesystem is the permission locally."** Any party who can reach the endpoint can pull, push to, or forget any team by name. E2EE stops reading, not writing.

## Delivery mechanism
## The answer: SessionStart hook → text directive → Monitor background task → sqlite poll → notification

There is no daemon, no socket, no injection into the terminal. The chain is:

**1. `delivery.sh set monitor claude-code <project>` writes a SessionStart hook** into `<project>/.claude/settings.local.json` (`scripts/delivery.sh:139-160`):

```bash
case "$mode" in
  monitor)
    local ss="$(_agmsg_shq "$SKILL_DIR/scripts/session-start.sh") $(_agmsg_shq "$type") $(_agmsg_shq "$project")"
    local se="$(_agmsg_shq "$SKILL_DIR/scripts/session-end.sh") $(_agmsg_shq "$type") $(_agmsg_shq "$project")"
    add_event_entry_file "$tmp_state" "SessionStart" "$ss" "$ww"
    add_event_entry_file "$tmp_state" "SessionEnd"   "$se" "$ww"
    ;;
```

**2. On session start, that hook prints English at the model.** This is the whole trick — `scripts/session-start.sh:365-383`:

```bash
WATCH_COMMAND="$(printf '%q %q %q %q' "$WATCH" "$INSTANCE_ID" "$PROJECT" "$TYPE")"

cat <<EOF
AGMSG monitor mode: invoke the Monitor tool now with the following parameters,
before any other action in this session.

  command: $WATCH_COMMAND
  description: agmsg inbox stream
  persistent: true

This streams incoming agmsg messages into the session in real time. Each
output line is one message: \`<ts> | <team> | <from> → <to> | <body>\`.
React to messages as they arrive; reply with \`send.sh\`.
EOF
```

The hook does not start the watcher. It *asks the model to*. The model reads the hook output as context and invokes Claude Code's built-in Monitor tool with `persistent: true`.

**3. `watch.sh` is a plain bash polling loop, not a blocking read** (`scripts/watch.sh:583`, `690-693`, `746`, `776-781`):

```bash
while true; do
  ...
  READ_CURSOR="$(storage_read_cursor_get "$pair_team" "$pair_agent" ...)"
  OUT="$(storage_watch_after "$READ_CURSOR" "$pair_team:$pair_agent" ...)"
  ...
      if ! printf '%s | %s | %s → %s | %s\n' "$ts" "$team" "$from" "$to" "$body"; then
        cleanup
        exit 0
      fi
  ...
  # Run sleep in the background and `wait` for it so signal traps fire
  # immediately. Bash defers traps while a foreground builtin like `sleep`
  # is blocking, which would otherwise delay shutdown by up to $INTERVAL.
  sleep "$INTERVAL" 3>&- 4>&- &
  wait $!
done
```

`INTERVAL` defaults to 5s (`watch.sh:194-198`, overridable via `AGMSG_WATCH_INTERVAL` or `delivery.monitor.poll_interval`).

**4. Monitor's stdout is what wakes the session.** The line printed by `printf` at `watch.sh:746` is delivered by Claude Code's Monitor tool as a task notification into the session. An idle session receiving a notification takes a turn. That is the mechanism, and it needs nothing from agmsg beyond writing a line to stdout.

## The second, different mechanism: `turn` mode forces a turn

`turn` mode installs a **Stop** hook running `check-inbox.sh`, which exploits Claude Code's stop-blocking contract (`scripts/check-inbox.sh:328-337`):

```bash
cat <<ENDJSON
{
  "decision": "block",
  "reason": "$ESCAPED"
}
ENDJSON
exit 0
```

`decision: block` un-stops the agent and injects `reason` as the next turn. This is a genuinely *forced* wake — it cannot be ignored the way a notification can. Its loop guard is one line (`check-inbox.sh:52-56`):

```bash
# Prevent infinite loop: if stop hook is already active, exit silently
if echo "$INPUT" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true' 2>/dev/null; then
  exit 0
fi
```

## The third mechanism (Codex): a real RPC bridge

Because Codex has no Monitor tool, they wrote 1801 lines of Node (`scripts/drivers/types/codex/codex-bridge.js`) that connects to the codex app-server over unix socket / websocket, resumes the live TUI thread via `thread/loaded/list`, then injects a turn (`codex-bridge.js:1460-1466`):

```javascript
await this.client.request("turn/start", {
  threadId: this.threadId,
  input: [{ type: "text", text: prompt, text_elements: [] }],
  cwd: this.opts.project,
  runtimeWorkspaceRoots: this.opts.workspaceRoots,
});
```

Gated by `watch-once.sh`, a shell-only one-shot oracle (exit 0 = unread exists, exit 2 = nothing) so a turn is never started on an empty inbox.

## Honest assessment

**Does it burn tokens while idling?** No. `watch.sh` prints nothing when there is nothing, so an idle session receives no notification and takes no turn. Cost is one `sqlite3` fork every 5s per watcher — CPU and process pressure, not tokens. The `turn`-mode path is similarly free (silent exit or a tiny status JSON). Token cost is exactly one agent turn per delivered message, which is the irreducible price.

**Does it work when the human is away?** For `monitor`, yes, with one documented caveat that matters (`README.md:267`): *"the receiving agent doesn't react to its first inbound message until it has taken at least one turn this session. If you've just started a fresh session and a teammate has already sent something, nudge the agent with any short message."* So a cold session needs one human keystroke to prime. After that it runs unattended — that is what the tic-tac-toe demo shows. For `turn` mode: no, delivery only lands when the human next prompts.

**Does it survive the agent deciding to do something else?** Only partly, and this is the weakest joint. The whole arm is LLM-cooperative: the hook *asks* the model to invoke Monitor, and nothing checks that it did (the skill template adds a belt-and-braces "check whether this session already has an `agmsg inbox stream` Monitor task in its TaskList" at `claude-code/template.md:113-119`, which is again an instruction, not a mechanism). The agent owns the Monitor task and is told to `TaskStop` it during `actas` and `drop` flows. If the agent is mid-turn, the notification queues. `watch.sh` self-exits if the install changes underneath it (`watch.sh:589-592`) or if its parent agent pid dies. And the reply is also cooperative — nothing forces the model to call `send.sh` back. `turn` mode is the only leg with a hard forcing function, and it costs realtime.

The load-bearing lesson for seshi: **the wake is mechanical (a background task's stdout becomes a notification), but the arming and the answering are both prompts.** If seshi wants a guaranteed round trip it needs the Stop-hook `decision: block` path, or something like it, as the floor under the Monitor path — which is exactly what `both` mode is.

## Reusable
- The whole monitor arming pattern, verbatim: `scripts/session-start.sh:365-383` prints a Monitor-tool directive as plain text from a SessionStart hook, and `scripts/delivery.sh:139-160` installs that hook idempotently into `.claude/settings.local.json` (strip agmsg-owned entries first, then re-add for the chosen mode). This is the cheapest known way to get a persistent background stream into a subscription-authenticated Claude Code session with no API key.
- The `decision: block` Stop-hook forcing function at `scripts/check-inbox.sh:328-337`, with its `stop_hook_active` guard at lines 52-56. This is the only leg in the repo that can make an agent take a turn it did not choose to take. seshi needs this as the floor under the notification path, and needs the same guard.
- `scripts/watch.sh:776-781` — run `sleep` in the background and `wait` on it so signal traps fire immediately instead of being deferred by up to one poll interval. Small, correct, and the kind of thing you only learn by shipping.
- The hybrid read-state model: `read_cursors.local_position` (contiguous frontier) plus exact `message_read` events, in `scripts/drivers/storage/sqlite.sh:155-160` and `287-338`. Critically, `storage_read_cursor_consume` caps the frontier immediately before the first still-unread addressed message so a stale or malicious caller cannot skip an unseen row by presenting a later cursor. Directly applicable to seshi's append-only log.
- `storage_watch_after` at `scripts/drivers/storage/sqlite.sh:412-436` — the scan and the high-water read happen inside one deferred read transaction so the emitted cursor can never run ahead of what the scan saw. The comment explains the silent-skip bug this prevents. Copy the invariant.
- `scripts/drivers/types/codex/watch-once.sh` — a cheap shell-only one-shot inbox oracle (exit 0 pending / exit 2 timeout / exit 1 error) that gates whether the expensive agent runs at all. seshi wants exactly this two-stage shape for any scheduled or unattended path.
- The type-manifest pattern: `scripts/drivers/types/<name>/type.conf` is flat key=value read as DATA, never sourced, with optional `_delivery.sh` / `_session-start.sh` plugs sourced into the caller's function context. Clean plugin boundary with no eval surface.
- Resume plumbing at `scripts/lib/boot-command.sh:34-55` — `agmsg_role_resume_uuid` records a role's session uuid, then delegates the transcript-existence check to a per-type driver hook and fails open to a fresh boot. Feeds `claude --resume <uuid>` plus `-n <team>-<agent>` naming so the session is findable in the resume picker. This is most of seshi's requirement 10 already solved.
- `scripts/lib/registry-lock.sh` and `scripts/lib/actas-lock.sh` — mkdir-based atomic locking with liveness GC keyed on pid, chosen explicitly because "mkdir is atomic on POSIX and needs no daemon". Their `actas` exclusivity lock (one live session owns a role at a time) is the primitive seshi needs so two of Jake's windows don't both answer as him.
- `docs/security.md` as a template for how to write seshi's trust document: RFC 3552 structure, three named adversaries, every central claim carrying a `file:line`, and an explicit paragraph retracting an earlier overclaim about its own rigour. If seshi ships a trust model to strangers, this is the standard to write to.
- `docs/codex-monitor-beta.md:190-260` — a written post-mortem of an actual runaway (60 Codex sessions in 3 hours, 2.2 GB log DB, 158 GB memory, macOS jetsam) plus the four defence-in-depth measures. Read it before designing seshi's budget guard; it is the failure Jake is worried about, already observed.

## Avoid
- Do not take the "invoke the Monitor tool now" directive as sufficient on its own. It is a request to an LLM, unverified. There is no check anywhere that the Monitor actually started; the skill template adds a second English instruction to check the TaskList (`claude-code/template.md:113-119`), which is the same class of thing. seshi needs a mechanical confirmation (agmsg's own `run/ready.*` sentinel, which `spawn.sh:713-721` blocks on, is the right idea — extend it, don't trust the prose).
- Do not copy the rule-file cross-vendor integration. `scripts/lib/delivery-rulefile.sh:11-38` writes a markdown file that says "After each tool call, automatically check the agmsg inbox" and calls that an integration. gemini, antigravity, cursor and opencode-without-plugin all get this. It is a hope, not a mechanism, and its `monitor` case silently downgrades to `turn` with a warning to stderr that nobody reads.
- Do not copy the naming. "driver", "plug", "axis", "type", "plugin", "storage" as a synonym for "storage driver" — ARCHITECTURE.md needs a vocabulary table (lines 65-76) to keep them apart. Three orthogonal axes was the right idea; six words for four concepts was not.
- Do not put the message store beside the scripts. `SKILL_DIR/db/messages.db` means an install directory is also a data directory. I ran a smoke test with `AGMSG_HOME_ROOT` set and it still wrote `db/` and `teams/` into the repo clone, because scripts resolve `SKILL_DIR` from `$0` and only `AGMSG_STORAGE_PATH` actually redirects (`scripts/lib/storage.sh:51-53`). There is an ADR about a home-root override (`docs/adr/0004`) and the override that works is a different variable. seshi should separate code and data from day one.
- Do not adopt "reaching the server is the permission" (`docs/design/remote-sync.md:73-80`). For agmsg's stated case (your server, your network, your own machines) it is defensible. For seshi — two strangers, per-peer trust tiers, an abuse model that has to be real — it is the opposite of the requirement. Any party who can reach the endpoint can pull or push any team by name.
- Do not put multi-paragraph incident narratives inside function bodies. `check-inbox.sh` has ~120 lines of prose to ~230 lines of code; `watch.sh` opens with a 40-line essay on log rotation. The reasoning is genuinely good and belongs in ADRs or commit bodies, not wrapped around the `if`. It makes the actual control flow hard to hold in your head, which for a distributed messaging layer is a real cost.
- Do not use a single AUTOINCREMENT `seq` as the ordering primitive if messages will ever originate on two machines. It works locally because there is one writer file; the remote path had to bolt a whole second schema on top (`sync_messages`, `sync_read_remote_exact`, `sync_read_aliases`, `sync_read_prepared`, `sync_quarantine`, `sync_conflicts` — `scripts/drivers/storage/sqlite-sync.sh:219-370`) to reconcile local seq with server seq. seshi should pick a per-origin ordering (hybrid logical clock, or origin+counter) before writing the first row.

## Gaps vs seshi
- Per-peer trust tiers (requirement 3) — completely absent, and there is no seam for them. A delivered message is a line of text injected into a session that already has full local tool access. There is no read-only mode, no propose-writes-with-approval, no per-contact policy. The only access control in the codebase is the `actas` exclusivity lock, which answers "which of my sessions owns this role", not "what may this peer cause me to do". seshi builds this from zero.
- Session modes with done-conditions (requirement 6) — absent by explicit design. README.md:360-362: "Turn-taking between agents is a protocol-level concern, not enforced by the transport. The floor is intentionally dumb; the protocol lives in your prompts." No TEACH/DECIDE/BUILD/REVIEW, no acceptance tests, no convergence detection.
- Private advocate brief and concession ladder (requirement 7) — absent. There is no per-agent private state at all. Everything an agent knows about the conversation is either its own context window or the shared message log. Nothing distinguishes "transmittable" from "never transmit", and nothing produces a public projection for human approval.
- Open-issues ledger and mechanical deadlock detection (requirement 8) — absent as a conversation concept. The nearest mechanical analogue is `codex-bridge.js:1663-1680`, `isStaleWake()`, which stops the bridge when the unread frontier id is unchanged across wakes ("stopping to avoid a repeated wakeup loop"). That is loop detection on the delivery layer, not deadlock detection on the argument. Nothing tracks open questions or requires them to reach zero.
- Human-in-the-loop supervision (requirement 4) — partial and incidental. The human sees the Monitor stream because it lands in their own session, and can type at any time. But there is no interjection primitive that reaches both sides, no stuck-detection, and no ping. `despawn` sends a `ctrl:despawn` control message that a watcher acts on deterministically (`watch.sh:716-745`) — that is the one out-of-band control channel and it only kills things.
- Per-contact relationship memory (requirement 9) — absent. The store is durable and `history.sh <team>` replays a room, so there is a de facto shared log, but there is no per-contact profile, no warm start, and README.md:392-396 concedes: "There's no one-shot rehydrate from room X command yet."
- AirDrop-style pairing (requirement 11) — not close. Pairing is `remote.sh connect --endpoint <url> <team>` on one machine and `remote.sh pull --endpoint <url> <team>` on the other. No accounts is true; short code, no website and no discovery are not. You must stand up your own Postgres-backed Fastify server first. `docs/design/ref/device-pairing.md` designs a proper pairing flow with rate limiting, and the skill template says flatly it is not implemented: "Device pairing (`key request` / `key approve`) is not implemented — they are not `key.sh` subcommands."
- Two DIFFERENT PEOPLE (requirement 1) — the model is one operator's team of agents, possibly across their own machines. There is no notion of a person distinct from an agent, no per-person identity, no consent at the boundary. Cross-machine works; cross-person does not, and the missing piece is exactly the auth the design deliberately removed.
- Cross-machine performance at conversational scale is unproven for large histories. `tests/perf/README.md:53` reports a real incident: a 17,300-message pull took 59 minutes at 204 ms/msg, then the reprocess of quarantined rows ran at 934 ms/msg for 3h25m and died at 13,200 of 17,300. They have since indexed `events.legacy_id` and `events.id` and cut fork counts hard, but a bash-and-sqlite sync engine paying per-message process forks is a real ceiling seshi should not inherit.

## Licence
MIT (`LICENSE`, "Copyright (c) 2026 fujibee"). Clean and permissive — vendoring specific scripts or lifting the delivery pattern is unencumbered, attribution only. The npm package `agmsg` is a thin bootstrapper that fetches and runs the bash installer from GitHub, so it is not a real dependency surface. The reference server is `private: true` under `@agmsg/reference-server` and depends on Fastify 5.10 + Postgres.

## Maturity
**The quality is real, and unusually so for a bash project.**

Tests: 1,678 bats tests across 89 files (`tests/*.bats`), plus 5 Node test files for the crypto and sync engine, plus Vitest for the server and the Tauri app's TS. They are genuine integration tests, not mocks — `tests/test_watch.bats` launches the real `watch.sh` against a real sqlite store and waits on conditions rather than sleeping, with a comment explaining that a fixed sleep "encodes 'the watcher is usually done by now', which is a claim about the machine rather than about the watcher" and naming the two CI failures that taught them.

CI (`.github/workflows/tests.yml`, 1000+ lines): ubuntu + macos, 4 shards each, plus a separate Windows/MSYS leg, plus `storage-jsonl`, `app-check`, `server-check`, `app-test-windows`, `enforced-assertions`, `private-names`. The docs-only skip is implemented carefully so that required status checks still report green rather than hanging pending forever. The age-v1 crypto contract has published test vectors and a Rust grease file (`docs/spec/vectors/`). PR runs cancel superseded runs because they measured a 50-minute macOS queue wait.

Cross-platform care is serious: bash 3.2 (stock macOS) quoting hazards documented at every site, Git Bash / MSYS pid-space distinctions (`_agmsg_pid_alive_local` vs `_agmsg_pid_alive`), Windows sqlite3 pinned by URL + version + SHA256.

I smoke-tested it: `join.sh` × 2, `send.sh`, `inbox.sh` — worked first try, correct output, no surprises.

**Bus factor: 1.** `git shortlog`: fujibee 72 commits, four other contributors with 1-2 each. Everything meaningful is one person. Development is intense — 30+ merges visible in recent history, last push 2026-08-22, mostly perf work on the sync engine driven by a real production incident.

**Verdict for seshi: learn from it and lift specific files; do not take a dependency.**

- Do not depend: it solves an adjacent problem (one operator's agents on one machine, optionally synced across their own machines), the API surface is a directory of bash scripts with no stability contract, the data lives beside the code, and the remote path has no auth by design. Bus factor 1.
- Do vendor, with attribution: the SessionStart→Monitor directive pattern, the `decision: block` Stop-hook path with its `stop_hook_active` guard, the `sleep &; wait` trap trick, the read-cursor consume invariant, and `watch-once.sh`'s cheap-gate shape. These are small, self-contained, and each encodes a bug someone already paid for.
- Do read cover to cover before designing seshi's runaway guard: `docs/codex-monitor-beta.md` and `docs/security.md`.

**One structural warning.** The commented-out reasoning density is extreme — `check-inbox.sh` runs roughly 120 lines of prose against 230 lines of code, and `watch.sh` opens with a 40-line essay on log rotation caps. It reads as a project that has been debugged hard in production and refuses to lose the lesson, which is admirable. It also means the actual control flow of a distributed messaging layer is hard to hold in one head. If seshi copies the discipline, put it in ADRs.