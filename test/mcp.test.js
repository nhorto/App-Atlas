/**
 * @fileoverview `app-atlas mcp` — the atlas answered over the Model Context Protocol (#42).
 *
 * The transport is thirty lines and the tools are queries over a graph that other tests
 * already defend, so almost nothing here is about features. What is being defended is
 * that an agent cannot be misled by an answer:
 *
 *   - a directory nobody has analysed produces a sentence and an error flag, never an
 *     empty list — an agent handed `[]` will report that the app has no open doors;
 *   - "nothing is unguarded" and "there is nothing to guard" stay two different answers,
 *     because a library has no routes and a locked-down web app has no problem, and only
 *     one of those is a clean bill of health;
 *   - every guard carries the confidence the analyzer gave it, every result says when the
 *     analysis was run, and a sentence a model wrote is marked;
 *   - nothing that is not protocol reaches stdout, because under stdio transport a single
 *     stray `console.log` is a parse error inside somebody's coding agent.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  analyzeProject,
  AtlasSource,
  callMcpTool,
  claimStdout,
  computeStats,
  encodeMessage,
  handleMcpMessage,
  LineFramer,
  MCP_TOOLS,
  parseMessage,
  persistAtlas,
  RPC_ERROR,
  writeScopes,
} from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'dist', 'node', 'cli.js');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'app-atlas-mcp-'));

test.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

/**
 * Analyzes a fixture and writes its atlas into a throwaway directory named after it.
 *
 * The atlas goes somewhere else on purpose: an analysis that persisted into the fixture
 * would leave `.app-atlas` in the repository, which is the mistake M5's cache made once
 * already. Everything the MCP server reads it reads from disk, so this is also the real
 * path — nothing here is handed a graph the CLI would not have found.
 */
function analysed(fixture, name = fixture) {
  const dir = path.join(workspace, name);
  fs.mkdirSync(dir, { recursive: true });
  return analyzeProject(path.join(here, 'fixtures', fixture), {
    followReferences: true,
    cache: 'off',
  }).then(({ atlas }) => {
    persistAtlas(dir, atlas);
    return { dir, atlas };
  });
}

/** Runs one tool the way the dispatcher would, and hands back both halves of the result. */
function call(dir, name, args = {}) {
  return callMcpTool(new AtlasSource(dir), name, args);
}

const textOf = (result) => result.content.map((block) => block.text).join('\n');

const exposure = await analysed('exposure');
const library = await analysed('lib');
const boundary = await analysed('boundary');
const blind = await analysed('pyblind');

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

test('a message split across two chunks is one message, not two broken ones', () => {
  const framer = new LineFramer();
  assert.deepEqual(framer.push('{"jsonrpc":"2.0","id":1,'), [], 'half a message is not a message');
  assert.deepEqual(framer.push('"method":"ping"}\n'), ['{"jsonrpc":"2.0","id":1,"method":"ping"}']);
});

test('three messages arriving in one chunk are answered in order', () => {
  const framer = new LineFramer();
  const lines = framer.push('{"a":1}\n{"b":2}\n{"c":3}\n');
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
});

test('a docstring with paragraphs in it still frames as exactly one line', () => {
  // The whole framing rests on this: `JSON.stringify` escapes newlines inside strings,
  // so a description with blank lines in it cannot split a message in half.
  const encoded = encodeMessage({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: 'first line\n\nsecond line' }] },
  });
  assert.equal(encoded.split('\n').length, 2, 'one message, one trailing newline');

  const framer = new LineFramer();
  const [line] = framer.push(encoded);
  assert.equal(JSON.parse(line).result.content[0].text, 'first line\n\nsecond line');
});

test('a line that is not JSON is answered rather than swallowed', () => {
  const incoming = parseMessage('this is not json');
  assert.equal(incoming.ok, false);
  assert.equal(incoming.error.error.code, RPC_ERROR.parse);
  assert.equal(incoming.error.id, null, 'nothing to echo, so nothing is invented');
});

test('a notification is never answered', () => {
  const incoming = parseMessage('{"jsonrpc":"2.0","method":"notifications/initialized"}');
  assert.equal(incoming.ok, true);
  assert.equal('id' in incoming.request, false, 'no id means no reply is owed');
  assert.equal(handleMcpMessage(new AtlasSource(exposure.dir), incoming.request), null);
});

