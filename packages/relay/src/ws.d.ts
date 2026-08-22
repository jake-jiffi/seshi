// Minimal ambient types for `ws`. The package ships no declarations and
// `@types/ws` is not a dependency of this workspace, so this covers exactly the
// surface `server.ts` uses. Delete this file if `@types/ws` is ever installed.
declare module "ws" {
  class WebSocket {
    static readonly OPEN: number;
    readonly readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    on(event: "message", cb: (data: Buffer) => void): this;
    on(event: "close", cb: () => void): this;
    on(event: "error", cb: (err: Error) => void): this;
  }

  class WebSocketServer {
    constructor(options: { port?: number; host?: string; maxPayload?: number });
    readonly clients: Set<WebSocket>;
    address(): { address: string; family: string; port: number } | string | null;
    on(event: "connection", cb: (socket: WebSocket) => void): this;
    once(event: "listening", cb: () => void): this;
    once(event: "error", cb: (err: Error) => void): this;
    close(cb?: (err?: Error) => void): void;
  }

  export { WebSocket, WebSocketServer };
}
