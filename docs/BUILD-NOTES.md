# Build notes (read before writing code)

## Runtime
Node 24 runs TypeScript natively. There is **no build step**, no tsx, no ts-node.
- Run tests: `node --test 'packages/core/test/**/*.test.ts'`
- Typecheck: `npx tsc --noEmit -p tsconfig.json`

`erasableSyntaxOnly` is on, so **no enums, no namespaces, no parameter properties,
no `declare` fields**. Use `const` objects and union types instead of enums.

## Imports
Relative imports MUST carry the `.ts` extension: `import { x } from "./identity.ts"`.

## No dependencies in the client. None.

`seshi` ships as a Claude Code plugin, and the whole promise is that installing
it is one line. Every runtime dependency is an `npm install` a user has to run,
so the client has zero of them: `package.json` has no `dependencies` block at
all, and it stays that way. Node 24 does all of it natively.

`ws` survives as a **devDependency** because the relay SERVER needs a WebSocket
server, which Node has no built-in for. Nobody running seshi runs a relay, and
`packages/cli/src/index.ts` imports the relay lazily, inside the `relay`
subcommand, so a missing `ws` cannot break any other command.

## Exact crypto API (verified on this machine, do not guess)

All of it is `node:crypto`. Keys live as raw 32 byte `Uint8Array`s everywhere in
seshi, and `packages/core/src/identity.ts` is the ONLY place that knows how to
turn those into the DER node:crypto actually wants. Import `signBytes`,
`verifyBytes`, `sharedSecret` and `generateSealPair` from there rather than
building a second copy of that plumbing.

```ts
import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync } from "node:crypto";
import { generateSealPair, sharedSecret, signBytes, verifyBytes } from "./identity.ts";

const sig = signBytes(msgBytes, signPriv);         // Uint8Array(64)
const ok  = verifyBytes(sig, msgBytes, signPub);   // false, never a throw

const eph    = generateSealPair();                 // { pub, priv }, both 32 bytes
const shared = sharedSecret(eph.priv, theirSealPub);

// chacha20-poly1305 is the IETF one: a 12 byte nonce, not XChaCha's 24. That is
// safe here only because sealEnvelope makes a fresh ephemeral pair per message,
// so no AEAD key is ever used twice. Read the comment on NONCE_BYTES first.
const cipher = createCipheriv("chacha20-poly1305", key32, nonce12, { authTagLength: 16 });
const ct     = Buffer.concat([cipher.update(pt), cipher.final(), cipher.getAuthTag()]);

const sha = createHash("sha256").update(str, "utf8").digest("hex");
```

Sockets: the client uses Node's global `WebSocket` (`new WebSocket(url)` plus
`addEventListener("open"|"message"|"close"|"error")`). Only the relay server
imports `ws`, and only `WebSocketServer` is unavailable natively.

## Rules that are not negotiable
- Never set, read, or require `ANTHROPIC_API_KEY`. Never pass `--bare` to `claude`.
- Peer agents always spawn with `--setting-sources user`.
- Tiers are deny lists. Never emit a `permissions.allow` for tools.
- `SendMessage` and `ListAgents` are denied in every peer process.
- The receiving daemon stamps `from`. Never read identity from a message body.
