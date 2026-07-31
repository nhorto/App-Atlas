/**
 * @fileoverview Groups with a shape (issue #49).
 *
 * The clustering is the claim. Everything downstream of it — the prompt, the sentence,
 * the paragraph a reader repeats in a meeting — is only as good as the cut, and the cut
 * can be checked here for nothing, without a model and without a key.
 *
 * Three failures are pinned by name because each one produced a wrong answer during the
 * build rather than in theory: a file at the top of the repo landing in no group at all
 * (it was the Clerk middleware), one folder too wide to open stopping every other folder
 * from being opened, and a door whose guard sits in an unreadable file being handed on as
 * simply unguarded.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildGroups } from '../dist/node/model/groups.js';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const moduleNode = (dirPath, own, descendants, parentId) => ({
  id: `module:${dirPath}`,
  kind: 'module',
  name: dirPath.split('/').pop() ?? dirPath,
  parentId: parentId ?? 'app:test',
  zone: 'logic',
  path: dirPath,
  meta: { dirPath, fileCount: own, descendantFileCount: descendants },
});

const fileNode = (filePath, zone = 'logic') => ({
  id: `file:${filePath}`,
  kind: 'file',
  name: filePath.split('/').pop(),
  parentId: 'app:test',
  zone,
  path: filePath,
  meta: {},
});

const importEdge = (from, to, weight = 1) => ({
  id: `${from}->${to}`,
  kind: 'imports',
  fromId: `file:${from}`,
  toId: `file:${to}`,
  weight,
  meta: {},
});

const doorNode = (name, route, sites, extra = {}) => ({
  id: `endpoint:${name}`,
  kind: 'endpoint',
  name,
  parentId: null,
  zone: 'api',
  path: null,
  meta: { endpointKind: 'http-route', method: 'GET', route, guards: [], sites: sites.map((p) => ({ path: p, line: 1 })), ...extra },
});

/** A folder of `count` files, so a test can say "too big to describe" without listing them. */
function folder(dir, count, zone = 'logic') {
  return Array.from({ length: count }, (_, index) => fileNode(`${dir}/f${index}.ts`, zone));
}

// ---------------------------------------------------------------------------
// The cut
// ---------------------------------------------------------------------------

test('a folder small enough to describe is left whole', () => {
  // `src` is never opened, so `src/lib` is not a group of its own — its four files are
  // simply part of `src`. Four files is one sentence, not two.
  const nodes = [moduleNode('src', 0, 4), moduleNode('src/lib', 4, 4, 'module:src'), ...folder('src/lib', 4)];
  const { groups } = buildGroups(nodes, []);

  assert.deepEqual(
    groups.map((group) => group.path),
    ['src'],
  );
  assert.equal(groups[0].fileCount, 4);
});

test('a folder too big to describe is opened into its subfolders', () => {
  const nodes = [
    moduleNode('src', 0, 20),
    moduleNode('src/api', 10, 10, 'module:src'),
    moduleNode('src/ui', 10, 10, 'module:src'),
    ...folder('src/api', 10),
    ...folder('src/ui', 10),
  ];
  const { groups } = buildGroups(nodes, []);

  assert.deepEqual(
    groups.map((group) => group.path).sort(),
    ['src/api', 'src/ui'],
  );
});

test('a folder holding files of its own keeps its place when it is opened', () => {
  // `src/` with a couple of files at its top plus two big subfolders is three groups, not
  // two — otherwise the files at the top belong nowhere.
  const nodes = [
    moduleNode('src', 2, 22),
    moduleNode('src/api', 10, 10, 'module:src'),
    moduleNode('src/ui', 10, 10, 'module:src'),
    ...folder('src', 2),
    ...folder('src/api', 10),
    ...folder('src/ui', 10),
  ];
  const { groups } = buildGroups(nodes, []);

  assert.deepEqual(
    groups.map((group) => group.path).sort(),
    ['src', 'src/api', 'src/ui'],
  );
  assert.equal(groups.find((group) => group.path === 'src').fileCount, 2);
});

