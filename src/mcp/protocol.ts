/**
 * @fileoverview The wire an MCP client speaks over stdio, hand-rolled.
 *
 * Model Context Protocol over stdio is JSON-RPC 2.0 with one message per line. There is
 * no framing header, no content length, no handshake beyond an ordinary request — which
 * is why this file is a hundred lines rather than a dependency (see SPEC.md section 13).
 *
 * Two things here are load-bearing and easy to get wrong:
 *
 *   - **A message is exactly one line.** `JSON.stringify` escapes newlines inside
 *     strings, so a docstring with paragraphs in it still frames as one line. Nothing
 *     downstream may pretty-print.
 *   - **stdout belongs to the protocol and to nothing else.** The CLI prints freely, and
 *     a single stray `console.log` anywhere under this command turns into a parse error
 *     in the agent's client. `claimStdout` takes the stream away from everybody else and
 *     sends their output to stderr, where a human can still read it.
 */

/** JSON-RPC identifies a request with a string, a number, or nothing at all. */
export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  /** Absent on a notification, which is a message that must never be answered. */
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

/** The JSON-RPC 2.0 error codes this server can produce. */
export const RPC_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

/** Builds a well-formed error response. */
export function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } };
}

/** Builds a well-formed success response. */
export function rpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

/**
 * Cuts a byte stream into whole messages.
 *
 * A pipe hands over whatever happened to arrive, so one chunk can hold three messages,
 * or half of one. Anything after the last newline is held back until the rest of it
 * turns up rather than being parsed as a truncated message — which would answer a
 * question the client never finished asking.
 */
export class LineFramer {
  private tail = '';

  /** Every complete message in this chunk, in order. Blank lines are not messages. */
  push(chunk: string): string[] {
    const parts = (this.tail + chunk).split('\n');
    this.tail = parts.pop() ?? '';
    return parts.map((line) => line.trim()).filter((line) => line.length > 0);
  }

  /** Whatever arrived without a closing newline, for when the stream ends. */
  rest(): string {
    const remainder = this.tail.trim();
    this.tail = '';
    return remainder;
  }
}

/** One framed message, ready to write. */
export function encodeMessage(message: JsonRpcResponse): string {
  return `${JSON.stringify(message)}\n`;
}

/** A parsed request, or the error response to send instead of one. */
export type Incoming = { ok: true; request: JsonRpcRequest } | { ok: false; error: JsonRpcResponse };

/**
 * Reads one line as a JSON-RPC request.
 *
 * Rejection is deliberately noisy rather than silent: a client that is sending us
 * something we do not understand needs to be told, and an agent debugging its own MCP
 * config gets a sentence instead of a hang.
 */
export function parseMessage(line: string): Incoming {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    return { ok: false, error: rpcError(null, RPC_ERROR.parse, `Not JSON: ${(err as Error).message}`) };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: rpcError(null, RPC_ERROR.invalidRequest, 'A JSON-RPC message must be an object.') };
  }

  const message = parsed as Record<string, unknown>;
  // An id we cannot echo is worse than no id: the client would never match the answer
  // to its question. Anything that is not a string or a number is reported against null.
  const id: JsonRpcId =
    typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null;

  if (message.jsonrpc !== '2.0') {
    return { ok: false, error: rpcError(id, RPC_ERROR.invalidRequest, 'Expected "jsonrpc": "2.0".') };
  }
  if (typeof message.method !== 'string') {
    return { ok: false, error: rpcError(id, RPC_ERROR.invalidRequest, 'A JSON-RPC message needs a "method".') };
  }

  return {
    ok: true,
    request: {
      jsonrpc: '2.0',
      // Kept absent rather than nulled, because "notification" and "request with a null
      // id" are different things and only one of them gets a reply.
      ...('id' in message ? { id } : {}),
      method: message.method,
      params: message.params,
    },
  };
}

/** The smallest thing this file needs a stream to be, so a test can pass a fake. */
export interface WritableLike {
  write(...args: never[]): unknown;
}

export interface ProtocolStream {
  /** Writes one framed message to the real stdout, whoever else thinks they own it. */
  send(message: JsonRpcResponse): void;
  /** Hands stdout back. Safe to call twice. */
  release(): void;
}

/**
 * Takes stdout away from the rest of the process for the lifetime of the server.
 *
 * This is not defensive tidiness. Under stdio transport, anything on stdout that is not
 * a JSON-RPC message is a protocol violation, and the things that write to stdout in a
 * Node process are not all ours — a deprecation notice, a library's debug line, or one
 * of this CLI's own `console.log`s in a code path nobody expected to reach. Every one of
 * those becomes a parse error in somebody's agent, reported as "App Atlas is broken".
 *
 * So the stream is captured once, `process.stdout.write` is pointed at stderr, and the
 * only way back onto stdout is `send`. `console.log` goes through `process.stdout.write`,
 * so it is covered by the same move. Output is diverted rather than dropped: a person
 * reading the client's server log can still see it.
 */
export function claimStdout(out?: WritableLike, err?: WritableLike): ProtocolStream {
  const target = out ?? (process.stdout as unknown as WritableLike);
  const fallback = err ?? (process.stderr as unknown as WritableLike);
  const original = target.write;
  const divert = fallback.write;

  target.write = function (this: unknown, ...args: never[]): unknown {
    return divert.apply(fallback, args);
  };

  let released = false;
  return {
    send(message: JsonRpcResponse): void {
      (original as (this: unknown, text: string) => unknown).call(target, encodeMessage(message));
    },
    release(): void {
      if (released) return;
      released = true;
      target.write = original;
    },
  };
}
