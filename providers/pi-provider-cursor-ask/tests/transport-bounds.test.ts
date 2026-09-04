import http2 from "node:http2";
import net from "node:net";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createBridge,
  createConnectFrameParser,
  frameConnectMessage,
  MAX_CONNECT_MESSAGE_BYTES,
  parseConnectEndStream,
  type BridgeHandle,
} from "../src/client/bridge.js";
import { decodeBase64Image } from "../src/stream/images.js";

const servers = new Set<http2.Http2Server>();
const sessions = new Set<http2.ServerHttp2Session>();
const tcpServers = new Set<net.Server>();
const sockets = new Set<net.Socket>();

async function startServer(
  onStream: (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => void,
): Promise<string> {
  const server = http2.createServer();
  servers.add(server);
  server.on("session", (session) => {
    sessions.add(session);
    session.once("close", () => sessions.delete(session));
  });
  server.on("stream", onStream);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP/2 server address");
  return `http://127.0.0.1:${address.port}`;
}

async function startStalledTcpServer(): Promise<string> {
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  tcpServers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP server address");
  return `http://127.0.0.1:${address.port}`;
}

function waitForClose(bridge: BridgeHandle): Promise<number> {
  return new Promise((resolve) => bridge.onClose(resolve));
}

function waitForStreamDone(bridge: BridgeHandle): Promise<void> {
  return new Promise((resolve) => bridge.onStreamDone(resolve));
}

async function flushEvents(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

afterEach(async () => {
  for (const session of sessions) session.destroy();
  sessions.clear();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(
    [...servers, ...tcpServers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  servers.clear();
  tcpServers.clear();
});

describe("in-process HTTP/2 streaming transport", () => {
  it("keeps the connect timeout armed until HTTP/2 settings arrive", async () => {
    const url = await startStalledTcpServer();
    const bridge = createBridge({
      accessToken: "token",
      rpcPath: "/test",
      url,
      connectTimeoutMs: 20,
      idleTimeoutMs: 0,
      pingIntervalMs: 0,
    });

    await expect(waitForClose(bridge)).resolves.toBe(1);
    expect(bridge.alive).toBe(false);
    expect(bridge.lastStderr()).toContain("connect timed out");
  });

  it("reuses one HTTP/2 session for two persistent streams", async () => {
    let streamCount = 0;
    let sessionCount = 0;
    const url = await startServer((stream) => {
      streamCount += 1;
      stream.respond({ ":status": 200 });
      stream.end(Buffer.from([streamCount]));
    });
    const server = [...servers][0]!;
    server.on("session", () => {
      sessionCount += 1;
    });

    const bridge = createBridge({
      accessToken: "token-1",
      rpcPath: "/agent.v1.AgentService/Run",
      url,
      connectTimeoutMs: 1_000,
      pingIntervalMs: 0,
    });
    const firstData: number[] = [];
    bridge.onData((chunk) => firstData.push(...chunk));
    await waitForStreamDone(bridge);

    bridge.openStream("token-2");
    const secondData: number[] = [];
    bridge.onData((chunk) => secondData.push(...chunk));
    await waitForStreamDone(bridge);

    expect(firstData).toEqual([1]);
    expect(secondData).toEqual([2]);
    expect(streamCount).toBe(2);
    expect(sessionCount).toBe(1);
    expect(bridge.alive).toBe(true);

    const closed = waitForClose(bridge);
    bridge.end();
    await expect(closed).resolves.toBe(0);
  });

  it("isolates late events from a superseded stream", async () => {
    let firstOpened!: () => void;
    const opened = new Promise<void>((resolve) => {
      firstOpened = resolve;
    });
    let streamCount = 0;
    const url = await startServer((stream) => {
      stream.on("error", () => {});
      streamCount += 1;
      stream.respond({ ":status": 200 });
      if (streamCount === 1) {
        firstOpened();
        setTimeout(() => {
          if (!stream.destroyed) stream.write(Buffer.from([99]));
        }, 10);
      } else {
        stream.end(Buffer.from([2]));
      }
    });

    const bridge = createBridge({
      accessToken: "token-1",
      rpcPath: "/test",
      url,
      pingIntervalMs: 0,
    });
    bridge.onData(() => {
      throw new Error("superseded listener must not receive new-stream data");
    });
    await opened;

    bridge.openStream("token-2");
    const received: number[] = [];
    bridge.onData((chunk) => received.push(...chunk));
    await waitForStreamDone(bridge);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received).toEqual([2]);
    expect(bridge.alive).toBe(true);
    bridge.end();
  });

  it("buffers data and stream completion that arrive before listeners", async () => {
    let responseSent!: () => void;
    const sent = new Promise<void>((resolve) => {
      responseSent = resolve;
    });
    const url = await startServer((stream) => {
      stream.respond({ ":status": 200 });
      stream.end(Buffer.from([7, 8, 9]), responseSent);
    });

    const bridge = createBridge({
      accessToken: "token",
      rpcPath: "/test",
      url,
      pingIntervalMs: 0,
    });
    await sent;
    await new Promise((resolve) => setTimeout(resolve, 20));

    const received: number[][] = [];
    const done = vi.fn();
    bridge.onData((data) => received.push(Array.from(data)));
    bridge.onStreamDone(done);

    expect(received).toEqual([[7, 8, 9]]);
    expect(done).toHaveBeenCalledOnce();
    expect(bridge.alive).toBe(true);
    bridge.end();
  });

  it("emits a Connect error frame and closes with code 1 for non-2xx responses", async () => {
    const url = await startServer((stream) => {
      stream.respond({ ":status": 503, "connect-error-message": "maintenance" });
      stream.end("unavailable");
    });
    const bridge = createBridge({
      accessToken: "token",
      rpcPath: "/test",
      url,
      pingIntervalMs: 0,
    });
    const closeCode = await waitForClose(bridge);
    const chunks: Buffer[] = [];
    bridge.onData((chunk) => chunks.push(chunk));

    const endErrors: Error[] = [];
    const parse = createConnectFrameParser(
      () => {},
      (bytes) => {
        const error = parseConnectEndStream(bytes);
        if (error) endErrors.push(error);
      },
    );
    for (const chunk of chunks) parse(chunk);

    expect(closeCode).toBe(1);
    expect(endErrors[0]?.message).toContain("Cursor HTTP 503: maintenance");
    expect(bridge.alive).toBe(false);
  });

  it("lets a server-accepted stream finish after graceful GOAWAY", async () => {
    const received: number[] = [];
    const url = await startServer((stream) => {
      stream.respond({ ":status": 200 });
      stream.session?.goaway(
        http2.constants.NGHTTP2_NO_ERROR,
        stream.id,
        Buffer.from("graceful-rotate"),
      );
      stream.end(Buffer.from([7]));
    });
    const bridge = createBridge({
      accessToken: "token",
      rpcPath: "/test",
      url,
      pingIntervalMs: 0,
    });
    bridge.onData((chunk) => received.push(...chunk));

    await waitForStreamDone(bridge);

    expect(received).toEqual([7]);
    expect(bridge.alive).toBe(true);
    expect(bridge.reusable).toBe(false);
    const closed = waitForClose(bridge);
    bridge.end();
    await expect(closed).resolves.toBe(0);
  });

  it("maps an error GOAWAY to retriable close code 2", async () => {
    const url = await startServer((stream) => {
      stream.session?.on("error", () => {});
      stream.session?.goaway(
        http2.constants.NGHTTP2_INTERNAL_ERROR,
        stream.id,
        Buffer.from("rotate"),
      );
    });
    const bridge = createBridge({
      accessToken: "token",
      rpcPath: "/test",
      url,
      pingIntervalMs: 0,
    });
    const chunks: Buffer[] = [];
    bridge.onData((chunk) => chunks.push(chunk));
    const closeCode = await waitForClose(bridge);

    expect(closeCode).toBe(2);
    expect(chunks).toEqual([]);
    expect(bridge.lastStderr()).toContain("errorCode=2");
  });

  it("contains exceptions thrown by data consumers", async () => {
    const events: string[] = [];
    const url = await startServer((stream) => {
      stream.respond({ ":status": 200 });
      stream.end(Buffer.from([1]));
    });
    const bridge = createBridge(
      { accessToken: "token", rpcPath: "/test", url, pingIntervalMs: 0 },
      (event) => events.push(event),
    );
    bridge.onData(() => {
      throw new Error("consumer failed");
    });

    await expect(waitForClose(bridge)).resolves.toBe(1);
    expect(events).toContain("bridge.data_callback_error");
    expect(bridge.alive).toBe(false);
  });

  it("force-destroys a stalled stream after the graceful close window", async () => {
    let streamOpened!: () => void;
    const opened = new Promise<void>((resolve) => {
      streamOpened = resolve;
    });
    const url = await startServer((stream) => {
      stream.respond({ ":status": 200 });
      stream.on("error", () => {});
      streamOpened();
    });
    const server = [...servers][0]!;
    const serverSessionPromise = once(server, "session") as Promise<[http2.ServerHttp2Session]>;
    const bridge = createBridge({
      accessToken: "token",
      rpcPath: "/test",
      url,
      pingIntervalMs: 0,
      closeGraceMs: 10,
    });
    const [serverSession] = await serverSessionPromise;
    await opened;
    const serverClosed = once(serverSession, "close");

    const closeCode = waitForClose(bridge);
    bridge.end();

    await expect(closeCode).resolves.toBe(0);
    await serverClosed;
    expect(serverSession.destroyed).toBe(true);
  });

  it("makes explicit end and kill idempotent with stable close codes", async () => {
    const url = await startServer((stream) => {
      stream.respond({ ":status": 200 });
    });

    const ended = createBridge({
      accessToken: "token",
      rpcPath: "/test",
      url,
      pingIntervalMs: 0,
    });
    const endedClose = vi.fn();
    ended.onClose(endedClose);
    ended.end();
    ended.end();
    ended.kill();
    await flushEvents();
    expect(endedClose).toHaveBeenCalledOnce();
    expect(endedClose).toHaveBeenCalledWith(0);

    const killed = createBridge({
      accessToken: "token",
      rpcPath: "/test",
      url,
      pingIntervalMs: 0,
    });
    const killedClose = vi.fn();
    killed.onClose(killedClose);
    killed.kill();
    killed.kill();
    killed.end();
    await flushEvents();
    expect(killedClose).toHaveBeenCalledOnce();
    expect(killedClose).toHaveBeenCalledWith(1);
  });
});

describe("transport input bounds", () => {
  it("rejects oversized declared Connect frames before buffering their bodies", () => {
    const parser = createConnectFrameParser(
      () => {},
      () => {},
    );
    const header = Buffer.alloc(5);
    header.writeUInt32BE(MAX_CONNECT_MESSAGE_BYTES + 1, 1);
    expect(() => parser(header)).toThrow(/exceeds/);
  });

  it("attaches forensic diagnostics to a declared-length overflow for debugging a desync", () => {
    const parser = createConnectFrameParser(
      () => {},
      () => {},
    );
    const clean = frameConnectMessage(new Uint8Array([1, 2, 3]));
    parser(clean);

    const header = Buffer.alloc(5);
    header.writeUInt32BE(MAX_CONNECT_MESSAGE_BYTES + 1, 1);
    const trailing = Buffer.from([0xde, 0xad, 0xbe, 0xef]);

    let caught: unknown;
    try {
      parser(Buffer.concat([header, trailing]));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const diagnostics = (caught as Error & { connectFrameDesync?: unknown }).connectFrameDesync;
    expect(diagnostics).toEqual({
      bytesConsumedBeforeDesync: clean.length,
      framesParsedBeforeDesync: 1,
      headerHex: header.toString("hex"),
      trailingContextHex: trailing.toString("hex"),
    });
  });

  it("rejects oversized inline images before base64 decoding", () => {
    const oversized = "A".repeat(Math.ceil((5_242_880 * 4) / 3) + 1025);
    expect(() =>
      decodeBase64Image(oversized, "image/png", { enforceCursorCliLimits: true }),
    ).toThrow(/encoded limit/);
  });

  it("reassembles Connect frames regardless of transport chunking", () => {
    function randInt(max: number): number {
      return Math.floor(Math.random() * max);
    }

    for (let trial = 0; trial < 50; trial++) {
      const frameCount = 1 + randInt(6);
      const expected: Buffer[] = [];
      const wire: Buffer[] = [];
      for (let i = 0; i < frameCount; i++) {
        const len = randInt(20) === 0 ? randInt(150_000) : randInt(2_000);
        const payload = Buffer.alloc(len);
        for (let j = 0; j < len; j += 97) payload[j] = randInt(256);
        expected.push(payload);
        wire.push(frameConnectMessage(payload));
      }
      const all = Buffer.concat(wire);

      const received: Buffer[] = [];
      const parser = createConnectFrameParser(
        (bytes) => received.push(Buffer.from(bytes)),
        (bytes) => received.push(Buffer.from(bytes)),
      );

      let offset = 0;
      while (offset < all.length) {
        const size = randInt(4) === 0 ? 1 + randInt(4_000) : 1 + randInt(8);
        const end = Math.min(offset + size, all.length);
        parser(all.subarray(offset, end));
        offset = end;
      }

      expect(received.length).toBe(expected.length);
      for (let i = 0; i < expected.length; i++) {
        expect(received[i]!.equals(expected[i]!)).toBe(true);
      }
    }
  });
});
