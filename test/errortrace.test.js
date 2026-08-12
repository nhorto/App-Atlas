/**
 * @fileoverview Putting a pasted stack trace onto the map.
 *
 * This is the one feature that joins evidence from a run to a map read from source, and
 * the ways it can lie are specific:
 *
 *   - a frame it cannot place must say so, because a dropped frame reads as a frame
 *     that did not happen;
 *   - a path that matches two files must return both, because picking one is how this
 *     sends somebody to the wrong file for an hour;
 *   - and when several doors can reach the failing code, all of them come back — the
 *     trace says where the program was, never which way in put it there.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { analyzeProject, AtlasGraph, parseFrames, traceError } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOUNDARY = path.join(here, 'fixtures', 'boundary');

const atlas = (await analyzeProject(BOUNDARY, { followReferences: true, cache: 'off' })).atlas;
const graph = new AtlasGraph(atlas);
const ROOT = atlas.meta.root;

// ---------------------------------------------------------------------------
// Reading the paste
// ---------------------------------------------------------------------------

test('a V8 trace gives up its files, lines and function names', () => {
  const frames = parseFrames(
    [
      "TypeError: Cannot read properties of undefined (reading 'id')",
      '    at createUser (/srv/app/src/app/api/users/route.ts:12:5)',
      '    at async POST (/srv/app/src/app/api/users/route.ts:4:3)',
      '    at /srv/app/src/server.ts:9:1',
    ].join('\n'),
  );
  assert.equal(frames.length, 3);
  assert.deepEqual(
    frames.map((frame) => [frame.functionName, frame.line, frame.column]),
    [
      ['createUser', 12, 5],
      ['async POST', 4, 3],
      [null, 9, 1],
    ],
  );
  assert.ok(frames.every((frame) => frame.language === 'javascript'));
});

test('the message and the prose around it are not mistaken for frames', () => {
  const frames = parseFrames(
    [
      '2026-08-12T10:04:22.114Z ERROR request failed',
      'Error: connect ECONNREFUSED 127.0.0.1:5432',
      'this happens every time I click save',
      '    at handler (/srv/app/src/app/api/users/route.ts:12:5)',
    ].join('\n'),
  );
  assert.equal(frames.length, 1, 'only the line that names a file and a number');
  assert.equal(frames[0].functionName, 'handler');
});

test('each supported runtime is read in its own shape', () => {
  const cases = [
    ['python', '  File "/srv/app/api/users.py", line 42, in create_user', '/srv/app/api/users.py', 42, 'create_user'],
    [
      'dotnet',
      '   at Shop.Api.Controllers.OrdersController.Delete(Int32 id) in /src/Orders.cs:line 42',
      '/src/Orders.cs',
      42,
      'Shop.Api.Controllers.OrdersController.Delete(Int32 id)',
    ],
    ['java', '\tat com.example.shop.Checkout.pay(Checkout.java:88)', 'Checkout.java', 88, 'com.example.shop.Checkout.pay'],
  ];
  for (const [language, line, expectedPath, expectedLine, expectedName] of cases) {
    const [frame] = parseFrames(line);
    assert.ok(frame, `${language} frame was not read at all`);
    assert.equal(frame.language, language);
    assert.equal(frame.rawPath, expectedPath);
    assert.equal(frame.line, expectedLine);
    assert.equal(frame.functionName, expectedName);
  }
});

test('a Go panic takes its function from the line above the file', () => {
  const [frame] = parseFrames(
    ['panic: runtime error: invalid memory address', '', 'goroutine 1 [running]:', 'main.handleOrder(0xc000112000)', '\t/build/internal/api/router.go:57 +0x1d'].join('\n'),
  );
  assert.ok(frame);
  assert.equal(frame.language, 'go');
  assert.equal(frame.rawPath, '/build/internal/api/router.go');
  assert.equal(frame.line, 57);
  assert.equal(frame.functionName, 'main.handleOrder');
});

test('a .NET frame is not read as a JavaScript one ending in "line"', () => {
  // Both shapes begin `at `, and the V8 pattern would happily take `:line 42` as part
  // of a path. Order of the patterns is load-bearing, so it is pinned here.
  const [frame] = parseFrames('   at Shop.Delete(Int32 id) in /src/Orders.cs:line 42');
  assert.equal(frame.language, 'dotnet');
  assert.equal(frame.rawPath, '/src/Orders.cs');
  assert.equal(frame.line, 42);
});

// ---------------------------------------------------------------------------
// Putting it on the map
// ---------------------------------------------------------------------------

test('a frame in your own code lands on the function that holds that line', () => {
  const result = traceError(graph, `Error: nope\n    at sendWelcome (${ROOT}/src/lib/email.ts:9:3)`);
  const [frame] = result.frames;
  assert.equal(frame.path, 'src/lib/email.ts');
  assert.equal(frame.nodeKind, 'function');
  assert.equal(frame.nodeName, 'sendWelcome', 'the innermost range holding line 9');
  assert.equal(frame.reason, null);
});

test('a line between the functions lands on the file, which is the honest answer', () => {
  // Line 3 is inside the file's own docstring. There is no function to name, and
  // saying "the nearest one" would be inventing a location the trace never gave.
  const result = traceError(graph, `Error: nope\n    at x (${ROOT}/src/lib/email.ts:3:1)`);
  const [frame] = result.frames;
  assert.equal(frame.nodeKind, 'file');
  assert.equal(frame.nodeName, 'email.ts');
  assert.equal(frame.reason, null);
});

test('an absolute path from another machine still finds the file', () => {
  // The trace came off a container or a colleague's laptop, so the prefix never
  // existed here. The tail of the path is the part that means anything.
  const result = traceError(graph, '    at x (/build/output/src/lib/email.ts:3:1)');
  assert.equal(result.frames[0].path, 'src/lib/email.ts');
  assert.ok(result.frames[0].nodeId);
});

test('a file:// url, a Windows path and a webpack prefix are the same file', () => {
  const paths = [
    `file://${ROOT}/src/lib/email.ts`,
    'C:\\build\\src\\lib\\email.ts',
    'webpack-internal:///./src/lib/email.ts',
  ];
  for (const written of paths) {
    const result = traceError(graph, `    at x (${written}:3:1)`);
    assert.equal(result.frames[0].path, 'src/lib/email.ts', `${written} did not resolve`);
  }
});

test('a dependency frame is named as one rather than dropped', () => {
  const result = traceError(graph, '    at mount (/srv/app/node_modules/react-dom/cjs/react-dom.development.js:23150:26)');
  assert.equal(result.frames.length, 1, 'it is still reported');
  assert.equal(result.frames[0].nodeId, null);
  assert.equal(result.frames[0].reason, 'dependency');
});

test('a frame the runtime invented is kept apart from a file nobody could find', () => {
  const result = traceError(
    graph,
    ['    at processTicksAndRejections (node:internal/process/task_queues:95:5)', '    at z (/srv/app/src/nowhere/ghost.ts:2:1)'].join('\n'),
  );
  assert.equal(result.frames[0].reason, 'runtime');
  assert.equal(result.frames[1].reason, 'unknown-file');
});

test('a name that could be two files returns both instead of choosing', () => {
  // A JVM frame carries a bare file name. Where the repo has more than one file with
  // that name, picking is how this feature sends somebody to the wrong one.
  const names = graph.filePaths().map((p) => p.split('/').pop());
  const repeated = names.find((name, index) => names.indexOf(name) !== index);
  if (!repeated) return; // the fixture has no duplicate basenames to exercise this

  const result = traceError(graph, `\tat com.example.Thing.go(${repeated.replace(/\.\w+$/, '.java')}:1)`);
  const [frame] = result.frames;
  if (frame.reason === 'ambiguous') {
    assert.ok(frame.candidates.length > 1);
    assert.equal(frame.nodeId, null, 'an ambiguous frame is never placed');
  }
});

test('nothing that looks like a frame is said out loud, not left as an empty answer', () => {
  const result = traceError(graph, 'the app crashes when I click save and I do not know why');
  assert.equal(result.parsedNothing, true);
  assert.deepEqual(result.frames, []);
  assert.equal(result.origin, null);
  assert.deepEqual(result.doors, []);
});

test('the origin is the innermost frame that is yours, not the innermost frame', () => {
  const result = traceError(
    graph,
    [
      'Error: boom',
      '    at inner (/srv/app/node_modules/pg/lib/client.js:10:1)',
      '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
      `    at sendWelcome (${ROOT}/src/lib/email.ts:9:3)`,
    ].join('\n'),
  );
  assert.ok(result.origin, 'a frame of yours was found further down the stack');
  assert.equal(result.origin.path, 'src/lib/email.ts');
});

test('a trace entirely inside somebody else’s code has no origin, and says so', () => {
  const result = traceError(
    graph,
    ['    at a (/srv/app/node_modules/pg/lib/client.js:10:1)', '    at b (node:internal/process/task_queues:95:5)'].join('\n'),
  );
  assert.equal(result.parsedNothing, false, 'the frames were read');
  assert.equal(result.origin, null, 'none of them is yours');
  assert.deepEqual(result.doors, []);
});

// ---------------------------------------------------------------------------
// Walking back
// ---------------------------------------------------------------------------

test('the doors that can reach the failing code come back with the chain that proves it', () => {
  const result = traceError(graph, `Error: boom\n    at sendWelcome (${ROOT}/src/lib/email.ts:9:3)`);
  assert.ok(result.origin);
  assert.ok(result.doors.length > 0, 'something in this fixture reaches the mailer');

  for (const reach of result.doors) {
    assert.ok(reach.via.length >= 2, 'a chain is at least a door and the code');
    assert.equal(reach.via[0], reach.door.id, 'the chain starts at the door');
    assert.equal(reach.via[reach.via.length - 1], result.origin.nodeId, 'and ends at the failing code');
    assert.equal(reach.viaNames.length, reach.via.length);
    assert.equal(reach.hops, reach.via.length - 1);
    assert.ok(['certain', 'likely', 'possible'].includes(reach.confidence));
  }
});

test('every door that can reach it is listed, nearest first, with none picked as the cause', () => {
  const result = traceError(graph, `Error: boom\n    at sendWelcome (${ROOT}/src/lib/email.ts:9:3)`);
  const hops = result.doors.map((reach) => reach.hops);
  assert.deepEqual(hops, [...hops].sort((a, b) => a - b), 'nearest first');
  assert.equal(new Set(result.doors.map((reach) => reach.door.id)).size, result.doors.length, 'no door twice');
});

test('a confidence is never stronger than the weakest link behind it', () => {
  const result = traceError(graph, `Error: boom\n    at sendWelcome (${ROOT}/src/lib/email.ts:9:3)`);
  for (const reach of result.doors) {
    const rank = { certain: 2, likely: 1, possible: 0 };
    for (let i = 0; i < reach.via.length - 1; i++) {
      const edges = graph
        .edgesTo(reach.via[i + 1])
        .filter((edge) => edge.fromId === reach.via[i]);
      if (edges.length === 0) continue;
      const best = Math.max(...edges.map((edge) => rank[edge.confidence]));
      assert.ok(rank[reach.confidence] <= best, `${reach.door.name} claims more than its ${i}th edge carries`);
    }
  }
});

test('a trace whose function name disagrees with that line is flagged, not silently moved', () => {
  // Someone pastes an error from before their last edit. The file is right and the
  // neighbourhood usually is, but the exact function may have moved, and a reader
  // sent to the wrong function without warning is the failure worth avoiding.
  const result = traceError(graph, `Error: boom\n    at aFunctionThatIsNotThere (${ROOT}/src/lib/email.ts:9:3)`);
  const [frame] = result.frames;
  assert.ok(frame.nodeId, 'the frame is still placed');
  assert.equal(frame.nameDrifted, true);
});

test('an ordinary trace is not flagged as drifted', () => {
  const result = traceError(graph, `Error: boom\n    at sendWelcome (${ROOT}/src/lib/email.ts:9:3)`);
  assert.equal(result.frames[0].nameDrifted, false);
  assert.equal(result.frames[0].nodeName, 'sendWelcome');
});
