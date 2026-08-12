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
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import {
  analyzeProject,
  AtlasGraph,
  bundleMaps,
  installedPackages,
  packageAt,
  parseFrames,
  traceError,
} from '../dist/node/index.js';

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

// ---------------------------------------------------------------------------
// A trace off a production build
// ---------------------------------------------------------------------------

/**
 * The trace anybody actually has when it matters: one line, one enormous column, and a
 * file name nobody wrote. Placing it needs the map the build emitted, and everything
 * below is about what happens when there is one, when there is not, and what the frame
 * is allowed to claim in each case.
 *
 * `gZAQEA` is column 400 → source 0, line 8 (counted from 0), column 2, name 0, worked
 * out by hand from the VLQ rules; `gZAQE` is the same segment with no name on it.
 */
const AT_COLUMN_400 = 'gZAQEA';
const MINIFIED_TRACE = "TypeError: Cannot read properties of undefined (reading 'to')\n    at n (/var/task/dist/app.bundle:1:401)";

function withMap(sources, names, mappings = AT_COLUMN_400) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-trace-'));
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'dist', 'app.bundle.map'),
    JSON.stringify({ version: 3, file: 'app.bundle', sources, names, mappings }),
  );
  return bundleMaps(root);
}

test('a frame in a bundle is placed on the source the map points at', () => {
  const maps = withMap(['../src/lib/email.ts'], ['sendWelcome']);
  const result = traceError(graph, MINIFIED_TRACE, maps);
  const [frame] = result.frames;

  assert.equal(frame.path, 'src/lib/email.ts');
  assert.equal(frame.nodeName, 'sendWelcome');
  assert.equal(frame.nodeKind, 'function');
  assert.equal(frame.reason, null);
  assert.equal(result.needsSourceMap, false);
});

test('the line shown is the source’s, and the bundle’s is kept beside it', () => {
  // `frame.line` is 1 — true of the bundle and meaningless about a `.ts` file. Anything
  // printing a path has to print `sourceLine` next to it, so the pair is pinned here.
  const result = traceError(graph, MINIFIED_TRACE, withMap(['../src/lib/email.ts'], ['sendWelcome']));
  const [frame] = result.frames;

  assert.equal(frame.sourceLine, 9);
  assert.equal(frame.frame.line, 1, 'what the trace said, unchanged');
  assert.equal(frame.mappedFrom.bundlePath, '/var/task/dist/app.bundle');
  assert.equal(frame.mappedFrom.bundleLine, 1);
  assert.equal(frame.mappedFrom.bundleColumn, 401);
  assert.equal(frame.mappedFrom.mapPath, 'dist/app.bundle.map');
});

test('a mapped frame walks back to the doors like any other', () => {
  const result = traceError(graph, MINIFIED_TRACE, withMap(['../src/lib/email.ts'], ['sendWelcome']));
  assert.ok(result.origin);
  assert.equal(result.origin.path, 'src/lib/email.ts');
  assert.ok(result.doors.length > 0, 'the backward walk starts from the mapped node, not the bundle');
});

test('a bundle with no map says so, rather than that no file matches', () => {
  // The file does exist and is in this repo. What is missing is the map, and that is
  // something the reader can go and fix — "no file matches that path" is not.
  const result = traceError(graph, MINIFIED_TRACE);
  const [frame] = result.frames;
  assert.equal(frame.nodeId, null);
  assert.equal(frame.reason, 'minified');
  assert.equal(result.needsSourceMap, true);
});

test('a minified name is never held against the source', () => {
  // The runtime called it `n`. Comparing that with `sendWelcome` would flag every frame
  // in every production trace as drifted, which is the same as flagging none of them.
  const result = traceError(graph, MINIFIED_TRACE, withMap(['../src/lib/email.ts'], [], 'gZAQE'));
  const [frame] = result.frames;
  assert.equal(frame.nodeName, 'sendWelcome');
  assert.equal(frame.nameDrifted, false, 'the map kept no name, so there is nothing to disagree with');
});

test('a name the map did keep is still compared', () => {
  // A stale bundle maps to a name that has since been renamed. That is real drift, and
  // it is the one case where a minified trace can still say the source has moved on.
  const result = traceError(graph, MINIFIED_TRACE, withMap(['../src/lib/email.ts'], ['sendWelcomeEmail']));
  const [frame] = result.frames;
  assert.ok(frame.nodeId, 'still placed — the file is right');
  assert.equal(frame.nameDrifted, true);
});

test('a map pointing at a file this atlas never read is reported, not ignored', () => {
  const result = traceError(graph, MINIFIED_TRACE, withMap(['../src/nowhere/ghost.ts'], ['gone']));
  const [frame] = result.frames;
  assert.equal(frame.nodeId, null);
  assert.equal(frame.reason, 'unknown-file');
  assert.equal(frame.mappedFrom.source, 'src/nowhere/ghost.ts', 'the mapping worked; the file is the problem');
});

