/**
 * @fileoverview Asking about several things in one call (`targets`, `queries`).
 *
 * An agent about to change five files has one question, not five. Before this it paid
 * five round trips for it, because the tools were shaped around one entity each — which
 * is a shape that reads naturally and bills badly.
 *
 * Two things have to hold for that to be worth doing, and they pull against each other.
 * The batch has to stay *legible*: several answers run together with nothing to say where
 * one ends are worse than no batching at all, because an agent reading the second answer
 * as though it were about the first will act on it. And the single-target call — still
 * the common one — has to come back byte-for-byte as it did before, so nobody pays for a
 * feature they did not ask for.
 *
 * The rest of this file is about the cases a batch has that a single call does not: one
 * target failing while its neighbours succeed, the same name asked for twice, and more
 * targets than the ceiling allows — where the rule is the one this whole surface follows,
 * that a list which was trimmed must say so rather than read like a complete answer.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeProject, AtlasSource, callMcpTool, persistAtlas } from '../dist/node/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'app-atlas-batch-'));

test.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

/** Analyzes a fixture and persists it somewhere disposable, never into the fixture. */
async function analysed(fixture) {
  const dir = path.join(workspace, fixture);
  fs.mkdirSync(dir, { recursive: true });
  const { atlas } = await analyzeProject(path.join(here, 'fixtures', fixture), {
    followReferences: true,
    cache: 'off',
  });
  persistAtlas(dir, atlas);
  return dir;
}

const exposure = await analysed('exposure');
const call = (name, args) => callMcpTool(new AtlasSource(exposure), name, args);
const textOf = (result) => result.content.map((block) => block.text).join('\n');

// Names this fixture actually contains, checked by the first test rather than assumed:
// one that resolves to a single node, one that several nodes share, one that is absent.
const ONE = 'recordVisit';
const MANY = 'POST';
const NONE = 'nothingIsCalledThis';

test('the fixture holds the three shapes the rest of this file needs', () => {
  assert.equal(call('what_calls', { target: ONE }).structuredContent.resolved?.name, ONE);
  assert.equal(call('what_calls', { target: MANY }).structuredContent.resolved, null);
  assert.ok(call('what_calls', { target: MANY }).structuredContent.candidates.length > 1);
  assert.deepEqual(call('what_calls', { target: NONE }).structuredContent.candidates, []);
});

// ---------------------------------------------------------------------------
// The single call, unchanged
// ---------------------------------------------------------------------------

test('one target answers exactly as it did before batching existed', () => {
  const result = call('what_calls', { target: ONE });
  const text = textOf(result);

  // No heading, no separator: the shape an agent already learned.
  assert.ok(!text.includes(`### ${ONE}`), `single answers carry no heading, got:\n${text}`);
  assert.match(text, new RegExp(`function ${ONE}`));
  // The keys this tool has always answered with are still at the top level.
  assert.equal(result.structuredContent.resolved.name, ONE);
  assert.equal(typeof result.structuredContent.total, 'number');
  assert.ok(Array.isArray(result.structuredContent.callers));
});

test('…and the same answer arrives through the list spelling', () => {
  const single = call('what_calls', { target: ONE });
  const listed = call('what_calls', { targets: [ONE] });
  assert.equal(textOf(listed), textOf(single));
  assert.deepEqual(listed.structuredContent, single.structuredContent);
});

test('…and one query answers as before too', () => {
  const result = call('where_is', { query: ONE });
  assert.ok(!textOf(result).includes(`### ${ONE}`));
  assert.ok(result.structuredContent.matches.length > 0);
  assert.deepEqual(textOf(call('where_is', { queries: [ONE] })), textOf(result));
});

// ---------------------------------------------------------------------------
// Several at once
// ---------------------------------------------------------------------------

test('several targets each get their own labelled section', () => {
  const text = textOf(call('what_calls', { targets: [ONE, 'AdminPage', 'HomePage'] }));
  for (const name of [ONE, 'AdminPage', 'HomePage']) {
    assert.ok(text.includes(`### ${name}`), `${name} should head its own section in:\n${text}`);
  }
  // Order is the caller's, so a reader can line answers up against what it asked.
  assert.ok(text.indexOf(`### ${ONE}`) < text.indexOf('### AdminPage'));
  assert.ok(text.indexOf('### AdminPage') < text.indexOf('### HomePage'));
});

test('every answer is keyed by the target it belongs to', () => {
  const asked = [ONE, 'AdminPage', 'HomePage'];
  const { results } = call('what_calls', { targets: asked }).structuredContent;

  assert.equal(results.length, asked.length);
  assert.deepEqual(results.map((row) => row.target), asked);
  // The label is what makes a batch usable: without it a reader has to guess which
  // answer is which, and guessing wrong means acting on the wrong file's callers.
  for (const row of results) assert.equal(row.resolved?.name ?? row.target, row.target);
});

