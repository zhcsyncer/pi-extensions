import http2 from "node:http2";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";

import { callCursorUnaryRpc } from "../src/stream/model-discovery.js";

const servers = new Set<http2.Http2Server>();
const sessions = new Set<http2.ServerHttp2Session>();

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

afterEach(async () => {
  for (const session of sessions) session.destroy();
  sessions.clear();
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  servers.clear();
});

describe("model discovery in-process HTTP/2 transport", () => {
  it("sends raw protobuf and returns a bounded successful response", async () => {
    let requestBody = Buffer.alloc(0);
    let authorization: string | undefined;
    const url = await startServer((stream, headers) => {
      authorization = String(headers.authorization);
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      stream.on("end", () => {
        requestBody = Buffer.concat(chunks);
        stream.respond({ ":status": 200 });
        stream.end(Buffer.from([3, 4]));
      });
    });

    const result = await callCursorUnaryRpc({
      accessToken: "token",
      rpcPath: "/models",
      requestBody: new Uint8Array([1, 2]),
      url,
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(Array.from(result.body)).toEqual([3, 4]);
    expect(Array.from(requestBody)).toEqual([1, 2]);
    expect(authorization).toBe("Bearer token");
  });

  it("preserves a non-2xx response body with exit code 1", async () => {
    const url = await startServer((stream) => {
      stream.on("data", () => {});
      stream.on("end", () => {
        stream.respond({ ":status": 503 });
        stream.end("maintenance");
      });
    });

    const result = await callCursorUnaryRpc({
      accessToken: "token",
      rpcPath: "/models",
      requestBody: new Uint8Array(),
      url,
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({ exitCode: 1, timedOut: false });
    expect(Buffer.from(result.body).toString("utf8")).toBe("maintenance");
  });

  it("reports an already-aborted request as timed out without opening a session", async () => {
    let sessionCount = 0;
    const url = await startServer(() => {});
    [...servers][0]!.on("session", () => {
      sessionCount += 1;
    });
    const controller = new AbortController();
    controller.abort();

    const result = await callCursorUnaryRpc({
      accessToken: "token",
      rpcPath: "/models",
      requestBody: new Uint8Array(),
      url,
      signal: controller.signal,
    });

    expect(result).toMatchObject({ exitCode: 1, timedOut: true });
    expect(sessionCount).toBe(0);
  });

  it("reports an in-flight timeout with the existing timedOut result shape", async () => {
    const url = await startServer((stream) => {
      stream.on("data", () => {});
    });

    const result = await callCursorUnaryRpc({
      accessToken: "token",
      rpcPath: "/models",
      requestBody: new Uint8Array([1]),
      url,
      timeoutMs: 20,
    });

    expect(result).toMatchObject({ exitCode: 1, timedOut: true });
    expect(result.body).toHaveLength(0);
  });
});