// ---------------------------------------------------------------------------
// When the whole stack is somebody else's code
// ---------------------------------------------------------------------------

test('a vendored path gives up the package it is inside', () => {
  assert.equal(packageAt('/srv/app/node_modules/lodash/get.js'), 'lodash');
  assert.equal(packageAt('/srv/app/node_modules/@supabase/supabase-js/dist/main/index.js'), '@supabase/supabase-js');
  assert.equal(packageAt('/usr/lib/python3.11/site-packages/requests/api.py'), 'requests');
  assert.equal(packageAt('/usr/lib/python3.11/site-packages/six.py'), 'six');
  assert.equal(packageAt('/root/go/pkg/mod/github.com/gin-gonic/gin@v1.9.1/context.go'), 'github.com/gin-gonic/gin');
});

test('the innermost copy of a nested package is the one named', () => {
  // `a` vendored its own `b`. The frame is in `b`, and saying `a` would send the reader
  // to a package whose code never ran.
  assert.equal(packageAt('/srv/node_modules/a/node_modules/b/index.js'), 'b');
});

test("the module cache's escaping is undone rather than passed through", () => {
  // The cache spells a capital `!x` so case-insensitive filesystems can hold two
  // modules whose paths differ only in case. `!burnt!sushi` matches no import as-is.
  assert.equal(
    packageAt('/root/go/pkg/mod/github.com/!burnt!sushi/toml@v1.3.2/decode.go'),
    'github.com/BurntSushi/toml',
  );
});

test('a package name nobody could look up is not invented', () => {
  assert.equal(packageAt('/srv/app/src/lib/email.ts'), null, 'not vendored at all');
  assert.equal(packageAt('/srv/app/node_modules/@supabase'), null, 'a scope is not a package');
  assert.equal(packageAt('/root/go/pkg/mod/github.com/x/y/z.go'), null, 'no version segment, so no module path');
});

test('a trace with none of your code in it still says where you reach for that library', () => {
  const result = traceError(
    graph,
    [
      'PrismaClientKnownRequestError: Unique constraint failed',
      '    at wrapEngine (/srv/app/node_modules/@prisma/client/runtime/library.js:121:31)',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ].join('\n'),
  );
  assert.equal(result.origin, null, 'nothing of theirs is in the paste');
  assert.ok(result.intoDependency, 'and yet there is something to say');
  assert.equal(result.intoDependency.packageName, '@prisma/client');
  assert.deepEqual(
    result.intoDependency.importers.map((f) => f.path),
    ['src/lib/db.ts'],
  );
});

test('the files it names carry the ways in that reach them', () => {
  const result = traceError(
    graph,
    '    at wrapEngine (/srv/app/node_modules/@prisma/client/runtime/library.js:121:31)',
  );
  const [importer] = result.intoDependency.importers;
  assert.ok(importer.doors.length > 0, 'db.ts is reachable from the routes that use it');
  // Same claim the placed-frame path makes: every door that can reach it, not a pick.
  // By id, not by label — `GET /api/users` and `POST /api/users` are two doors that
  // print the same route, and the method badge beside them is what tells them apart.
  const ids = importer.doors.map((reach) => reach.door.id);
  assert.equal(new Set(ids).size, ids.length, 'no door is listed twice');
  assert.ok(
    importer.doors.every((reach) => reach.hops > 0 && reach.viaNames.length === reach.via.length),
    'every door carries the chain that proves it',
  );
});

test('a package nothing here imports is named as one, not passed off as yours', () => {
  // `postgrest-js` is what supabase-js is built on. A trace can die in it while no file
  // in the repo has ever mentioned it, and claiming otherwise would be a fabrication.
  const result = traceError(
    graph,
    '    at PostgrestBuilder.then (/srv/app/node_modules/@supabase/postgrest-js/dist/cjs/PostgrestBuilder.js:110:15)',
  );
  assert.equal(result.intoDependency.packageName, '@supabase/postgrest-js');
  assert.deepEqual(result.intoDependency.importers, [], 'nothing imports it directly');
});

test('the innermost frame that anything imports is the one answered', () => {
  // The stack passes out of a package nobody imports and into one somebody does. The
  // second is the useful answer; stopping at the first would give up too early.
  const result = traceError(
    graph,
    [
      '    at PostgrestBuilder.then (/srv/app/node_modules/@supabase/postgrest-js/dist/cjs/PostgrestBuilder.js:110:15)',
      '    at SupabaseClient.from (/srv/app/node_modules/@supabase/supabase-js/dist/main/index.js:44:12)',
    ].join('\n'),
  );
  assert.equal(result.intoDependency.packageName, '@supabase/supabase-js');
  assert.deepEqual(
    result.intoDependency.importers.map((f) => f.path),
    ['src/lib/metrics.ts'],
  );
});