test('one folder too wide to open does not stop the others being opened', () => {
  // The bug this pins: the loop used to give up at the first candidate that would not
  // fit, so a repo whose biggest folder is a hundred fixtures left its actual source in
  // one undescribed lump. `fixtures` has more subfolders than the budget allows; `src`
  // has two and must still be opened.
  const wide = Array.from({ length: 30 }, (_, index) => moduleNode(`fixtures/p${index}`, 4, 4, 'module:fixtures'));
  const nodes = [
    moduleNode('fixtures', 0, 120),
    ...wide,
    moduleNode('src', 0, 20),
    moduleNode('src/api', 10, 10, 'module:src'),
    moduleNode('src/ui', 10, 10, 'module:src'),
    ...wide.flatMap((mod) => folder(mod.meta.dirPath, 4)),
    ...folder('src/api', 10),
    ...folder('src/ui', 10),
  ];
  const { groups } = buildGroups(nodes, []);
  const paths = groups.map((group) => group.path);

  assert.ok(paths.includes('fixtures'), 'the wide folder stays whole');
  assert.ok(paths.includes('src/api') && paths.includes('src/ui'), 'src was still opened');
});

test("a repo's own top level is never truncated", () => {
  // Twenty top-level packages is an ordinary Go repo. The budget limits how finely we
  // cut; it must not drop a package the repo already has.
  const tops = Array.from({ length: 20 }, (_, index) => moduleNode(`pkg${index}`, 3, 3));
  const nodes = [...tops, ...tops.flatMap((mod) => folder(mod.meta.dirPath, 3))];
  const { groups } = buildGroups(nodes, []);

  assert.equal(groups.length, 20);
});

test('files at the top of the repo get a group instead of vanishing', () => {
  // The one that was actually broken: the fixture's `middleware.ts` is the Clerk check,
  // it hangs off no module, and it was landing nowhere.
  const nodes = [moduleNode('src', 4, 4), ...folder('src', 4), fileNode('middleware.ts', 'api')];
  const { groups, ungroupedFiles } = buildGroups(nodes, []);

  assert.equal(ungroupedFiles, 0);
  const root = groups.find((group) => group.path === '');
  assert.ok(root, 'no group holds the root file');
  assert.deepEqual(root.members, ['middleware.ts']);
});

