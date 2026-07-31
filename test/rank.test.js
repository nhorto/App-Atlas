/**
 * @fileoverview "Where to look first", ranked rather than counted (issue #46).
 *
 * The section answers one question — *which file do I open first* — and the way it fails
 * is by answering a different one convincingly. Counting neighbours answers "what is
 * busy". Ranking the obvious way round answers "what does everything depend on", which
 * on every repo measured returned type aliases and small helpers. Both look like
 * plausible lists, which is exactly why the properties below are pinned by name.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { rankFiles } from '../dist/node/model/rank.js';
import { analyzeProject, AtlasGraph } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** A file node, with the two counts `holdsSomething` reads. */
const file = (id, { functions = 1, types = 0, zone = 'logic' } = {}) => ({
  id,
  kind: 'file',
  name: id,
  path: id,
  zone,
  meta: { functionCount: functions, typeCount: types },
});

const imports = (from, to) => ({ id: `${from}->${to}`, kind: 'imports', fromId: from, toId: to, weight: 1 });

test('the file that pulls the others together comes first, not the one they all use', () => {
  // `app` imports two features; both features import `types`, which imports `constants`
  // so that it is eligible on its own account rather than merely filtered out. Everything
  // depends on `types`, and nobody starts reading there.
  const nodes = [file('app'), file('orders'), file('users'), file('types', { types: 4 }), file('constants')];
  const edges = [
    imports('app', 'orders'),
    imports('app', 'users'),
    imports('orders', 'types'),
    imports('users', 'types'),
    imports('types', 'constants'),
  ];

  const ranked = rankFiles(nodes, edges);
  const order = ranked.map((r) => r.node.id);
  assert.equal(order[0], 'app', `got ${order.join(', ')}`);
  assert.ok(
    order.indexOf('types') > order.indexOf('app'),
    `the leaf everything depends on is not the place to start: ${order.join(', ')}`,
  );
});

test('a barrel passes its score on and is not itself the answer', () => {
  // `app` reaches `real` only through `barrel`, which declares nothing of its own.
  const nodes = [file('app'), file('barrel', { functions: 0, types: 0 }), file('real'), file('dep')];
  const edges = [imports('app', 'barrel'), imports('barrel', 'real'), imports('real', 'dep')];

  const ranked = rankFiles(nodes, edges);
  assert.ok(!ranked.some((r) => r.node.id === 'barrel'), 'a file with nothing in it is nowhere to send a reader');
  // It stayed in the *graph*, though: `real` is reachable only through it, and it is
  // ranked here rather than stranded — which is what dropping the barrel outright would
  // have cost.
  assert.ok(ranked.some((r) => r.node.id === 'real'), `got ${ranked.map((r) => r.node.id).join(', ')}`);
});

test('a test file is not an entry point, however much it imports', () => {
  // The shape that put two fixtures in this repo's own top ten: a test imports a great
  // deal on purpose, which under this ranking looks exactly like wiring an app together.
  const nodes = [file('app'), file('a'), file('b'), file('c'), file('spec', { zone: 'test' })];
  const edges = [
    imports('app', 'a'),
    imports('spec', 'a'),
    imports('spec', 'b'),
    imports('spec', 'c'),
  ];

  const ranked = rankFiles(nodes, edges);
  assert.ok(!ranked.some((r) => r.node.id === 'spec'));
  assert.equal(ranked[0].node.id, 'app');
});

test('a file that imports nothing is left out rather than padding the list', () => {
  const nodes = [file('app'), file('leaf'), file('stranded')];
  const edges = [imports('app', 'leaf')];

  const ranked = rankFiles(nodes, edges);
  assert.deepEqual(ranked.map((r) => r.node.id), ['app']);
  assert.equal(ranked[0].imports, 1);
});

test('nothing to rank returns nothing, rather than an arbitrary order', () => {
  const nodes = [file('a'), file('b'), file('c')];
  assert.deepEqual(rankFiles(nodes, []), [], 'no imports resolved — a language tier that cannot link files');
  assert.deepEqual(rankFiles([], []), []);
});

test('the count shown is how many files it imports, which a reader can check', () => {
  const nodes = [file('app'), file('a'), file('b')];
  const ranked = rankFiles(nodes, [imports('app', 'a'), imports('app', 'b')]);
  assert.equal(ranked[0].imports, 2);
});

test('a cycle settles instead of spinning', () => {
  const nodes = [file('a'), file('b'), file('c')];
  const edges = [imports('a', 'b'), imports('b', 'c'), imports('c', 'a')];
  const ranked = rankFiles(nodes, edges);
  assert.equal(ranked.length, 3);
});

test('on a real fixture it lands on the routes, not on the database helper', async () => {
  const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'boundary'), {
    cache: 'off',
    followReferences: true,
  });
  const ranked = new AtlasGraph(atlas).getOverview().whereToLookFirst;
  const ids = ranked.map((entry) => entry.node.id);

  assert.ok(ids[0].includes('/api/'), `expected a route first, got ${ids[0]}`);
  // `db.ts` is imported by nearly everything in this fixture and is exactly what the
  // old ranking put at the top.
  assert.ok(!ids.includes('file:src/lib/db.ts'), 'the thing everything imports is not where you start');
});