test('an unknown request is told the truth instead of being given an empty answer', () => {
  // Answering `resources/list` with `[]` would claim a capability this server never
  // advertised, and the client would believe there are no resources rather than none offered.
  const response = handleMcpMessage(new AtlasSource(exposure.dir), {
    jsonrpc: '2.0',
    id: 9,
    method: 'resources/list',
  });
  assert.equal(response.error.code, RPC_ERROR.methodNotFound);
});

// ---------------------------------------------------------------------------
// stdout belongs to the protocol
// ---------------------------------------------------------------------------

test('anything written to stdout that is not protocol goes to stderr instead', () => {
  const out = { written: [], write(text) { this.written.push(text); return true; } };
  const err = { written: [], write(text) { this.written.push(text); return true; } };

  const stream = claimStdout(out, err);
  try {
    out.write('a library printing something\n');
    stream.send({ jsonrpc: '2.0', id: 1, result: {} });
  } finally {
    stream.release();
  }

  assert.deepEqual(err.written, ['a library printing something\n'], 'diverted, not dropped');
  assert.deepEqual(out.written, ['{"jsonrpc":"2.0","id":1,"result":{}}\n'], 'only protocol on stdout');
});

test('a stray console.log cannot reach the protocol stream', () => {
  // The real stream, because `console.log` goes through `process.stdout.write` and the
  // point of the guard is that it covers code that never heard of this module.
  const sent = [];
  const collector = { write(text) { sent.push(text); return true; } };
  const stream = claimStdout(process.stdout, collector);
  try {
    console.log('this must never appear in an agent transcript');
    process.stdout.write('nor this');
  } finally {
    stream.release();
  }
  assert.equal(sent.length, 2, 'both went to the fallback stream');
  assert.match(sent[0], /must never appear/);
});

test('releasing hands stdout back, and is safe to do twice', () => {
  const out = { written: [], write(text) { this.written.push(text); return true; } };
  const err = { written: [], write(text) { this.written.push(text); return true; } };
  const stream = claimStdout(out, err);
  stream.release();
  stream.release();
  out.write('ordinary output again');
  assert.deepEqual(out.written, ['ordinary output again']);
});

// ---------------------------------------------------------------------------
// The handshake
// ---------------------------------------------------------------------------

test('the server agrees to the protocol revision the client asked for, when it knows it', () => {
  const response = handleMcpMessage(new AtlasSource(exposure.dir), {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {} },
  });
  assert.equal(response.result.protocolVersion, '2024-11-05');
  assert.equal(response.result.serverInfo.name, 'app-atlas');
  assert.deepEqual(Object.keys(response.result.capabilities), ['tools']);
});

test('…and never claims a revision it has not been written against', () => {
  const response = handleMcpMessage(new AtlasSource(exposure.dir), {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2099-01-01', capabilities: {} },
  });
  assert.equal(response.result.protocolVersion, '2025-06-18', 'the newest one we have actually read');
});

test('the tools on offer are the ones the graph can answer without hedging', () => {
  const names = MCP_TOOLS.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'data_stores',
    'env_vars',
    'list_doors',
    // The eighth, and the only one handed evidence from a run rather than reading the
    // source: a pasted stack trace, matched to files by path and line. It belongs on
    // this test for the reason the others do — every frame it cannot place says why,
    // and it lists every door that could reach the failure rather than choosing one.
    'trace_error',
    'unguarded_doors',
    // Issue #46's: which files nothing else imports. It earns its place on the same
    // test as the rest — it refuses to answer far more often than it answers, and
    // every refusal says why.
    'unimported_files',
    'what_calls',
    'where_is',
  ]);
  for (const tool of MCP_TOOLS) {
    assert.ok(tool.description.length > 40, `${tool.name} needs a description a model can choose by`);
    assert.equal(tool.inputSchema.type, 'object');
  }
});

// ---------------------------------------------------------------------------
// A directory nobody has analysed
// ---------------------------------------------------------------------------

const unanalysed = path.join(workspace, 'never-analysed');
fs.mkdirSync(unanalysed, { recursive: true });

