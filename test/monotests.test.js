/**
 * @fileoverview Thirty-three test fixtures listed as apps is a switcher nobody can use
 * (#185).
 *
 * nuxt's `pnpm-workspace.yaml` really does declare `test/fixtures/*` — that is how pnpm
 * links them for the test run — so App Atlas offered 43 scopes, 33 of them fixtures and
 * seventeen of those a single file each, with the six packages somebody ships buried in
 * a list four-fifths noise. Being literal is not the same as being right: the switcher
 * answers "which app am I looking at", and a one-file fixture is not an app.
 *
 * #174 settled this one level down — a package of tests is not code other code imports
 * — and `describesTheApp()` has kept test-zone findings out of the merge all along.
 * Scope discovery simply never asked the question.
 *
 * Two things kept honest here: the count of what was left out is reported rather than
 * silently dropped (#143's workspace aside is the precedent), and a repo whose *only*
 * packages are fixtures still gets them, because an empty switcher on a repo that has
 * packages is the worse answer.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { findWorkspace } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MONO = path.join(here, 'fixtures', 'monotests');

test('the fixtures are declared, and the switcher offers only the packages', async () => {
  const { scopes, hiddenTests } = await findWorkspace(MONO);
  assert.deepEqual(
    scopes.map((s) => s.dir).sort(),
    ['packages/api', 'packages/ui'],
  );
  assert.equal(hiddenTests, 2);
});

test('a workspace of nothing but fixtures still gets mapped', async () => {
  // The floor: an empty switcher on a repo that has packages is the worse answer.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-onlytests-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'onlytests', private: true, workspaces: ['test/fixtures/*'] }),
  );
  for (const name of ['one', 'two']) {
    const pkg = path.join(dir, 'test', 'fixtures', name);
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: `fixture-${name}` }));
    fs.writeFileSync(path.join(pkg, 'index.js'), 'export const a = 1;\n');
  }

  const { scopes, hiddenTests } = await findWorkspace(dir);
  assert.equal(scopes.length, 2, 'the fixtures are all there is, so they are the map');
  assert.equal(hiddenTests, 0, 'nothing was hidden, so nothing is claimed to be');
  fs.rmSync(dir, { recursive: true, force: true });
});
