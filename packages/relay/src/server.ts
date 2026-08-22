// The relay is deliberately dumb. It sees a recipient fingerprint and an opaque
// base64 frame, and nothing else. It never decodes a frame, never stores one
// beyond the offline queue, and never writes one to a log.
//
// The relay-sees-only-ciphertext shape is taken from agent-talk/retalk (MIT).
import { WebSocketServer, WebSocket } from "ws";

/** Hard cap on one frame, enforced here rather than by convention (spec s4.2). */
const MAX_FRAME_CHARS = 256 * 1024;

/** Frames held for one offline recipient before the oldest starts falling off. */
const MAX_QUEUE = 500;

const FINGERPRINT = /^[0-9a-f]{32}$/;

type QueuedFrame = { from: string; frame: string };

export type Relay = {
  port: number;
  close(): Promise<void>;
};

const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);

export async function startRelay(opts: { port: number }): Promise<Relay> {
  /** fingerprint -> the socket currently claiming it */
  const live = new Map<string, WebSocket>();
  /** fingerprint -> frames waiting for it to come back */
  const queues = new Map<string, QueuedFrame[]>();

  const wss = new WebSocketServer({
    port: opts.port,
    // Leaves room for the JSON wrapper around a maximum-size frame while still
    // bounding what a single message can make the process buffer.
    maxPayload: MAX_FRAME_CHARS * 2,
  });

  function deliver(socket: WebSocket, from: string, frame: string): void {
    socket.send(JSON.stringify({ t: "deliver", from, frame }));
  }

  function drain(fp: string, socket: WebSocket): void {
    const queued = queues.get(fp);
    if (!queued) return;
    // Frames come off the queue only as they are handed to the socket. If the
    // socket dies part way through, whatever is left stays queued for the next
    // hello instead of being dropped on the floor.
    while (queued.length > 0 && socket.readyState === WebSocket.OPEN) {
      const item = queued.shift();
      if (!item) break;
      deliver(socket, item.from, item.frame);
    }
    if (queued.length === 0) queues.delete(fp);
  }

  function route(from: string, to: string, frame: string, reply: (m: unknown) => void): void {
    const target = live.get(to);
    if (target && target.readyState === WebSocket.OPEN) {
      deliver(target, from, frame);
      return;
    }
    let queued = queues.get(to);
    if (!queued) {
      queued = [];
      queues.set(to, queued);
    }
    if (queued.length >= MAX_QUEUE) {
      queued.shift();
      reply({ t: "overflow", to });
    }
    queued.push({ from, frame });
    reply({ t: "queued" });
  }

  wss.on("connection", (socket) => {
    let fp: string | null = null;

    const reply = (m: unknown): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(m));
    };
    const fail = (msg: string): void => reply({ t: "error", msg });

    socket.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString("utf8"));
      } catch {
        fail("malformed json");
        return;
      }
      if (typeof parsed !== "object" || parsed === null) {
        fail("expected an object");
        return;
      }
      const m = parsed as Record<string, unknown>;

      if (m["t"] === "hello") {
        // NOTE: hello is self-asserted. This prototype relay does not prove key
        // possession, so a fingerprint is a routing label here, not an identity.
        // Spec s4.2 wants authenticated endpoints; see the relay README task.
        if (fp !== null) {
          fail("already registered");
          return;
        }
        const claimed = asString(m["fp"]);
        if (claimed === null || !FINGERPRINT.test(claimed)) {
          fail("bad fingerprint");
          return;
        }
        fp = claimed;
        const previous = live.get(claimed);
        // Set first: the replaced socket's close handler checks identity before
        // deleting, so it must not find itself still registered.
        live.set(claimed, socket);
        if (previous && previous !== socket) previous.close(4000, "replaced");
        drain(claimed, socket);
        return;
      }

      if (m["t"] === "send") {
        // `from` is the fingerprint this socket said hello with. Anything the
        // body claims about identity is ignored here, and the receiving daemon
        // re-derives it from the signature anyway (spec s5.1).
        const me = fp;
        if (me === null) {
          fail("hello first");
          return;
        }
        const to = asString(m["to"]);
        if (to === null || !FINGERPRINT.test(to)) {
          fail("bad recipient");
          return;
        }
        const frame = asString(m["frame"]);
        if (frame === null) {
          fail("frame must be a base64 string");
          return;
        }
        if (frame.length > MAX_FRAME_CHARS) {
          fail("frame exceeds the 256 KB cap");
          return;
        }
        route(me, to, frame, reply);
        return;
      }

      fail("unknown message type");
    });

    socket.on("close", () => {
      if (fp !== null && live.get(fp) === socket) live.delete(fp);
    });

    // Swallowed rather than logged: a transport error can carry frame bytes.
    socket.on("error", () => {});
  });

  await new Promise<void>((resolve, reject) => {
    wss.once("listening", () => resolve());
    wss.once("error", (err) => reject(err));
  });

  const address = wss.address();
  if (address === null || typeof address === "string") {
    throw new Error("relay is not listening on a TCP port");
  }

  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const client of wss.clients) client.terminate();
        wss.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