test('a directory nobody has analysed is an error, not an empty list', () => {
  // This is the failure that matters most on this surface. An agent handed `[]` will
  // report that the app has no unguarded doors, which is the one sentence this whole
  // project exists to prevent somebody saying to a customer.
  const result = call(unanalysed, 'unguarded_doors');
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined, 'nothing that could be read as a finding');
  assert.match(textOf(result), /app-atlas analyze/, 'names the command that fixes it');
  assert.match(textOf(result), /never runs one itself/);
});

test('…and every other tool says the same thing rather than each inventing its own', () => {
  for (const tool of MCP_TOOLS) {
    const result = call(unanalysed, tool.name, { target: 'x', query: 'x' });
    assert.equal(result.isError, true, `${tool.name} answered from nothing`);
  }
});

test('…while tools/list still works, so the agent can see what it would get', () => {
  const response = handleMcpMessage(new AtlasSource(unanalysed), {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  });
  assert.equal(response.result.tools.length, MCP_TOOLS.length);
});

// ---------------------------------------------------------------------------
// unguarded_doors — the one no competitor answers
// ---------------------------------------------------------------------------

test('the doors nothing guards are named, with the file and line to go and look at', () => {
  const result = call(exposure.dir, 'unguarded_doors');
  const { unguarded } = result.structuredContent;

  assert.equal(result.structuredContent.unguardedCount, 3);
  assert.deepEqual(
    new Set(unguarded.map((door) => door.route)),
    new Set(['/admin', '/api/report', '/api/export']),
  );
  for (const door of unguarded) {
    assert.ok(door.sites[0].path, `${door.route} was reported without a file`);
    assert.ok(door.sites[0].line > 0, `${door.route} was reported without a line`);
  }
  assert.match(textOf(result), /src\/app\/api\/export\/route\.ts:\d+/);
});

test('a page the browser renders is counted apart from a door worth acting on', () => {
  const result = call(exposure.dir, 'unguarded_doors');
  const { notCounted } = result.structuredContent;
  assert.equal(notCounted.publicPages, 2);
  assert.equal(notCounted.signInDoor, 1);
  // Counted always, listed only on request — the number people act on has to stay readable.
  assert.doesNotMatch(textOf(result), /\/pricing/);
  assert.match(textOf(call(exposure.dir, 'unguarded_doors', { includeExplained: true })), /\/pricing/);
});

test('"nothing is unguarded" and "there is nothing to guard" are different answers', () => {
  // A library has no route a stranger can knock on. Telling its owner "everything is
  // protected" would be a reassurance about a question that does not apply to them.
  const nothingToGuard = call(library.dir, 'unguarded_doors');
  assert.equal(nothingToGuard.structuredContent.nothingToGuard, true);
  assert.equal(nothingToGuard.structuredContent.routes, 0);
  assert.match(textOf(nothingToGuard), /nothing here to guard/);
  assert.doesNotMatch(textOf(nothingToGuard), /every one of/);

  // A web app whose every route is checked is allowed to read like a clean bill of health.
  const locked = call(everyRouteChecked(), 'unguarded_doors');
  assert.equal(locked.structuredContent.nothingToGuard, false);
  assert.equal(locked.structuredContent.unguardedCount, 0);
  assert.match(textOf(locked), /Nothing is unguarded/);
  assert.match(textOf(locked), /every one of the 3 routes/);
});

test('a project with no routes still says what other ways in it does have', () => {
  const result = call(library.dir, 'unguarded_doors');
  assert.match(textOf(result), /3 ways in of other kinds \(export\)/);
  assert.match(textOf(result), /None of them is reachable from the internet/);
});

test('a route whose check is in a file that would not parse is not reported as open', () => {
  const result = call(blind.dir, 'unguarded_doors');
  assert.equal(result.structuredContent.unguardedCount, 1, 'only the one that imports nothing broken');
  assert.equal(result.structuredContent.notCounted.behindAnUnreadableFile, 2);
  assert.match(textOf(result), /could not read/);
  assert.match(textOf(result), /app\/deps\.py/, 'the file it could not read is named');
});

// ---------------------------------------------------------------------------
// Provenance reaches the agent
// ---------------------------------------------------------------------------

