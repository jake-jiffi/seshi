# Build notes (read before writing code)

## Runtime
Node 24 runs TypeScript natively. There is **no build step**, no tsx, no ts-node.
- Run tests: `node --test 'packages/core/test/**/*.test.ts'`
- Typecheck: `npx tsc --noEmit -p tsconfig.json`

`erasableSyntaxOnly` is on, so **no enums, no namespaces, no parameter properties,
no `declare` fields**. Use `const` objects and union types instead of enums.

## Imports
Relative imports MUST carry the `.ts` extension: `import { x } from "./identity.ts"`.
Package imports MUST carry `.js`: `@noble/curves/ed25519.js`.

## Exact crypto API (verified on this machine, do not guess)

```ts
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const priv = ed25519.utils.randomSecretKey();      // Uint8Array(32)
const pub  = ed25519.getPublicKey(priv);
const sig  = ed25519.sign(msgBytes, priv);         // Uint8Array(64)
const ok   = ed25519.verify(sig, msgBytes, pub);

const xpriv   = x25519.utils.randomSecretKey();
const xpub    = x25519.getPublicKey(xpriv);
const shared  = x25519.getSharedSecret(xpriv, theirXpub);

const aead = xchacha20poly1305(key32, nonce24);
const ct   = aead.encrypt(plaintextBytes);
const pt   = aead.decrypt(ct);                     // throws on auth failure
```

`ws`: `import { WebSocketServer, WebSocket } from "ws";`

## Rules that are not negotiable
- Never set, read, or require `ANTHROPIC_API_KEY`. Never pass `--bare` to `claude`.
- Peer agents always spawn with `--setting-sources user`.
- Tiers are deny lists. Never emit a `permissions.allow` for tools.
- `SendMessage` and `ListAgents` are denied in every peer process.
- The receiving daemon stamps `from`. Never read identity from a message body.
