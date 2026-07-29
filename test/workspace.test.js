/**
 * @fileoverview Tests for monorepo scopes.
 *
 * The promise in SPEC.md 5.6 is one atlas per app, each readable on its own — so what
 * is worth testing is that the apps are found, that they are analyzed separately, and
 * that nothing from one app leaks into another's map.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject, findScopes, readScopes, writeScopes } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MONO = path.join(here, 'fixtures', 'mono');
const SAMPLE = path.join(here, 'fixtures', 'sample');

test('finds every package in an npm workspace, and sorts apps first', async () => {
  const scopes = await findScopes(MONO);
  assert.deepEqual(
    scopes.map((s) => `${s.name}:${s.kind}`),
    ['web:app', 'api:app', 'ui:library'],
  );
});

/**
 * Everything lands on `scopes[0]` — the CLI, the server and the web app all take the
 * first one — so the order *is* the answer to "which of these is the project".
 * Alphabetical made cal.com open on `api-proxy`, twelve files of URL rewriting, with
 * `apps/web` sixty packages down the list and never shown.
 */
test('the biggest app leads, and everything after it stays alphabetical', async () => {
  const scopes = await findScopes(MONO);
  // `web` has two source files to `api`'s one, and loses on the alphabet.
  assert.equal(scopes[0].name, 'web');
  assert.deepEqual(
    scopes.slice(1).map((s) => s.name),
    ['api', 'ui'],
    'only one scope moves — a switcher sorted by size would be unpredictable to scan',
  );
});

/**
 * The switcher is a list of names, and `@mono/web` next to `@mono/api` next to
 * `@mono/ui` is three copies of the same prefix and one useful word each.
 */
test('names a package by what makes it different', async () => {
  const scopes = await findScopes(MONO);
  assert.deepEqual(scopes.map((s) => s.name).sort(), ['api', 'ui', 'web']);
  assert.deepEqual(scopes.map((s) => s.id).sort(), ['apps-api', 'apps-web', 'packages-ui']);
});

test('an ordinary repo has no scopes at all, so nothing to switch between', async () => {
  assert.deepEqual(await findScopes(SAMPLE), []);
});

test('a workspace with one package is not a monorepo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-one-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'solo', workspaces: ['apps/*'] }),
  );
  fs.mkdirSync(path.join(dir, 'apps', 'only'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'apps', 'only', 'package.json'), JSON.stringify({ name: 'only' }));

  assert.deepEqual(await findScopes(dir), [], 'one app needs no switcher');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reads pnpm workspaces too', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-pnpm-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'root', private: true }));
  fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "libs/*"\n');
  for (const rel of ['apps/site', 'libs/shared']) {
    fs.mkdirSync(path.join(dir, rel), { recursive: true });
    fs.writeFileSync(path.join(dir, rel, 'package.json'), JSON.stringify({ name: path.basename(rel) }));
  }

  const scopes = await findScopes(dir);
  assert.deepEqual(scopes.map((s) => s.dir).sort(), ['apps/site', 'libs/shared']);
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * The whole point of separate scopes: the API's map must not contain the web app's
 * files. A single map of everything is the hairball this design exists to avoid.
 */
test('each app is analyzed on its own, with nothing from its neighbours', async () => {
  const scopes = await findScopes(MONO);
  const web = scopes.find((s) => s.name === 'web');
  const api = scopes.find((s) => s.name === 'api');

  const webAtlas = (await analyzeProject(path.join(MONO, web.dir), { cache: 'off' })).atlas;
  const apiAtlas = (await analyzeProject(path.join(MONO, api.dir), { cache: 'off' })).atlas;

  const paths = (atlas) => atlas.nodes.filter((n) => n.kind === 'file').map((n) => n.path).sort();
  assert.deepEqual(paths(webAtlas), ['src/app/api/notes/route.ts', 'src/app/page.tsx']);
  assert.deepEqual(paths(apiAtlas), ['src/server.ts']);

  // And each one still knows what it is: the framework detection is per package.
  assert.ok(webAtlas.meta.frameworks.includes('Next.js'));
  assert.ok(apiAtlas.meta.frameworks.includes('Express'));
});

test('the manifest survives a round trip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-manifest-'));
  const scopes = [
    { id: 'apps-web', name: 'web', dir: 'apps/web', kind: 'app' },
    { id: 'packages-ui', name: 'ui', dir: 'packages/ui', kind: 'library' },
  ];
  writeScopes(dir, scopes);
  assert.deepEqual(readScopes(dir), scopes);

  // A project that has never been analyzed answers with an empty list, not an error.
  assert.deepEqual(readScopes(path.join(dir, 'nowhere')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
