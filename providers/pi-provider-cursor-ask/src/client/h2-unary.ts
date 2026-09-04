/**
 * Node-only in-process HTTP/2 transport for Cursor unary Connect RPCs.
 *
 * `fetch` is not an option: Cursor's agent hosts speak HTTP/2 and undici does
 * not provide the required HTTP/2 client transport.
 */
import http2 from "node:http2";
import { randomUUID } from "node:crypto";

import { getCursorClientVersion } from "../config/index.js";

const CURSOR_API_URL = "https://api2.cursor.sh";
export const MAX_UNARY_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface UnaryH2Options {
  accessToken: string;
  rpcPath: string;
  requestBody: Uint8Array;
  url?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface UnaryH2Result {
  status: number;
  body: Buffer;
}

export class UnaryH2TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnaryH2TimeoutError";
  }
}

/** Perform one unary Connect RPC over an in-process Node HTTP/2 session. */
export function callUnaryOverH2(options: UnaryH2Options): Promise<UnaryH2Result> {
  const origin = options.url ?? CURSOR_API_URL;
  const timeoutMs = options.timeoutMs ?? 15_000;

  return new Promise<UnaryH2Result>((resolve, reject) => {
    let settled = false;
    let session: http2.ClientHttp2Session | undefined;
    let request: http2.ClientHttp2Stream | undefined;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      try {
        session?.close();
      } catch {
        // Session may already be torn down by the event that settled the RPC.
      }
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        request?.close(http2.constants.NGHTTP2_CANCEL);
        session?.destroy();
      } catch {
        // Destruction is best effort; the session is abandoned either way.
      }
      reject(error);
    };

    const succeed = (result: UnaryH2Result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    function onAbort() {
      fail(new UnaryH2TimeoutError("Cursor unary RPC aborted"));
    }

    if (options.signal?.aborted) {
      reject(new UnaryH2TimeoutError("Cursor unary RPC aborted"));
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    if (timeoutMs > 0) {
      timer = setTimeout(
        () => fail(new UnaryH2TimeoutError(`Cursor unary RPC timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      timer.unref?.();
    }

    try {
      session = http2.connect(origin);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    session.on("error", (error) => fail(error));

    try {
      request = session.request({
        ":method": "POST",
        ":path": options.rpcPath,
        "content-type": "application/proto",
        "connect-protocol-version": "1",
        te: "trailers",
        authorization: `Bearer ${options.accessToken}`,
        "x-ghost-mode": "true",
        "x-cursor-client-version": getCursorClientVersion(),
        "x-cursor-client-type": "cli",
        "x-request-id": randomUUID(),
      });
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const chunks: Buffer[] = [];
    let responseBytes = 0;
    let status = 0;

    request.on("response", (headers) => {
      status = Number(headers[":status"] ?? 0);
    });
    request.on("data", (chunk: Buffer) => {
      responseBytes += chunk.byteLength;
      if (responseBytes > MAX_UNARY_RESPONSE_BYTES) {
        fail(new Error(`Cursor unary response exceeds ${MAX_UNARY_RESPONSE_BYTES} bytes`));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    request.on("error", (error) => fail(error));
    request.on("end", () => succeed({ status, body: Buffer.concat(chunks) }));

    request.end(Buffer.from(options.requestBody));
  });
}
