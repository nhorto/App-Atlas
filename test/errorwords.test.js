/**
 * @fileoverview The guard on the one generated paragraph in the error feature.
 *
 * The design rule is that the path is computed and only the story is written, and the
 * point of that rule is entirely practical: a model that names a plausible file which
 * had nothing to do with the crash sends somebody who is already stuck to read it. The
 * prompt asks for that. This is the part that enforces it, so the rule survives a model
 * that forgets.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { dropUngroundedFiles } from '../dist/node/enrich/validate.js';

const ON_THE_PATH = ['lib/cellar.js', 'app/cellar/add.js'];

test('a sentence about a file on the path is kept', () => {
  const { text, wrong } = dropUngroundedFiles(
    'The bottle is added in lib/cellar.js, which is where the missing id would surface.',
    ON_THE_PATH,
  );
  assert.equal(wrong.length, 0);
  assert.match(text, /lib\/cellar\.js/);
});

test('a file nobody put on the path takes its sentence with it', () => {
  const { text, wrong } = dropUngroundedFiles(
    'The bottle is added in lib/cellar.js. You should also check lib/auth.js for the session.',
    ON_THE_PATH,
  );
  assert.deepEqual(wrong, ['lib/auth.js']);
  assert.match(text, /lib\/cellar\.js/);
  assert.doesNotMatch(text, /auth\.js/, 'the invented file is gone, not merely flagged');
});

test('the bare name of a file on the path counts as the file', () => {
  // Models write "cellar.js" as often as the full path, and it is the same claim.
  const { wrong } = dropUngroundedFiles('cellar.js writes the row.', ON_THE_PATH);
  assert.deepEqual(wrong, []);
});

test('an answer that is entirely about files it invented is dropped whole', () => {
  const { text, wrong } = dropUngroundedFiles('Look at src/made/up.ts and then at other/thing.py.', ON_THE_PATH);
  assert.equal(text, null, 'nothing is left worth showing');
  assert.ok(wrong.length >= 2);
});

test('prose that names no file at all is left exactly as written', () => {
  const written = 'The value is undefined by the time it is read, so whatever produced it returned nothing.';
  const { text, wrong } = dropUngroundedFiles(written, ON_THE_PATH);
  assert.equal(text, written);
  assert.deepEqual(wrong, []);
});

test('a word that merely ends in a language name is not mistaken for a file', () => {
  // "in Go", "written in Rust" — no extension, no claim about a file.
  const written = 'This is the sort of thing that happens in Go when a pointer is nil.';
  const { text, wrong } = dropUngroundedFiles(written, ON_THE_PATH);
  assert.equal(text, written);
  assert.deepEqual(wrong, []);
});

test('with nothing allowed, every named file is ungrounded', () => {
  // The empty case must fail closed. Failing open here would mean an error trace that
  // placed no frames still let a model name whatever it liked.
  const { text, wrong } = dropUngroundedFiles('Check lib/cellar.js.', []);
  assert.equal(text, null);
  assert.deepEqual(wrong, ['lib/cellar.js']);
});