test('every result says which app answered, when it was analysed, and how to refresh it', () => {
  for (const tool of MCP_TOOLS) {
    // Every tool gets what it needs to actually answer: the assertion is about what an
    // answer carries, and a tool refusing a missing argument is not answering.
    const result = call(boundary.dir, tool.name, {
      target: 'sendEmail',
      query: 'db',
      trace: 'Error: x\n    at sendEmail (src/lib/email.ts:3:1)',
    });
    const text = textOf(result);
    assert.match(text, /Source: the atlas of "boundary"/, `${tool.name} did not say where it got this`);
    assert.match(text, /analysed \d{4}-\d{2}-\d{2}T/, `${tool.name} did not date its facts`);
    assert.match(text, /Re-run `app-atlas analyze`/, `${tool.name} did not say how to make it current`);
    assert.equal(result.structuredContent.analyzedAt, boundary.atlas.meta.generatedAt);
    assert.equal(result.structuredContent.toolVersion, boundary.atlas.meta.toolVersion);
  }
});

test('no guard is ever reported without the confidence the analyzer gave it', () => {
  const { doors } = call(boundary.dir, 'list_doors', { limit: 500 }).structuredContent;
  const guards = doors.flatMap((door) => door.guards);
  assert.ok(guards.length > 0, 'the boundary fixture has guards to report');
  for (const guard of guards) {
    assert.ok(
      ['certain', 'likely', 'possible'].includes(guard.confidence),
      `${guard.name} was reported with no confidence`,
    );
  }
});

test('a check the analyzer is not certain of never reads as a plain "checked"', () => {
  const { doors } = call(boundary.dir, 'list_doors', { limit: 500 }).structuredContent;
  const unsure = doors.find(
    (door) => door.guards.length > 0 && door.guards.every((guard) => guard.confidence !== 'certain'),
  );
  if (!unsure) return; // this fixture may have none, and inventing one would test nothing
  const line = textOf(call(boundary.dir, 'list_doors', { limit: 500 }))
    .split('\n')
    .find((row) => row.includes(unsure.name));
  assert.match(line, /likely checked by|\?/);
});

test('a sentence a model wrote is marked, and one read out of the code is not', () => {
  // The fixtures are analyzed with no AI backend, so the generated sentence is put there
  // by hand. What is under test is the rendering rule, not the enricher.
  const atlas = structuredClone(exposure.atlas);
  const file = atlas.nodes.find((node) => node.id === 'file:src/app/api/report/route.ts');
  file.summary = 'A sentence no human wrote.';
  file.summarySource = 'ai';
  const written = atlas.nodes.find(
    (node) => node.id === 'func:src/app/api/report/route.ts#POST' && node.summarySource === 'docs',
  );
  assert.ok(written, 'the fixture has a real docstring to compare against');

  const dir = path.join(workspace, 'marked');
  fs.mkdirSync(dir, { recursive: true });
  persistAtlas(dir, atlas);

  const text = textOf(call(dir, 'where_is', { query: 'report' }));
  assert.match(text, /A sentence no human wrote\. \(ai\)/);
  assert.doesNotMatch(text, new RegExp(`${escapeForRegex(written.summary.slice(0, 30))}[^\\n]*\\(ai\\)`));
});

// ---------------------------------------------------------------------------
// The other four tools
// ---------------------------------------------------------------------------

test('crons and webhooks are on the door list even though nobody outside can knock on them', () => {
  const { doors } = call(boundary.dir, 'list_doors', { limit: 500 }).structuredContent;
  const kinds = new Set(doors.map((door) => door.kind));
  assert.ok(kinds.has('cron'), 'a scheduled job is a way in');
  assert.ok(kinds.has('webhook'));
  assert.ok(kinds.has('http-route'));
});

test('the environment inventory is not dressed up as a way in', () => {
  const { doors } = call(boundary.dir, 'list_doors', { limit: 500 }).structuredContent;
  assert.equal(doors.filter((door) => door.kind === 'env').length, 0, 'env has its own tool');
});

test('a name that matches more than one thing returns the candidates rather than picking one', () => {
  const result = call(exposure.dir, 'what_calls', { target: 'db' });
  assert.equal(result.structuredContent.resolved, null);
  assert.ok(result.structuredContent.candidates.length > 1);
  assert.match(textOf(result), /will not pick one for you/);
});

