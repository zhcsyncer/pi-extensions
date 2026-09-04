import http2 from "node:http2";
import { randomUUID } from "node:crypto";

import { getCursorClientVersion } from "../config/index.js";
import { ConnectFlag } from "../types/enums.js";

const CURSOR_API_URL = "https://api2.cursor.sh";
const DEFAULT_RPC_PATH = "/agent.v1.AgentService/Run";
const CONNECT_END_STREAM_FLAG = ConnectFlag.EndStream;
const MAX_ERROR_BODY_BYTES = 1024 * 1024;
const DEFAULT_CLOSE_GRACE_MS = 100;
export const MAX_BRIDGE_MESSAGE_BYTES = 64 * 1024 * 1024;
export const MAX_CONNECT_MESSAGE_BYTES = 64 * 1024 * 1024;

export interface CreateBridgeOptions {
  accessToken: string;
  rpcPath: string;
  url?: string;
  /** Initial HTTP/2 connection timeout (ms). Default 30s. */
  connectTimeoutMs?: number;
  /** Activity idle timeout after connection (ms). Default disabled. */
  idleTimeoutMs?: number;
  /** HTTP/2 ping interval (ms). Default 20s. Intended primarily for tests. */
  pingIntervalMs?: number;
  /** Grace period before a clean close is force-destroyed. Default 100ms. Intended for tests. */
  closeGraceMs?: number;
}

export interface BridgeHandle {
  readonly alive: boolean;
  /** Whether this HTTP/2 session can accept another Run stream. */
  readonly reusable: boolean;
  /** Trailing in-process transport diagnostics (for diagnostics / recovery). */
  lastStderr(): string;
  write(data: Uint8Array): void;
  /** Gracefully end the current stream and close the HTTP/2 session with code 0. */
  end(): void;
  /** Immediately tear down the HTTP/2 session with code 1. */
  kill(): void;
  onData(cb: (chunk: Buffer) => void): void;
  onClose(cb: (code: number) => void): void;
  /** Open another Connect stream on the same HTTP/2 session. */
  openStream(accessToken: string): void;
  /** Fires when the current stream receives a normal 2xx response end. */
  onStreamDone(cb: () => void): void;
}

export type BridgeFactory = (options: CreateBridgeOptions) => BridgeHandle;
export type BridgeDebugLog = (event: string, data?: Record<string, unknown>) => void;

function noopDebugLog(): void {}

function optionalMs(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value === 0 ? 0 : Math.floor(value);
}

function connectEndStreamError(code: string, message: string): Buffer {
  return frameConnectMessage(
    Buffer.from(JSON.stringify({ error: { code, message } }), "utf8"),
    CONNECT_END_STREAM_FLAG,
  );
}

/**
 * Accumulates incoming chunks without re-concatenating the whole backlog on every chunk.
 * Buffering chunks in an array and only concatenating once enough bytes are available keeps
 * total frame-reassembly work O(n).
 */
class FrameAccumulator {
  private chunks: Buffer[] = [];
  private totalLength = 0;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.totalLength += chunk.length;
  }

  get length(): number {
    return this.totalLength;
  }

  reset(): void {
    this.chunks = [];
    this.totalLength = 0;
  }

  private frontBytes(n: number): Buffer {
    const first = this.chunks[0];
    if (!first || first.length >= n) return (first ?? Buffer.alloc(0)).subarray(0, n);
    let covered = 0;
    let count = 0;
    while (covered < n && count < this.chunks.length) {
      covered += this.chunks[count]!.length;
      count += 1;
    }
    const merged = Buffer.concat(this.chunks.slice(0, count), covered);
    this.chunks.splice(0, count, merged);
    return merged.subarray(0, n);
  }

  peek(n: number): Buffer {
    return this.frontBytes(n);
  }

  consume(n: number): Buffer {
    if (n === 0) return Buffer.alloc(0);
    const result = this.frontBytes(n);
    const first = this.chunks[0]!;
    if (first.length === n) this.chunks.shift();
    else this.chunks[0] = first.subarray(n);
    this.totalLength -= n;
    return result;
  }
}