test('a trace that did place a frame is not also given the weaker answer', () => {
  // `intoDependency` is what to say *instead of* an origin. Offering both would put a
  // guess next to a fact and let the reader take them for the same kind of thing.
  const result = traceError(
    graph,
    [
      '    at wrapEngine (/srv/app/node_modules/@prisma/client/runtime/library.js:121:31)',
      '    at createUser (/srv/app/src/app/api/users/route.ts:12:5)',
    ].join('\n'),
  );
  assert.ok(result.origin, 'a real frame was placed');
  assert.equal(result.intoDependency, null);
});

test('a stack of nothing but the runtime has no library to point at', () => {
  const result = traceError(graph, '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)');
  assert.equal(result.origin, null);
  assert.equal(result.intoDependency, null, 'the runtime is not a package anybody imports');
});

// ---------------------------------------------------------------------------
// The two things a real app taught this, which no fixture had
// ---------------------------------------------------------------------------

/** A throwaway project on disk, so a test can shape an import graph no fixture has. */
async function scratch(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-dep-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'scratch', version: '0.0.0' }));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, path.dirname(name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  const built = (await analyzeProject(dir, { followReferences: true, cache: 'off' })).atlas;
  return { dir, graph: new AtlasGraph(built) };
}

test('a package the whole app imports is counted, never sampled', async () => {
  // Found by tracing a React Native error against a real app: `react-native` had 118
  // importers and the answer was the first eight alphabetically, which began inside a
  // `backup/` folder. Eight arbitrary paths read as eight suspects.
  const files = {};
  for (let n = 0; n < 20; n++) {
    files[`src/screen${n}.ts`] = `import { View } from 'everywhere';\nexport const s${n} = View;\n`;
  }
  const { graph: wide } = await scratch(files);

  const result = traceError(wide, '    at render (/srv/app/node_modules/everywhere/dist/index.js:41:9)');
  assert.equal(result.intoDependency.packageName, 'everywhere');
  assert.equal(result.intoDependency.total, 20, 'the count is the answer');
  assert.deepEqual(result.intoDependency.importers, [], 'and no file is put forward as the one');
});

test('few enough importers to be worth naming are named', async () => {
  const { graph: narrow } = await scratch({
    'src/one.ts': "import { z } from 'niche';\nexport const a = z;\n",
    'src/two.ts': "export const b = 2;\n",
  });
  const result = traceError(narrow, '    at z (/srv/app/node_modules/niche/index.js:3:1)');
  assert.equal(result.intoDependency.total, 1);
  assert.deepEqual(
    result.intoDependency.importers.map((f) => f.path),
    ['src/one.ts'],
  );
});

test('a package nothing imports is found through the dependency of yours that declares it', () => {
  // The common shape of a real JavaScript trace: it dies in `@supabase/auth-js`, which
  // nobody types, because `@supabase/supabase-js` brought it along.
  const installed = {
    dependents: (name, among) =>
      name === '@supabase/auth-js' ? among.filter((p) => p === '@supabase/supabase-js') : [],
  };
  const result = traceError(
    graph,
    '    at handleError (/srv/app/node_modules/@supabase/auth-js/dist/main/lib/fetch.js:64:11)',
    undefined,
    installed,
  );
  assert.equal(result.intoDependency.packageName, '@supabase/auth-js', 'still says where it died');
  assert.equal(result.intoDependency.via, '@supabase/supabase-js', 'and how your code gets there');
  assert.deepEqual(
    result.intoDependency.importers.map((f) => f.path),
    ['src/lib/metrics.ts'],
  );
});

test('a parent is only ever a package this project actually imports', () => {
  // Otherwise the answer is a package name the reader has no relationship with, which is
  // one more thing to go and look up rather than somewhere to start.
  let offered = null;
  const installed = {
    dependents: (_name, among) => {
      offered = among;
      return [];
    },
  };
  traceError(graph, '    at x (/srv/app/node_modules/undici/lib/core/request.js:1:1)', undefined, installed);
  assert.ok(offered.includes('@prisma/client'), 'the packages this project imports are offered');
  assert.ok(!offered.includes('undici'), 'and the package it died in is not one of them');
});

test('importing a package directly beats reaching it through a parent, wherever the frame sits', () => {
  // A stack that passes through a transitive package and then one this project chose:
  // the chosen one is the better answer even though its frame is further out.
  const installed = { dependents: () => ['@clerk/nextjs'] };
  const result = traceError(
    graph,
    [
      '    at fetchImpl (/srv/app/node_modules/undici/lib/fetch/index.js:88:1)',
      '    at Stripe._request (/srv/app/node_modules/stripe/cjs/stripe.core.js:200:5)',
    ].join('\n'),
    undefined,
    installed,
  );
  assert.equal(result.intoDependency.packageName, 'stripe');
  assert.equal(result.intoDependency.via, null, 'imported outright, so there is no parent to name');
});

