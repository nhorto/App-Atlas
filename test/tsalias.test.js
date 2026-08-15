/**
 * @fileoverview A tsconfig path alias is this repo's own code, not an npm package (#274).
 *
 * `isPathAlias` knew three spellings — `@/`, `~/` and `#` — and the convention is wider
 * than three. outline writes `@server/*` and `@shared/*`, declared in its own tsconfig;
 * `@app/*`, `@lib/*` and `src/*` are the same family. Every one of them was a bare
 * specifier that matched none of the three, so a repository's own server directory came
 * back `external: true` and `@server` was recorded as a dependency it imports.
 *
 * What that cost is the door below. `refusalBehindTheName` (#261) skips anything imported
 * from a package, because resolving into `node_modules` is expensive and `ownRefusal`
 * declines to read it anyway — so **no middleware reached through an alias could ever be
 * read by its body**. On outline that is the whole server: `import auth from
 * "@server/middlewares/authentication"` stands on 185 of its 226 routes.
 *
 * ## The trap this fixture pins down
 *
 * "In `paths`, therefore internal" is wrong, and outline is the proof — it maps `vite`
 * and `@vitejs/plugin-react` straight into `node_modules`. So the tsconfig here maps
 * `express` the same way, and the assertion is that it stays external. A repo claiming
 * its bundler as first-party code would be the same defect pointing the other way.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'tsalias'), {
  followReferences: true,
  cache: 'off',
});

const doors = new Map(
  atlas.nodes
    .filter((n) => n.kind === 'endpoint' && n.meta.endpointKind === 'http-route')
    .map((n) => [`${n.meta.method} ${n.meta.route}`, (n.meta.guards ?? []).map((g) => g.name)]),
);

test('the fixture parsed, so a silent failure cannot pass as a pass', () => {
  assert.deepEqual(atlas.meta.warnings, []);
  assert.deepEqual([...doors.keys()].sort(), ['GET /health', 'GET /teams']);
});

test('a check imported through a path alias is read by its body', () => {
  // `handleTeamHeaders` matches nothing in the guard vocabulary — it is named after what
  // it does to the request, like every real middleware — so the body is the only
  // evidence, and the body was unreachable while `@server` looked like an npm scope.
  assert.deepEqual(doors.get('GET /teams'), ['handleTeamHeaders']);
});

test('a door with no check still has none', () => {
  assert.deepEqual(doors.get('GET /health'), []);
});

test('an alias pointing into node_modules is still a dependency', () => {
  // The trap: outline's tsconfig maps `vite` and `@vitejs/plugin-react` into
  // `node_modules`, so being in `paths` cannot be the test. This fixture maps `express`
  // the same way. If that were read as first-party the framework would stop being a
  // declared dependency, and the detector that gates on it would go quiet.
  assert.ok(atlas.meta.frameworks.includes('Express'), JSON.stringify(atlas.meta.frameworks));
});