test('a flat repo with no folders is one group, not none', () => {
  const nodes = folder('', 6).map((file) => ({ ...file, path: file.path.replace(/^\//, '') }));
  const { groups, ungroupedFiles } = buildGroups(nodes, []);

  assert.equal(ungroupedFiles, 0);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].fileCount, 6);
});

test('the same atlas gives the same groups in the same order', () => {
  const nodes = [
    moduleNode('src', 0, 20),
    moduleNode('src/api', 10, 10, 'module:src'),
    moduleNode('src/ui', 10, 10, 'module:src'),
    ...folder('src/api', 10),
    ...folder('src/ui', 10),
  ];
  const first = buildGroups(nodes, []);
  const second = buildGroups(nodes, []);

  assert.deepEqual(first, second);
});

// ---------------------------------------------------------------------------
// The shape
// ---------------------------------------------------------------------------

test('an import across two groups becomes an arrow; one inside a group does not', () => {
  const nodes = [
    moduleNode('src', 0, 20),
    moduleNode('src/api', 10, 10, 'module:src'),
    moduleNode('src/lib', 10, 10, 'module:src'),
    ...folder('src/api', 10),
    ...folder('src/lib', 10),
  ];
  const edges = [
    importEdge('src/api/f0.ts', 'src/lib/f0.ts', 3),
    importEdge('src/api/f1.ts', 'src/lib/f1.ts', 2),
    // Inside src/api — a folder importing itself says nothing about the folder.
    importEdge('src/api/f0.ts', 'src/api/f1.ts', 9),
  ];
  const { groups } = buildGroups(nodes, edges);

  const api = groups.find((group) => group.path === 'src/api');
  const lib = groups.find((group) => group.path === 'src/lib');
  assert.deepEqual(api.dependsOn, [{ toId: 'module:src/lib', toPath: 'src/lib', weight: 5 }]);
  assert.deepEqual(api.usedBy, []);
  assert.deepEqual(lib.usedBy, [{ toId: 'module:src/api', toPath: 'src/api', weight: 5 }]);
});

test('a door is hung on the group its code sits in', () => {
  const nodes = [
    moduleNode('src', 0, 20),
    moduleNode('src/api', 10, 10, 'module:src'),
    moduleNode('src/lib', 10, 10, 'module:src'),
    ...folder('src/api', 9),
    fileNode('src/api/route.ts'),
    ...folder('src/lib', 10),
    doorNode('users', '/api/users', ['src/api/route.ts']),
  ];
  const { groups } = buildGroups(nodes, []);

  assert.deepEqual(
    groups.find((group) => group.path === 'src/api').doors.map((door) => door.name),
    ['GET /api/users'],
  );
  assert.deepEqual(groups.find((group) => group.path === 'src/lib').doors, []);
});

test('an unguarded door carries the reason it is unguarded', () => {
  // Without this the model is handed an empty guard list and nothing else, which is the
  // premise for "these routes are unprotected" about routes that are protected.
  const nodes = [
    moduleNode('api', 1, 1),
    fileNode('api/route.ts'),
    doorNode('items', '/api/items', ['api/route.ts'], {
      open: { kind: 'unreadable', because: 'imports app/api/deps.py, which App Atlas could not read' },
    }),
  ];
  const { groups } = buildGroups(nodes, []);
  const door = groups[0].doors[0];

  assert.deepEqual(door.guards, []);
  assert.equal(door.openKind, 'unreadable');
  assert.match(door.openBecause, /could not read/);
});

test('an exported name is not counted as a way in', () => {
  const nodes = [
    moduleNode('lib', 1, 1),
    fileNode('lib/api.ts'),
    doorNode('get', 'lib/api.ts#get', ['lib/api.ts'], { endpointKind: 'export' }),
    doorNode('post', 'lib/api.ts#post', ['lib/api.ts'], { endpointKind: 'export' }),
  ];
  const { groups } = buildGroups(nodes, []);

  assert.deepEqual(groups[0].doors, []);
  assert.deepEqual(groups[0].publicApi, ['get', 'post']);
  assert.equal(groups[0].publicApiCount, 2);
});

test('past the cap the exports are counted, never sampled', () => {
  // Ten of `requests`' 111 exports, alphabetically, are `address_in_network` and friends
  // and never `get`. A sample that misleads is worse than a number that does not.
  const exports = Array.from({ length: 40 }, (_, index) =>
    doorNode(`sym${String(index).padStart(3, '0')}`, `lib/api.ts#sym${index}`, ['lib/api.ts'], { endpointKind: 'export' }),
  );
  const nodes = [moduleNode('lib', 1, 1), fileNode('lib/api.ts'), ...exports];
  const { groups } = buildGroups(nodes, []);

  assert.deepEqual(groups[0].publicApi, []);
  assert.equal(groups[0].publicApiCount, 40);
});

test('a capped list says how many it is short', () => {
  const doors = Array.from({ length: 25 }, (_, index) =>
    doorNode(`r${index}`, `/api/r${index}`, ['api/route.ts']),
  );
  const nodes = [moduleNode('api', 1, 1), fileNode('api/route.ts'), ...doors];
  const { groups } = buildGroups(nodes, []);

  assert.equal(groups[0].doors.length, 10);
  assert.equal(groups[0].doorCount, 25);
});

// ---------------------------------------------------------------------------
// End to end, on the fixture whose ground truth is known exactly
// ---------------------------------------------------------------------------

test('the boundary fixture cuts into the groups it visibly has', async () => {
  const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'boundary'), {
    cache: 'off',
    followReferences: true,
  });
  const { groups, ungroupedFiles } = buildGroups(atlas.nodes, atlas.edges);

  assert.equal(ungroupedFiles, 0);
  assert.deepEqual(
    groups.map((group) => group.path).sort(),
    ['', 'prisma', 'src/app', 'src/lib', 'supabase'],
  );

  const app = groups.find((group) => group.path === 'src/app');
  const lib = groups.find((group) => group.path === 'src/lib');

  // The flow CodeBoarding's paragraph described and ours could not: routes go through
  // one shared folder, and that folder is where every outside company is called.
  assert.deepEqual(
    app.dependsOn.map((link) => link.toPath),
    ['src/lib'],
  );
  assert.ok(lib.services.includes('Stripe') && lib.services.includes('Resend'));

  // Both auth patterns, on different doors, which is the observation their prose led with.
  const guards = new Set(app.doors.flatMap((door) => door.guards));
  assert.ok(guards.has('requireOwner → auth'), `helper guard missing: ${[...guards]}`);
  assert.ok(guards.has('withTeam → auth'), `HOF wrapper missing: ${[...guards]}`);

  // And the middleware at the top of the repo is somebody's, not nobody's.
  const root = groups.find((group) => group.path === '');
  assert.deepEqual(root.members, ['middleware.ts']);
});