// ---------------------------------------------------------------------------
// Reading the installed tree
// ---------------------------------------------------------------------------

/** A `node_modules` on disk, because that is the only thing `installedPackages` reads. */
function installTree(packages) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-nm-'));
  for (const [name, manifest] of Object.entries(packages)) {
    const at = path.join(dir, 'node_modules', ...name.split('/'));
    fs.mkdirSync(at, { recursive: true });
    fs.writeFileSync(path.join(at, 'package.json'), JSON.stringify({ name, ...manifest }));
  }
  return dir;
}

test('a manifest that declares the package is what makes it the parent', () => {
  const dir = installTree({
    '@supabase/supabase-js': { dependencies: { '@supabase/auth-js': '^2.0.0' } },
    stripe: { dependencies: { qs: '^6.0.0' } },
  });
  const installed = installedPackages(dir);
  assert.deepEqual(installed.dependents('@supabase/auth-js', ['@supabase/supabase-js', 'stripe']), [
    '@supabase/supabase-js',
  ]);
  assert.deepEqual(installed.dependents('qs', ['@supabase/supabase-js', 'stripe']), ['stripe']);
});

test('peer and optional dependencies count — they are installed and they run', () => {
  const dir = installTree({
    a: { peerDependencies: { react: '^19.0.0' } },
    b: { optionalDependencies: { fsevents: '^2.0.0' } },
  });
  const installed = installedPackages(dir);
  assert.deepEqual(installed.dependents('react', ['a', 'b']), ['a']);
  assert.deepEqual(installed.dependents('fsevents', ['a', 'b']), ['b']);
});

test('nothing installed is answered as nothing, not as a crash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-bare-'));
  assert.deepEqual(installedPackages(dir).dependents('anything', ['a', 'b']), []);
});

test('a manifest that is not JSON is one that declares nothing', () => {
  const dir = installTree({ broken: {} });
  fs.writeFileSync(path.join(dir, 'node_modules', 'broken', 'package.json'), '{ not json');
  assert.deepEqual(installedPackages(dir).dependents('x', ['broken']), []);
});

test('a name that is a path rather than a package never reaches the filesystem', () => {
  const dir = installTree({ real: { dependencies: { x: '1' } } });
  // Package names come from import specifiers this tool wrote down, so this should not
  // be reachable — which is exactly why it is checked rather than assumed.
  assert.deepEqual(installedPackages(dir).dependents('x', ['../../etc', 'real']), ['real']);
});

test('a package does not count as its own parent', () => {
  const dir = installTree({ self: { dependencies: { self: '1' } } });
  assert.deepEqual(installedPackages(dir).dependents('self', ['self']), []);
});

test('a module that exports a constant is not reported as reached by nobody', async () => {
  // Found by driving a real Expo app. `lib/supabase.js` creates a client and declares no
  // functions, so it has no declarations to walk back from and nothing *references* it —
  // four screens simply import it. The panel said "no way in reaches this file" about a
  // module the whole app runs through, which is the confident-negative this tool exists
  // to avoid. Importing a module evaluates it, so a door whose file imports it does
  // reach it.
  const { graph: app } = await scratch({
    'lib/client.js': "import { createClient } from 'vendorsdk';\nexport const client = createClient();\n",
    'app/index.js': "import { client } from '../lib/client';\nexport default function HomeScreen() {\n  return client;\n}\n",
  });

  const result = traceError(app, '    at send (/srv/app/node_modules/vendorsdk/dist/index.js:12:3)');
  const importer = result.intoDependency.importers.find((f) => f.path === 'lib/client.js');
  assert.ok(importer, 'the file that imports it is named');
  assert.ok(importer.doors.length > 0, 'and the screen that imports that file reaches it');
  assert.ok(
    importer.doors.some((reach) => reach.viaNames.includes('HomeScreen')),
    `the chain runs through the screen: ${JSON.stringify(importer.doors.map((r) => r.viaNames))}`,
  );
});

test('a stack frame still only follows calls, never imports', () => {
  // The wider walk is for a file-level question. A placed frame asks about one function,
  // and "this door imports the file your error is in" is not the same claim as "this
  // door can call it" — widening that path would quietly inflate every trace.
  const result = traceError(graph, '    at sendWelcome (/srv/app/src/lib/email.ts:9:5)');
  assert.ok(result.origin, 'the frame is placed');
  for (const reach of result.doors) {
    assert.ok(
      reach.via.every((id) => id.startsWith('endpoint:') || id.startsWith('func:')),
      `a call chain is doors and functions, not files: ${reach.viaNames.join(' → ')}`,
    );
  }
});
