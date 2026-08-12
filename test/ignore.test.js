/**
 * @fileoverview `--ignore` covers the whole atlas, not just the file scan.
 *
 * The bug these pin: the flag was threaded into the four globs that find source files
 * and nowhere else. Every reader of a *config* file — the Cargo manifests, the
 * `.csproj` files, the wrangler configs, the Compose files — walks the tree itself, and
 * not one of them consulted the list. So a repo analyzed with `--ignore 'test/fixtures/**'`
 * was still told it was "Built with Actix Web … Diesel", still handed three Cloudflare
 * data stores and a route answering every URL on the domain, and every one of those
 * claims cited a path the reader had just asked not to look at. App Atlas's own ATLAS.md
 * shipped two of them.
 *
 * A fact sourced to an invisible file is the one thing a reader cannot check, which is
 * why these run the fixture twice: once to prove the declarations are really there, and
 * once to prove the flag takes all of them out together.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject, AtlasGraph, renderAtlasMarkdown } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'ignored');

/** Everything the fixture declares, with nothing left out. */
const shown = await analyzeProject(FIXTURE, { cache: 'off' });
/** The same repo with its sample apps out of view — the flag under test. */
const hidden = await analyzeProject(FIXTURE, { cache: 'off', ignore: ['examples/**'] });

const storeNames = (result) => result.atlas.nodes.filter((n) => n.kind === 'store').map((n) => n.name);
const routeNames = (result) =>
  result.atlas.nodes.filter((n) => n.meta.endpointKind === 'http-route').map((n) => n.name);

test('the fixture really does declare all of this', () => {
  // Without this, every assertion below would pass against an empty directory.
  for (const framework of ['Actix Web', 'Diesel', 'ASP.NET Core', 'Cloudflare Workers']) {
    assert.ok(shown.project.frameworks.includes(framework), `expected ${framework} in the unfiltered run`);
  }
  assert.deepEqual(
    shown.project.signals.workers.map((w) => w.configPath),
    ['examples/edge/wrangler.jsonc'],
  );
  assert.equal(shown.project.signals.publishedPorts.length, 1);
  assert.deepEqual(storeNames(shown).sort(), ['SAMPLE_CACHE', 'sample-db', 'sample-uploads']);
});

test('an ignored path names no frameworks', () => {
  for (const framework of ['Actix Web', 'Diesel', 'ASP.NET Core', 'Cloudflare Workers', 'Cloudflare Pages']) {
    assert.ok(
      !hidden.project.frameworks.includes(framework),
      `${framework} was declared only under examples/, which the caller asked to leave out`,
    );
  }
  // The app's own manifest is not a sample and is read as it always was.
  assert.ok(hidden.project.frameworks.includes('Hono'), 'the app itself still describes itself');
});

test('an ignored path opens no doors and keeps no data', () => {
  assert.deepEqual(hidden.project.signals.workers, [], 'a wrangler config under an ignored path is not a deploy');
  assert.deepEqual(hidden.project.signals.publishedPorts, [], 'nor is a Compose file under one a published port');
  assert.deepEqual(storeNames(hidden), [], 'and the stores it binds are nobody’s');

  // The Worker answers `ANY /*`, which is the widest claim this tool makes about a
  // repo; the app's own route is the narrowest. Only the second survives.
  assert.deepEqual(routeNames(hidden), ['GET /health']);
});

test('an ignored path contributes nothing to the manifests either', () => {
  const { signals } = hidden.project;
  assert.deepEqual([...signals.cargoPackages], [], 'no crate under examples/ is a dependency of this app');
  assert.deepEqual([...signals.cargoBinaries], [], 'nor does one of them make this app something you run');
  assert.deepEqual([...signals.dotnetSdks], []);
  assert.deepEqual([...signals.dotnetPackages], []);
});

test('the exported map says none of it either', () => {
  const markdown = renderAtlasMarkdown(new AtlasGraph(hidden.atlas));
  for (const claim of ['Actix Web', 'Diesel', 'ASP.NET Core', 'Cloudflare', 'sample-db', 'sample-uploads']) {
    assert.ok(!markdown.includes(claim), `ATLAS.md still claims ${claim}`);
  }
  assert.ok(!markdown.includes('examples/'), 'and cites no file the reader was told was out of view');
});

test('a reader that opens one known path honours the flag too', async () => {
  // `readSqlSchema` never searches: it looks in `migrations/` and the seven other places
  // migration tools use. Opening a fixed path is not an exemption — the rule is about
  // what the caller took out of view, not about how the reader found it.
  assert.deepEqual(shown.project.signals.sqlSchema?.tables.map((t) => t.name), ['widgets']);

  const noSchema = await analyzeProject(FIXTURE, { cache: 'off', ignore: ['migrations/**'] });
  assert.equal(noSchema.project.signals.sqlSchema, null);
});