export function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
  if (data.byteLength > MAX_CONNECT_MESSAGE_BYTES) {
    throw new Error(
      `Connect message exceeds ${MAX_CONNECT_MESSAGE_BYTES} bytes (outgoing, ${data.byteLength} bytes). ` +
        `Run /cursor.doctor and check lastRequestSize — this conversation's checkpoint or blob store has likely ` +
        `grown too large; starting a new session usually clears it.`,
    );
  }
  const frame = Buffer.alloc(5 + data.length);
  frame[0] = flags;
  frame.writeUInt32BE(data.length, 1);
  frame.set(data, 5);
  return frame;
}

/** Create a persistent in-process HTTP/2 streaming transport. */
export function createBridge(
  options: CreateBridgeOptions,
  debugLog: BridgeDebugLog = noopDebugLog,
): BridgeHandle {
  const origin = options.url ?? CURSOR_API_URL;
  const connectTimeoutMs = optionalMs(options.connectTimeoutMs, 30_000);
  const idleTimeoutMs = optionalMs(options.idleTimeoutMs, 0);
  const pingIntervalMs = optionalMs(options.pingIntervalMs, 20_000);
  const closeGraceMs = optionalMs(options.closeGraceMs, DEFAULT_CLOSE_GRACE_MS);

  debugLog("bridge.create", {
    rpcPath: options.rpcPath,
    url: origin,
    cursorClientVersion: getCursorClientVersion(),
  });

  const callbacks = {
    data: null as ((chunk: Buffer) => void) | null,
    close: null as ((code: number) => void) | null,
    streamDone: null as (() => void) | null,
  };
  const queuedData: Buffer[] = [];
  let queuedDataBytes = 0;
  let queuedStreamDone = 0;
  let diagnostics = "";
  let alive = true;
  let reusable = true;
  let connected = false;
  let exitCode = 1;
  let currentStream: http2.ClientHttp2Stream | undefined;
  let streamGeneration = 0;
  let connectTimer: NodeJS.Timeout | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let pingTimer: NodeJS.Timeout | undefined;
  let closeTimer: NodeJS.Timeout | undefined;
  let session: http2.ClientHttp2Session;

  const appendDiagnostic = (message: string): void => {
    diagnostics = `${diagnostics}${diagnostics ? "\n" : ""}${message}`.slice(-8_000);
  };

  const invokeClose = (): void => {
    try {
      callbacks.close?.(exitCode);
    } catch (error) {
      debugLog("bridge.close_callback_error", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const clearTransportTimers = (): void => {
    if (connectTimer) clearTimeout(connectTimer);
    connectTimer = undefined;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = undefined;
  };

  const setSessionReferenced = (referenced: boolean): void => {
    const referenceable = session as http2.ClientHttp2Session & {
      ref?: () => void;
      unref?: () => void;
    };
    try {
      if (referenced) referenceable.ref?.();
      else referenceable.unref?.();
    } catch {
      // Older Node typings/runtimes may not expose session ref management.
    }
  };

  const finalize = (code: number, destroy: boolean): void => {
    if (!alive) return;
    alive = false;
    exitCode = code;
    clearTransportTimers();
    const stream = currentStream;
    currentStream = undefined;
    if (destroy) {
      try {
        stream?.close(http2.constants.NGHTTP2_CANCEL);
      } catch {
        // The stream may already be closed.
      }
      try {
        session.destroy();
      } catch {
        // The session may already be destroyed.
      }
    } else {
      try {
        stream?.end();
      } catch {
        // The stream may already be closed.
      }
      try {
        session.close();
      } catch {
        // The session may already be closed.
      }
      setSessionReferenced(false);
      if (!session.destroyed) {
        closeTimer = setTimeout(() => {
          try {
            session.destroy();
          } catch {
            // The session may have closed during the grace period.
          }
        }, closeGraceMs);
        closeTimer.unref?.();
      }
    }
    debugLog("bridge.close", { rpcPath: options.rpcPath, exitCode: code });
    invokeClose();
  };

  const fail = (event: string, error: unknown, code = 1): void => {
    if (!alive) return;
    const message = error instanceof Error ? error.message : String(error);
    appendDiagnostic(`[${event}] ${message}`);
    debugLog(event, { message });
    finalize(code, true);
  };

  const armConnectTimeout = (): void => {
    if (connectTimer) clearTimeout(connectTimer);
    connectTimer = undefined;
    if (connectTimeoutMs <= 0 || !alive || connected) return;
    connectTimer = setTimeout(() => {
      fail(
        "bridge.connect_timeout",
        new Error(`Cursor HTTP/2 connect timed out after ${connectTimeoutMs}ms`),
      );
    }, connectTimeoutMs);
    connectTimer.unref?.();
  };

  const resetIdleTimeout = (): void => {
    if (!connected) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    if (idleTimeoutMs <= 0 || !alive) return;
    idleTimer = setTimeout(() => {
      fail(
        "bridge.idle_timeout",
        new Error(`Cursor HTTP/2 idle timed out after ${idleTimeoutMs}ms`),
      );
    }, idleTimeoutMs);
    idleTimer.unref?.();
  };

  const deliverData = (payload: Buffer, callbackFailureCode = 1): boolean => {
    if (!callbacks.data) {
      queuedDataBytes += payload.byteLength;
      if (queuedDataBytes > MAX_BRIDGE_MESSAGE_BYTES) {
        fail(
          "bridge.prelistener_buffer_limit",
          new Error(`Buffered transport output exceeds ${MAX_BRIDGE_MESSAGE_BYTES} bytes`),
        );
        return false;
      }
      queuedData.push(payload);
      return true;
    }
    try {
      callbacks.data(payload);
      return true;
    } catch (error) {
      fail("bridge.data_callback_error", error, callbackFailureCode);
      return false;
    }
  };

  const deliverStreamDone = (): boolean => {
    if (!callbacks.streamDone) {
      queuedStreamDone += 1;
      return true;
    }
    try {
      callbacks.streamDone();
      return true;
    } catch (error) {
      fail("bridge.stream_done_callback_error", error);
      return false;
    }
  };

  try {
    session = http2.connect(origin);
  } catch (error) {
    // Keep callback registration semantics consistent even when connect throws synchronously.
    session = Object.create(null) as http2.ClientHttp2Session;
    queueMicrotask(() => fail("bridge.session_error", error));
  }

  armConnectTimeout();

  session.on?.("connect", () => {
    debugLog("bridge.socket_connected", { rpcPath: options.rpcPath, url: origin });
  });
  session.on?.("remoteSettings", () => {
    connected = true;
    if (connectTimer) clearTimeout(connectTimer);
    connectTimer = undefined;
    debugLog("bridge.connected", { rpcPath: options.rpcPath, url: origin });
    resetIdleTimeout();
  });
  session.on?.("error", (error) => fail("bridge.session_error", error));
  session.on?.("goaway", (errorCode, lastStreamId, opaqueData) => {
    if (!alive) return;
    const opaque = opaqueData ? opaqueData.toString("utf8").slice(0, 200) : "";
    const currentStreamId = currentStream?.id;
    appendDiagnostic(
      `[bridge.goaway] errorCode=${errorCode} lastStreamId=${lastStreamId}${opaque ? ` opaque=${opaque}` : ""}`,
    );
    debugLog("bridge.goaway", { errorCode, lastStreamId, currentStreamId, opaque });
    reusable = false;
    const acceptedCurrentStream =
      errorCode === http2.constants.NGHTTP2_NO_ERROR &&
      typeof currentStreamId === "number" &&
      currentStreamId <= lastStreamId;
    if (acceptedCurrentStream) return;
    // Keep rejected streams on the transport-close path. A synthetic Connect error would set
    // native-core's streamError and bypass its checkpoint/history retry handling.
    finalize(2, true);
  });
  session.on?.("close", () => {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = undefined;
    if (alive) fail("bridge.session_close", new Error("Cursor HTTP/2 session closed"));
  });

  if (pingIntervalMs > 0) {
    pingTimer = setInterval(() => {
      if (!alive || session.destroyed || session.closed) return;
      try {
        session.ping((error) => {
          if (!error) return;
          appendDiagnostic(`[bridge.ping_error] ${error.message}`);
          debugLog("bridge.ping_error", { message: error.message });
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendDiagnostic(`[bridge.ping_error] ${message}`);
        debugLog("bridge.ping_error", { message });
      }
    }, pingIntervalMs);
    pingTimer.unref?.();
  }

  const requestHeaders = (accessToken: string): http2.OutgoingHttpHeaders => ({
    ":method": "POST",
    ":path": options.rpcPath || DEFAULT_RPC_PATH,
    "content-type": "application/connect+proto",
    "connect-protocol-version": "1",
    te: "trailers",
    authorization: `Bearer ${accessToken}`,
    "x-ghost-mode": "true",
    "x-cursor-client-version": getCursorClientVersion(),
    "x-cursor-client-type": "cli",
    "x-request-id": randomUUID(),
  });

  const openStream = (accessToken: string, resetCallbacks: boolean): void => {
    if (!alive) return;
    if (!reusable || session.destroyed || session.closed) {
      fail("bridge.open_stream_error", new Error("Cursor HTTP/2 session is not reusable"), 2);
      return;
    }
    if (resetCallbacks) {
      callbacks.data = null;
      callbacks.close = null;
      callbacks.streamDone = null;
      queuedData.length = 0;
      queuedDataBytes = 0;
      queuedStreamDone = 0;
    }

    const previousStream = currentStream;
    const generation = ++streamGeneration;
    try {
      previousStream?.close(http2.constants.NGHTTP2_CANCEL);
    } catch {
      // A completed previous stream is already closed.
    }

    let stream: http2.ClientHttp2Stream;
    try {
      stream = session.request(requestHeaders(accessToken || options.accessToken));
    } catch (error) {
      fail("bridge.open_stream_error", error);
      return;
    }
    currentStream = stream;
    setSessionReferenced(true);
    resetIdleTimeout();

    let responseStatus = 0;
    let responseStatusText = "";
    let responseEnded = false;
    const errorChunks: Buffer[] = [];
    let errorBodyBytes = 0;
    const isCurrent = () => alive && currentStream === stream && streamGeneration === generation;
    const isErrorStatus = () =>
      responseStatus !== 0 && (responseStatus < 200 || responseStatus >= 300);

    stream.on("response", (headers) => {
      if (!isCurrent()) return;
      resetIdleTimeout();
      responseStatus = Number(headers[":status"] ?? 0);
      responseStatusText = String(
        headers["grpc-message"] ?? headers["connect-error-message"] ?? "",
      );
    });
    stream.on("data", (chunk: Buffer) => {
      if (!isCurrent()) return;
      resetIdleTimeout();
      const payload = Buffer.from(chunk);
      if (isErrorStatus()) {
        const remaining = MAX_ERROR_BODY_BYTES - errorBodyBytes;
        if (remaining > 0) {
          const kept = payload.subarray(0, remaining);
          errorChunks.push(kept);
          errorBodyBytes += kept.byteLength;
        }
        return;
      }
      if (payload.byteLength > MAX_BRIDGE_MESSAGE_BYTES) {
        fail(
          "bridge.output_limit",
          new Error(`Transport output exceeds ${MAX_BRIDGE_MESSAGE_BYTES} bytes`),
        );
        return;
      }
      deliverData(payload);
    });
    stream.on("end", () => {
      if (!isCurrent()) return;
      responseEnded = true;
      resetIdleTimeout();
      if (isErrorStatus()) {
        const body = Buffer.concat(errorChunks).toString("utf8").trim();
        const detail = responseStatusText || body || "HTTP/2 upstream request failed";
        deliverData(
          connectEndStreamError(
            `http_${responseStatus}`,
            `Cursor HTTP ${responseStatus}: ${detail}`,
          ),
        );
        fail("bridge.http_error", new Error(`Cursor HTTP ${responseStatus}: ${detail}`));
        return;
      }
      currentStream = undefined;
      try {
        stream.end();
      } catch {
        // The remote may already have closed the writable side.
      }
      setSessionReferenced(false);
      deliverStreamDone();
    });
    stream.on("error", (error) => {
      if (isCurrent()) fail("bridge.stream_error", error);
    });
    stream.on("close", () => {
      if (isCurrent() && !responseEnded) {
        fail("bridge.stream_close", new Error("Cursor HTTP/2 stream closed before response end"));
      }
    });
  };

  // The first Run stream exists immediately so callers can write request frames synchronously.
  openStream(options.accessToken, false);

  return {
    get alive() {
      return alive;
    },
    get reusable() {
      return reusable;
    },
    lastStderr() {
      return diagnostics.trim();
    },
    write(data: Uint8Array) {
      const stream = currentStream;
      if (!alive || !stream || stream.closed || stream.destroyed) return;
      if (data.byteLength > MAX_BRIDGE_MESSAGE_BYTES) {
        fail(
          "bridge.input_limit",
          new Error(`Transport input exceeds ${MAX_BRIDGE_MESSAGE_BYTES} bytes`),
        );
        return;
      }
      const queuedBytes = (stream as http2.ClientHttp2Stream & { writableLength?: number })
        .writableLength;
      if ((queuedBytes ?? 0) + data.byteLength > MAX_BRIDGE_MESSAGE_BYTES) {
        fail(
          "bridge.input_backpressure_limit",
          new Error(`Queued transport input exceeds ${MAX_BRIDGE_MESSAGE_BYTES} bytes`),
        );
        return;
      }
      try {
        stream.write(Buffer.from(data));
        resetIdleTimeout();
      } catch (error) {
        fail("bridge.write_error", error);
      }
    },
    openStream(accessToken: string) {
      openStream(accessToken, true);
    },
    end() {
      finalize(0, false);
    },
    kill() {
      fail("bridge.killed", new Error("Cursor HTTP/2 transport killed"));
    },
    onData(cb: (chunk: Buffer) => void) {
      callbacks.data = cb;
      while (queuedData.length > 0) {
        const payload = queuedData.shift()!;
        queuedDataBytes -= payload.byteLength;
        if (!deliverData(payload)) break;
      }
    },
    onStreamDone(cb: () => void) {
      callbacks.streamDone = cb;
      while (queuedStreamDone > 0 && alive) {
        queuedStreamDone -= 1;
        if (!deliverStreamDone()) break;
      }
    },
    onClose(cb: (code: number) => void) {
      if (!alive) {
        queueMicrotask(() => {
          try {
            cb(exitCode);
          } catch (error) {
            debugLog("bridge.close_callback_error", {
              message: error instanceof Error ? error.message : String(error),
            });
          }
        });
      } else {
        callbacks.close = cb;
      }
    },
  };
}

/** Attached to the error thrown for a declared-length overflow so callers can log forensics
 *  (behind PI_CURSOR_PROVIDER_DEBUG) without needing to re-derive parser-internal state. */
export interface ConnectFrameDesyncDiagnostics {
  /** Bytes successfully parsed into complete frames before the desync, across this parser's life. */
  bytesConsumedBeforeDesync: number;
  /** Number of complete frames successfully parsed before the desync. */
  framesParsedBeforeDesync: number;
  /** Hex of the 5-byte header read as the (bogus) next frame. */
  headerHex: string;
  /** Hex of up to 32 bytes immediately following the header, for context. */
  trailingContextHex: string;
}

export function createConnectFrameParser(
  onMessage: (bytes: Uint8Array) => void,
  onEndStream: (bytes: Uint8Array) => void,
): (incoming: Buffer) => void {
  const pending = new FrameAccumulator();
  let bytesConsumed = 0;
  let framesParsed = 0;
  return (incoming: Buffer) => {
    pending.push(incoming);
    while (pending.length >= 5) {
      const header = pending.peek(5);
      const flags = header[0]!;
      const msgLen = header.readUInt32BE(1);
      if (msgLen > MAX_CONNECT_MESSAGE_BYTES) {
        const contextLen = Math.min(32, pending.length - 5);
        const trailingContextHex =
          contextLen > 0
            ? pending
                .peek(5 + contextLen)
                .subarray(5)
                .toString("hex")
            : "";
        const diagnostics: ConnectFrameDesyncDiagnostics = {
          bytesConsumedBeforeDesync: bytesConsumed,
          framesParsedBeforeDesync: framesParsed,
          headerHex: header.toString("hex"),
          trailingContextHex,
        };
        pending.reset();
        throw Object.assign(
          new Error(
            `Connect message exceeds ${MAX_CONNECT_MESSAGE_BYTES} bytes (incoming, declared length ${msgLen}). ` +
              `Enable PI_CURSOR_PROVIDER_DEBUG=1 and check the lifecycle log for the frame preceding this error.`,
          ),
          { connectFrameDesync: diagnostics },
        );
      }
      if (pending.length < 5 + msgLen) break;
      pending.consume(5);
      const messageBytes = pending.consume(msgLen);
      bytesConsumed += 5 + msgLen;
      framesParsed += 1;
      if (flags & CONNECT_END_STREAM_FLAG) onEndStream(messageBytes);
      else onMessage(messageBytes);
    }
  };
}

export function parseConnectEndStream(data: Uint8Array): Error | null {
  try {
    const payload = JSON.parse(new TextDecoder().decode(data));
    const error = payload?.error;
    if (error)
      return new Error(
        `Connect error ${error.code ?? "unknown"}: ${error.message ?? "Unknown error"}`,
      );
    return null;
  } catch {
    return new Error("Failed to parse Connect end stream");
  }
}