test('results is present on a single answer too, so there is one shape to handle', () => {
  const { results } = call('what_calls', { target: ONE }).structuredContent;
  assert.equal(results.length, 1);
  assert.equal(results[0].target, ONE);
});

test('a batch of queries answers each one separately', () => {
  const result = call('where_is', { queries: [ONE, 'AdminPage'] });
  const { results } = result.structuredContent;

  assert.deepEqual(results.map((row) => row.target), [ONE, 'AdminPage']);
  assert.ok(results.every((row) => Array.isArray(row.matches)));
  assert.match(textOf(result), /### AdminPage/);
});

// ---------------------------------------------------------------------------
// One target failing does not take its neighbours with it
// ---------------------------------------------------------------------------

test('a name that matches nothing, a name that matches many, and a name that resolves — in one call', () => {
  const result = call('what_calls', { targets: [ONE, MANY, NONE] });
  const { results } = result.structuredContent;
  const [resolved, ambiguous, missing] = results;

  assert.equal(resolved.resolved.name, ONE, 'the good one still answers');
  assert.equal(ambiguous.resolved, null, 'the ambiguous one still declines to pick');
  assert.ok(ambiguous.candidates.length > 1, 'and still hands back the candidates');
  assert.equal(missing.resolved, null);
  assert.deepEqual(missing.candidates, [], 'and the absent one is absent, not an error');

  // Nothing here is a failure of the *call*: the tool looked, and three of three
  // questions got the answer they deserved.
  assert.notEqual(result.isError, true);
  assert.match(textOf(result), /will not pick one for you/);
});

// ---------------------------------------------------------------------------
// The edges of the list itself
// ---------------------------------------------------------------------------

test('the same name twice is one question', () => {
  const { results } = call('what_calls', { targets: [ONE, ONE, 'AdminPage', ONE] }).structuredContent;
  assert.deepEqual(results.map((row) => row.target), [ONE, 'AdminPage']);
});

test('both spellings in one call answers about everything named, rather than ignoring half', () => {
  const { results } = call('what_calls', { targets: [ONE], target: 'AdminPage' }).structuredContent;
  assert.deepEqual(results.map((row) => row.target), [ONE, 'AdminPage']);
});

test('blank and non-string entries are dropped without taking the call down', () => {
  const { results } = call('what_calls', { targets: [ONE, '', '   ', null, 42, 'AdminPage'] }).structuredContent;
  assert.deepEqual(results.map((row) => row.target), [ONE, 'AdminPage']);
});

test('asking about nothing at all is refused, and says how to ask', () => {
  for (const args of [{}, { targets: [] }, { target: '  ' }]) {
    const result = call('what_calls', args);
    assert.equal(result.isError, true, `${JSON.stringify(args)} should be refused`);
    assert.match(textOf(result), /target/);
  }
  assert.equal(call('where_is', {}).isError, true);
});

test('more targets than the ceiling are dropped, counted, and said out loud', () => {
  // The failure this guards is silence. A trimmed list that reads like a complete one is
  // how an agent concludes that the twenty-first file has no callers.
  const many = Array.from({ length: 25 }, (_, i) => `name${i}`);
  const result = call('what_calls', { targets: many });
  const { results, droppedTargets } = result.structuredContent;

  assert.equal(results.length, 20);
  assert.equal(droppedTargets, 5);
  assert.match(textOf(result), /5 more were not looked at/);
  assert.notEqual(result.isError, true, 'a capped answer is still an answer');
});

test('a call inside the ceiling says nothing about dropping anything', () => {
  const result = call('what_calls', { targets: [ONE, 'AdminPage'] });
  assert.ok(!('droppedTargets' in result.structuredContent));
  assert.ok(!/not looked at/.test(textOf(result)));
});

test('limit is per target, so a batch is not quietly rationed', () => {
  const [first, second] = call('where_is', { queries: ['Page', 'route'], limit: 3 }).structuredContent.results;
  assert.ok(first.matches.length <= 3);
  assert.ok(second.matches.length <= 3);
  // Both got their own allowance. A shared budget would make the second query's answer
  // depend on how popular the first one was.
  assert.ok(first.matches.length + second.matches.length > 3, 'a shared budget would cap the pair at 3');
});

test('every answer in a batch still carries provenance once, not once per target', () => {
  const text = textOf(call('what_calls', { targets: [ONE, 'AdminPage', 'HomePage'] }));
  assert.equal(text.match(/Source: the atlas of/g).length, 1);
});