test('a caller carries the confidence of the edge that found it', () => {
  const result = call(exposure.dir, 'what_calls', { target: 'file:src/lib/db.ts' });
  assert.ok(result.structuredContent.resolved, 'an id resolves without argument');
  for (const caller of result.structuredContent.callers) {
    assert.ok(['certain', 'likely', 'possible'].includes(caller.confidence));
    assert.ok(caller.caller.id, 'a caller with no identity is not a finding');
  }
});

test('nothing found is reported as nothing found, never as nothing exists', () => {
  const result = call(exposure.dir, 'what_calls', { target: 'endpoint:http-route:GET /api/export' });
  assert.equal(result.isError, undefined, 'an empty answer is still an answer');
  assert.match(textOf(result), /none was found, not that none exists/);
});

test('a table with no migration to read is unknown, not unprotected', () => {
  const result = call(boundary.dir, 'data_stores');
  const { tables, tableCounts } = result.structuredContent;
  const unknown = tables.filter((table) => table.rls === null);
  assert.ok(unknown.length > 0, 'the boundary fixture has a table with nothing said about it');
  assert.equal(tableCounts.notStatedInAnyMigration, unknown.length);
  assert.match(textOf(result), /unknown, not off/);
});

test('a table whose migrations do state row security says what they said', () => {
  const result = call(boundary.dir, 'data_stores');
  const stated = result.structuredContent.tables.filter((table) => table.rls !== null);
  assert.ok(stated.length > 0, 'the fixture has migrations that turn row security on');
  assert.match(textOf(result), /row security on, \d+ (policy|policies)/);
});

test('a variable the hosting platform sets is not counted as one you forgot to write down', () => {
  const result = call(boundary.dir, 'env_vars');
  const { vars, undocumentedCount } = result.structuredContent;
  const platform = vars.filter((variable) => variable.platform);
  assert.ok(platform.length > 0, 'the boundary fixture reads a platform variable');
  for (const variable of platform) {
    assert.equal(
      vars.filter((v) => v.name === variable.name && !v.documented && !v.platform).length,
      0,
    );
  }
  assert.equal(
    undocumentedCount,
    vars.filter((variable) => !variable.documented && !variable.platform).length,
  );
  assert.match(textOf(result), /set by the hosting platform/);
});

test('a variable that looks like a credential says so, with every place it is read', () => {
  const { vars } = call(boundary.dir, 'env_vars').structuredContent;
  const secret = vars.find((variable) => variable.secret);
  assert.ok(secret, 'the fixture reads something that looks like a key');
  assert.ok(secret.sites.length > 0 && secret.sites[0].path);
});

test('a refusal to name unimported files is an answer, not an error', () => {
  // A library's callers are outside the repo, so there is nothing to say. An agent must
  // get the reason rather than an empty list, and must not get `isError` — the tool did
  // its job. This is the one result in the set most likely to be acted on destructively.
  const result = call(library.dir, 'unimported_files');
  assert.ok(!result.isError, 'the tool worked; it is the question that does not apply');
  assert.equal(result.structuredContent.answered, false);
  assert.deepEqual(result.structuredContent.files, []);
  assert.match(textOf(result), /code other code imports/);
});

test('an answered list still says it is a list to check rather than one to delete', () => {
  const result = call(exposure.dir, 'unimported_files');
  assert.equal(result.structuredContent.answered, true);
  assert.match(textOf(result), /list to check, not a list to delete/);
  assert.ok(!/dead code/i.test(textOf(result)));
});

// ---------------------------------------------------------------------------
// A workspace is more than one app, and the answer says which one it is about
// ---------------------------------------------------------------------------

test('in a workspace the answer names the app it is about, and the ones it is not', () => {
  const root = path.join(workspace, 'shop');
  for (const [name, source] of [['web', exposure], ['tools', library]]) {
    const dir = path.join(root, 'apps', name);
    fs.mkdirSync(dir, { recursive: true });
    persistAtlas(dir, source.atlas);
  }
  writeScopes(root, [
    { id: 'web', name: 'web', dir: 'apps/web', kind: 'app' },
    { id: 'tools', name: 'tools', dir: 'apps/tools', kind: 'library' },
  ]);

  const first = call(root, 'unguarded_doors');
  assert.equal(first.structuredContent.app, 'web', 'the first app answers when none is named');
  assert.match(textOf(first), /only about "web"/);
  assert.match(textOf(first), /tools/, 'the app that did not answer is named too');

  const second = call(root, 'unguarded_doors', { scope: 'tools' });
  assert.equal(second.structuredContent.nothingToGuard, true);

  const missing = call(root, 'unguarded_doors', { scope: 'mobile' });
  assert.equal(missing.isError, true);
  assert.match(textOf(missing), /web, tools/, 'says what it could have answered about');
});

