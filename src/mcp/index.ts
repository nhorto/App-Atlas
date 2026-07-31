/**
 * @fileoverview `app-atlas mcp` — the atlas, answered over the Model Context Protocol.
 *
 * The graph, the queries and the export were all already here (SPEC.md section 7). This
 * is the wrapper that lets a coding agent ask the same questions the screen asks, in the
 * middle of editing the code the answers are about.
 *
 * Three methods carry the whole feature: `initialize` agrees a protocol version,
 * `tools/list` describes the tools, and `tools/call` runs one. Everything else is
 * either a notification to be ignored or a capability this server does not claim — and
 * it says so with a method-not-found rather than inventing an empty answer.
 */
import { TOOL_VERSION } from '../analyze/index.js';
import { AtlasSource } from './atlas.js';
import {
  claimStdout,
  LineFramer,
  parseMessage,
  RPC_ERROR,
  rpcError,
  rpcResult,
} from './protocol.js';
import type { JsonRpcRequest, JsonRpcResponse, ProtocolStream } from './protocol.js';
import { callMcpTool, isKnownTool, MCP_TOOLS } from './tools.js';

export { AtlasSource } from './atlas.js';
export type { AtlasApp, Resolution } from './atlas.js';
export { callMcpTool, isKnownTool, MCP_TOOLS } from './tools.js';
export type { ToolDefinition, ToolResult } from './tools.js';
export {
  claimStdout,
  encodeMessage,
  LineFramer,
  parseMessage,
  RPC_ERROR,
} from './protocol.js';
export type { JsonRpcRequest, JsonRpcResponse, ProtocolStream } from './protocol.js';

/**
 * The protocol revisions this server has been written against, newest first.
 *
 * The surface used here — `initialize`, `tools/list`, `tools/call` over newline-delimited
 * JSON-RPC — is spelled the same way in all three, so a client asking for any of them
 * gets the one it asked for. A client asking for something else is answered with the
 * newest we can actually honour, which is what the specification asks a server to do:
 * naming a version we have never read would be a claim we cannot back.
 */
export const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/**
 * The paragraph an MCP client shows its model about this server.
 *
 * Worth its tokens because it sets the two expectations that stop an agent misreading
 * every later result: the facts come from a run that has already happened, and a blank is
 * a blank rather than an all-clear.
 */
const INSTRUCTIONS =
  'App Atlas maps this codebase from its source: every way in, what guards each one, where data goes, and what ' +
  'reads which environment variable. Answers come from an analysis already written to `.app-atlas/`, so re-run ' +
  '`app-atlas analyze` after editing code and call again to see the change. Everything is derived from the code as ' +
  'written — it cannot see deployed configuration, a running database, or a check in a file that would not parse — ' +
  'and each result says which of those limits applied. Where a result says nothing was found, that means nothing ' +
  'was found, not that nothing exists; do not turn it into an assurance.';

export interface McpOptions {
  /** The project directory whose atlas answers. */
  root: string;
}

/**
 * Answers one JSON-RPC request, or returns null when the message was a notification.
 *
 * Kept separate from the stream so the whole protocol can be driven by a test without a
 * child process — the transport is thirty lines and the behaviour worth pinning is here.
 */
export function handleMcpMessage(source: AtlasSource, request: JsonRpcRequest): JsonRpcResponse | null {
  // A notification has no id. The specification is explicit that it must never be
  // answered, and a client that receives a response to one is entitled to complain.
  const isNotification = !('id' in request);
  const id = request.id ?? null;

  switch (request.method) {
    case 'initialize': {
      if (isNotification) return null;
      const params = asObject(request.params);
      const requested = params.protocolVersion;
      return rpcResult(id, {
        protocolVersion:
          typeof requested === 'string' && SUPPORTED_PROTOCOLS.includes(requested)
            ? requested
            : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'app-atlas', version: TOOL_VERSION },
        instructions: INSTRUCTIONS,
      });
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return isNotification ? null : rpcResult(id, {});

    case 'tools/list':
      return isNotification ? null : rpcResult(id, { tools: MCP_TOOLS });

    case 'tools/call': {
      if (isNotification) return null;
      const params = asObject(request.params);
      const name = params.name;
      if (typeof name !== 'string') {
        return rpcError(id, RPC_ERROR.invalidParams, 'tools/call needs a "name".');
      }
      if (!isKnownTool(name)) {
        return rpcError(id, RPC_ERROR.invalidParams, `No tool called "${name}".`);
      }
      return rpcResult(id, callMcpTool(source, name, asObject(params.arguments)));
    }

    default:
      // An unknown notification is ignored, per the specification; an unknown request is
      // told the truth. Answering `resources/list` with an empty list would be a lie
      // about a capability this server never advertised.
      return isNotification ? null : rpcError(id, RPC_ERROR.methodNotFound, `Unknown method: ${request.method}`);
  }
}

/**
 * Runs the server until the client closes stdin.
 *
 * Nothing is printed. stdout is claimed by the protocol before anything else happens, so
 * a stray `console.log` anywhere below — in this CLI or in a library it loads — lands on
 * stderr instead of corrupting the stream.
 */
export async function startMcpServer(options: McpOptions): Promise<void> {
  const stream = claimStdout();
  const source = new AtlasSource(options.root);
  const framer = new LineFramer();

  try {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      for (const line of framer.push(String(chunk))) answerLine(source, line, stream);
    }
    const trailing = framer.rest();
    if (trailing) answerLine(source, trailing, stream);
  } finally {
    stream.release();
  }
}

/**
 * One line in, at most one message out.
 *
 * The catch is the point: a tool that throws on one repository's odd shape must cost that
 * one call and not the session. An agent that loses its map mid-edit is worse off than
 * one that is told a single question failed.
 */
function answerLine(source: AtlasSource, line: string, stream: ProtocolStream): void {
  const incoming = parseMessage(line);
  if (!incoming.ok) {
    stream.send(incoming.error);
    return;
  }
  try {
    const response = handleMcpMessage(source, incoming.request);
    if (response) stream.send(response);
  } catch (err) {
    if ('id' in incoming.request) {
      stream.send(rpcError(incoming.request.id ?? null, RPC_ERROR.internal, (err as Error).message));
    }
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
