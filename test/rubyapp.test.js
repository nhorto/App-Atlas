/**
 * @fileoverview 469 Ruby files App Atlas cannot read deserve a sentence, not silence (#171).
 *
 * huginn — a Rails application, 469 `.rb` files, controllers, MySQL, a scheduler — was
 * mapped as "18 files · 1 way in · 0 data stores", every count true and the whole the
 * most misleading map this tool has produced, because nothing said the application
 * itself was never in view. The product's own principle covers this at file scale
 * (#132: an unreadable file hedges the headline); a whole unreadable language is the
 * same fact at a thousand times the weight.
 *
 * The threshold is dominance — more unread source files than read ones — so a vendored
 * Ruby script inside a TS app never hedges a map that genuinely covers the app. This
 * fixture is 7 `.rb` files against 1 `.js`.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject } from '../dist/node/index.js';
import { authHeadline } from '../dist/node/model/exposure.js';
import { unreadBackbone } from '../dist/node/model/coverage.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { atlas } = await analyzeProject(path.join(here, 'fixtures', 'rubyapp'), {
  followReferences: true,
  cache: 'off',
});

test('the unread language is counted into the stats', () => {
  assert.deepEqual(atlas.meta.stats.unreadLanguages, [{ ext: '.rb', count: 7 }]);
});

test('the archetype says what it cannot read instead of shrugging', () => {
  assert.equal(atlas.meta.archetype.archetype, 'unknown');
  assert.match(atlas.meta.archetype.label, /cannot read/);
  assert.ok(
    atlas.meta.archetype.because.some((line) => /7 Ruby files/.test(line)),
    JSON.stringify(atlas.meta.archetype.because),
  );
});

test('the auth headline owns the blindness instead of implying an answer', () => {
  const line = authHeadline(atlas.meta.stats);
  assert.equal(line.tone, 'warn');
  assert.match(line.headline, /7 Ruby files.*cannot read.*never in view/);
});

test('dominance is the threshold: a sprinkle of Ruby in a real TS app stays quiet', () => {
  assert.equal(unreadBackbone([{ ext: '.rb', count: 3 }], 200), null);
  assert.ok(unreadBackbone([{ ext: '.rb', count: 452 }], 18));
});
