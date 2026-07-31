/**
 * @fileoverview Code that says it has been retired (issue #87).
 *
 * The claim being defended is narrow on purpose: App Atlas marks a file retired only
 * when its author said so, in a folder name or in a docstring. It never infers it from
 * a file being unimported, small or old — those are facts about a graph, and this is a
 * claim about intent, and getting it wrong writes off code somebody still runs.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isRetired, retirementOf } from '../dist/node/model/retired.js';

const file = (path, summary = null, summarySource = null) => ({
  id: `file:${path}`,
  kind: 'file',
  name: path.split('/').pop(),
  path,
  summary,
  summarySource,
  zone: 'logic',
});

test('a folder the author named as an archive retires what is in it', () => {
  assert.ok(isRetired(file('scripts/categories/_archive/purchasing.py')));
  assert.ok(isRetired(file('scripts/archive/dashboard_queries.py')));
  assert.ok(isRetired(file('parked/station-estimates/pivot.py')));
  assert.ok(isRetired(file('src/deprecated/old_client.ts')));
});

test('the underscore is only there to sort it out of the way', () => {
  assert.equal(retirementOf(file('a/_archive/x.py'))?.because, 'it is under _archive/');
  assert.equal(retirementOf(file('a/archive/x.py'))?.because, 'it is under archive/');
});

test('a docstring that opens by disowning the file is enough on its own', () => {
  const doc = 'DEPRECATED 2026-04-30 — replaced by the API lane. Kept as a backstop.';
  assert.ok(isRetired(file('scripts/categories/purchasing.py', doc, 'docs')));
  assert.equal(retirementOf(file('a/b.py', doc, 'docs'))?.because, 'its own docstring says so');
  assert.ok(isRetired(file('src/client.ts', 'Talks to the API.\n@deprecated use v2', 'docs')));
});

test('a sentence the enricher wrote can never retire a file', () => {
  // The words layer describes code; it does not get to establish facts about it. If a
  // generated summary could mark a file retired, a model's guess would silently remove
  // that file from the reading order and from the architecture paragraph.
  const doc = 'DEPRECATED — this looks like it was replaced.';
  assert.equal(isRetired(file('src/live.ts', doc, 'ai')), false);
});

test('legacy and old are left alone, on purpose', () => {
  // Legacy code is very often the thing actually running in production — that is most of
  // what makes it legacy. Marking it retired would be the confident falsehood this whole
  // feature exists to prevent, so the ambiguous names are deliberately not in the set.
  assert.equal(isRetired(file('src/legacy/billing.ts')), false);
  assert.equal(isRetired(file('src/old/billing.ts')), false);
});

test('a folder node is judged by its own name too', () => {
  // A file's path ends in a file, a folder's ends in a folder. Slicing the last segment
  // off both left a top-level `archive/` with nowhere to be recognised.
  const folder = { id: 'module:archive', kind: 'module', name: 'archive', path: 'archive', zone: 'logic' };
  assert.ok(isRetired(folder), 'the folder itself');
  assert.ok(isRetired({ ...folder, id: 'module:parked/x', name: 'x', path: 'parked/x' }), 'and one inside it');
});

test('a file called archive.py is not an archive', () => {
  // Only path segments above the file count. Otherwise a module that *implements*
  // archiving gets written off as the thing it operates on.
  assert.equal(isRetired(file('src/jobs/archive.py')), false);
  assert.equal(isRetired(file('src/deprecated.ts')), false);
});

test('mentioning deprecation later in a docstring is not disowning the file', () => {
  // "Replaces the deprecated exporter" is a live file describing a dead one. Only the
  // opening of the docstring, or the @deprecated tag, is the author speaking about this.
  const doc = 'Builds the nightly export. Replaces the deprecated CSV exporter.';
  assert.equal(isRetired(file('src/export.ts', doc, 'docs')), false);
});
