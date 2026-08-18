/**
 * @fileoverview A package the tests are pointed at is not one of the apps (#289).
 *
 * bruno declares `packages/bruno-tests` in its `workspaces` list. It is the fixture
 * server its own suite makes requests against — 18 runtime dependencies, a real entry
 * point, 46 genuine Express routes — and the switcher offered it as one of bruno's four
 * apps under the headline "41 of 46 routes unprotected". True of the fixture, and
 * meaningless: nobody deploys it, so nobody was ever going to protect it. The cost is
 * the one this project cares about, an alarming number spending the credibility the
 * real numbers need.
 *
 * Neither existing rule can reach it. #174 is about a package *of tests* — no runtime
 * dependencies, a test runner among the dev ones — and this is a package tests are
 * *pointed at*, which looks like an ordinary Express app from every angle but its name.
 * #185 reads the path, and the path says `packages/` like every other member.
 *
 * So the name is the signal, and a name alone is a guess — which is why it is never
 * enough by itself here. The second fact is that nothing in the workspace imports it.
 * Measured across eight monorepos before it was written down: it separates the fixtures
 * (bruno-tests, vite's ~70 `playground/@vitejs/test-*`, turborepo's `lockfile-tests`,
 * grafana's four `test-plugins/*`) from the test-named packages that are real code
 * somebody imports (`@grafana/e2e-selectors`, published to npm; `@grafana/test-utils`;
 * `@turbo/test-utils`; `@immich/e2e-auth-server`). Every one of the latter is depended
 * on by a sibling; not one of the former is.
 *
 * #185's own lesson is kept: this decides what is worth *listing*, never what may be
 * looked at, so `--scope tests` still answers.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { findWorkspace } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MONO = path.join(here, 'fixtures', 'monofixture');

test('the package the suite is pointed at is left off the switcher', async () => {
  const { scopes } = await findWorkspace(MONO);
  assert.deepEqual(
    scopes.map((s) => s.dir).sort(),
    ['packages/api', 'packages/test-utils', 'packages/ui'],
  );
});

test('a test-named package a sibling imports is real code, and stays', async () => {
  // The whole weight of the rule rests here. `@acme/test-utils` reads exactly like
  // `@acme/tests` by name and by path; the only thing telling them apart is that
  // `packages/api` says it needs one of them. Hide this and the rule is a word filter.
  const { scopes, hidden } = await findWorkspace(MONO);
  assert.ok(scopes.some((s) => s.dir === 'packages/test-utils'), JSON.stringify(scopes));
  assert.deepEqual(hidden.map((s) => s.dir).sort(), ['packages/acme-tests', 'packages/acme-tests/vendor/fake-dep']);
});

test('a package inside a fixture is that fixture\'s material, not an app', async () => {
  // vite is where this half showed up: 278 declared members, 136 of them fake npm
  // packages living inside playground fixtures so the resolver under test has something
  // to resolve. `fake-dep` is one of those, and nothing in its own three-line manifest
  // will ever say "test" — looking like an ordinary dependency is its whole job. The
  // fixture above it already said so.
  const { scopes, hidden } = await findWorkspace(MONO);
  assert.ok(!scopes.some((s) => s.dir.startsWith('packages/acme-tests/')), JSON.stringify(scopes));
  assert.ok(hidden.some((s) => s.dir === 'packages/acme-tests/vendor/fake-dep'), JSON.stringify(hidden));
});

test('the hidden fixture is still reachable by name', async () => {
  const { hidden } = await findWorkspace(MONO);
  assert.ok(hidden.some((s) => s.name === 'tests' || s.id === 'packages-acme-tests'), JSON.stringify(hidden));
});