test('a re-analysis while the server is running is picked up by the next call', () => {
  // The loop section 7 predicted: the agent edits, `analyze --watch` re-runs beside it,
  // and the agent asks whether the route it just wrote has a check. It only exists if a
  // long-lived server notices that the file underneath it has been replaced.
  const dir = path.join(workspace, 'rewritten');
  fs.mkdirSync(dir, { recursive: true });
  const source = new AtlasSource(dir);

  persistAtlas(dir, exposure.atlas);
  assert.equal(callMcpTool(source, 'unguarded_doors', {}).structuredContent.unguardedCount, 3);

  persistAtlas(dir, library.atlas);
  assert.equal(callMcpTool(source, 'unguarded_doors', {}).structuredContent.nothingToGuard, true);
});

// ---------------------------------------------------------------------------
// The whole thing, over a real pipe
// ---------------------------------------------------------------------------

test('the server speaks the protocol on a real pipe and puts nothing else on stdout', async () => {
  const { stdout } = await drive(exposure.dir, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'unguarded_doors', arguments: {} } },
  ]);

  const lines = stdout.split('\n').filter(Boolean);
  // Three requests, three replies: the notification in the middle must not produce one.
  assert.equal(lines.length, 3, `expected 3 protocol lines, got:\n${stdout}`);

  const messages = lines.map((line) => JSON.parse(line));
  assert.deepEqual(messages.map((message) => message.id), [1, 2, 3]);
  for (const message of messages) assert.equal(message.jsonrpc, '2.0');
  assert.equal(messages[1].result.tools.length, MCP_TOOLS.length);
  assert.match(messages[2].result.content[0].text, /3 of 6 routes have no auth check/);
});

test('the command prints nothing of its own — not a banner, not a progress line', async () => {
  const { stdout, stderr } = await drive(exposure.dir, [{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
  assert.equal(stdout, '{"jsonrpc":"2.0","id":1,"result":{}}\n');
  assert.doesNotMatch(stderr, /App Atlas v/, 'the CLI banner has no business running here');
});

test('a broken line does not take the connection down with it', async () => {
  const { stdout } = await drive(exposure.dir, ['{ not json at all', { jsonrpc: '2.0', id: 2, method: 'ping' }]);
  const messages = stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(messages[0].error.code, RPC_ERROR.parse);
  assert.deepEqual(messages[1], { jsonrpc: '2.0', id: 2, result: {} }, 'still answering afterwards');
});

// ---------------------------------------------------------------------------

/** Spawns `app-atlas mcp`, writes each message, and collects both streams. */
function drive(dir, messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'mcp', dir], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', () => resolve({ stdout, stderr }));
    for (const message of messages) {
      child.stdin.write(typeof message === 'string' ? `${message}\n` : `${JSON.stringify(message)}\n`);
    }
    child.stdin.end();
  });
}

/**
 * A web app whose every route is checked, built by dropping the unchecked doors from a
 * real analysis rather than by writing a fixture whose only job is to be green.
 *
 * The counts are recomputed with the analyzer's own `computeStats`, so this exercises the
 * same arithmetic the CLI prints — nothing about the resulting atlas is hand-written.
 */
function everyRouteChecked() {
  const atlas = structuredClone(exposure.atlas);
  atlas.nodes = atlas.nodes.filter(
    (node) => !(node.kind === 'endpoint' && node.meta.open?.kind === 'worth-a-look'),
  );
  const kept = new Set(atlas.nodes.map((node) => node.id));
  atlas.edges = atlas.edges.filter((edge) => kept.has(edge.fromId) && kept.has(edge.toId));
  atlas.meta.stats = computeStats(atlas.nodes, atlas.edges);

  const dir = path.join(workspace, 'locked-down');
  fs.mkdirSync(dir, { recursive: true });
  persistAtlas(dir, atlas);
  return dir;
}

function escapeForRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
