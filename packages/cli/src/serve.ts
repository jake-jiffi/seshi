/**
 * `seshi serve` — one command that puts a relay on the internet.
 *
 * The relay has to be reachable from both machines, and the honest ways to do
 * that (a VPS, a tunnel in a second terminal, port forwarding) are all a bigger
 * ask than the thing they enable. So this starts the relay, opens a tunnel if a
 * tunnel tool is installed, and prints the one line the other person runs.
 *
 * A quick tunnel dies when this process does, which is the right default for a
 * conversation between two people who are both at their desks. Anything ongoing
 * wants a real host, and the closing note says so.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { writeConfig } from "./config.ts";

type Tunnel = { url: string; child: ChildProcess; tool: string };

/** Tools that can expose a local port, in the order we would rather use them. */
const TUNNELS = [
  {
    tool: "cloudflared",
    args: (port: number) => ["tunnel", "--url", `http://localhost:${port}`, "--no-autoupdate"],
    match: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/,
  },
  {
    tool: "ngrok",
    args: (port: number) => ["http", String(port), "--log", "stdout"],
    match: /https:\/\/[a-z0-9-]+\.ngrok[a-z.-]*\.app/,
  },
] as const;

/**
 * A quick tunnel prints a hostname before Cloudflare has finished publishing
 * it, and sometimes prints one that never comes up at all while the
 * cloudflared process sits there looking healthy. Handing that address to
 * someone costs them a failed join and tells them nothing, so prove it answers
 * before we call it live.
 */
async function reachable(wsUrl: string, tries = 6, gapMs = 4_000): Promise<boolean> {
  const url = wsUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
  for (let i = 0; i < tries; i++) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(5_000) });
      return true;
    } catch {
      // Resolves to nothing yet. Give it a moment.
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, gapMs));
  }
  return false;
}

function have(tool: string): Promise<boolean> {
  // No shell. Passing args through a shell concatenates rather than escapes
  // them, which Node deprecated for exactly the reason you would guess.
  return new Promise((resolve) => {
    const c = spawn("/usr/bin/env", ["which", tool], { stdio: "ignore" });
    c.on("exit", (code) => resolve(code === 0));
    c.on("error", () => resolve(false));
  });
}

function openTunnel(port: number, timeoutMs = 45_000): Promise<Tunnel | null> {
  return (async () => {
    for (const t of TUNNELS) {
      if (!(await have(t.tool))) continue;
      const child = spawn(t.tool, t.args(port), { stdio: ["ignore", "pipe", "pipe"] });
      const url = await new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        const scan = (chunk: Buffer): void => {
          const m = t.match.exec(chunk.toString());
          if (m !== null) {
            clearTimeout(timer);
            resolve(m[0]);
          }
        };
        child.stdout?.on("data", scan);
        child.stderr?.on("data", scan);
        child.on("exit", () => {
          clearTimeout(timer);
          resolve(null);
        });
      });
      if (url !== null) return { url, child, tool: t.tool };
      child.kill();
    }
    return null;
  })();
}

export async function serve(port: number): Promise<number> {
  // The only dependency in the whole project, and only the person hosting ever
  // needs it. Everyone else runs seshi with nothing installed at all.
  let startRelay: (o: { port: number }) => Promise<{ port: number; close(): Promise<void> }>;
  try {
    ({ startRelay } = await import("../../relay/src/server.ts"));
  } catch (err) {
    if (!/Cannot find package 'ws'/.test((err as Error).message)) throw err;
    process.stderr.write(
      `\n  Running a relay needs one package, because Node ships a WebSocket client\n` +
        `  but not a server. Install it once, here in the seshi directory:\n\n` +
        `      npm install\n\n` +
        `  Only the person hosting needs this. Everyone joining needs nothing.\n`,
    );
    return 1;
  }

  const relay = await startRelay({ port });
  const local = `ws://127.0.0.1:${relay.port}`;

  process.stdout.write(`\n  relay running on ${local}\n`);
  process.stdout.write(`  looking for a way to put it on the internet...\n`);

  const tunnel = await openTunnel(relay.port);
  const address = tunnel === null ? local : tunnel.url.replace(/^https:/, "wss:");

  if (tunnel === null) {
    process.stdout.write(
      `\n  No tunnel tool found, so this relay is only reachable on this machine.\n` +
        `  Install one and run this again:\n\n` +
        `      brew install cloudflared\n\n` +
        `  Or put the relay on a host you own and point both sides at it.\n`,
    );
  } else {
    process.stdout.write(`  tunnelled with ${tunnel.tool}, checking it answers...\n`);
    if (await reachable(address)) {
      process.stdout.write(`  reachable\n`);
    } else {
      process.stdout.write(
        `\n  That tunnel is not answering, so the address below is dead and\n` +
          `  nobody can join through it. Ctrl-C and run seshi serve again.\n`,
      );
    }
  }

  // Hosting a relay and then being told to point yourself at it by hand was
  // pure ceremony, and the other person never needed it at all: the join link
  // carries the address.
  writeConfig({ relay: address });

  process.stdout.write(
    `\n  ${"─".repeat(66)}\n` +
      `  Relay live at ${address}\n` +
      `  Already set as yours. Start talking, in another terminal:\n\n` +
      `      seshi start "what you want to settle"\n` +
      `  ${"─".repeat(66)}\n\n` +
      `  This relay forwards encrypted frames between two paired people and\n` +
      `  queues them when one side is offline. It sees ciphertext and two\n` +
      `  fingerprints. It cannot read anything either of you says.\n\n` +
      `  Leave this running. Ctrl-C stops the relay${tunnel === null ? "" : " and the tunnel"}.\n`,
  );

  const shutdown = (): void => {
    process.stdout.write("\n  stopping.\n");
    tunnel?.child.kill();
    void relay.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => {});
  return 0;
}
