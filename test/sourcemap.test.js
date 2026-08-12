/**
 * @fileoverview Reading a source map, which is the one thing here nobody can eyeball.
 *
 * A mapping decoded slightly wrong does not look wrong. It produces a real file and a
 * plausible line, and the error trace then hands somebody a location with total
 * confidence and no relation to the crash — the exact failure the rest of this feature
 * is built to avoid. So the decoder is pinned against mappings worked out by hand from
 * the spec rather than against anything this repo also wrote, and every case where a map
 * cannot answer is pinned to return nothing rather than the nearest thing.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bundleMaps, decodeVlq, looksBuilt, parseSourceMap } from '../dist/node/index.js';

// Worked out from the Base64 VLQ rules by hand: six bits per character, the low bit of
// the assembled value is the sign, the 32s bit says another character follows.
//   400 → 800 unsigned → 0b11001_00000 → digits 0 (with continuation) then 25 → "gZ"
//     8 →  16 unsigned → "Q"        ·  2 → 4 unsigned → "E"        ·  0 → "A"
const AT_COLUMN_400 = 'gZAQEA';

function tempRoot(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-map-'));
  for (const [name, body] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof body === 'string' ? body : JSON.stringify(body));
  }
  return root;
}

function mapFile(mappings, sources, names = []) {
  return { version: 3, file: 'app.bundle', sources, names, mappings };
}

// ---------------------------------------------------------------------------
// The numbers
// ---------------------------------------------------------------------------

test('single characters decode to the values the spec gives them', () => {
  assert.deepEqual(decodeVlq('A'), [0]);
  assert.deepEqual(decodeVlq('C'), [1]);
  assert.deepEqual(decodeVlq('D'), [-1]);
  assert.deepEqual(decodeVlq('E'), [2]);
  assert.deepEqual(decodeVlq('F'), [-2]);
});

test('a continued value is assembled low group first', () => {
  assert.deepEqual(decodeVlq('gB'), [16], 'continuation digit 0, then 1 << 5, halved');
  assert.deepEqual(decodeVlq('gZ'), [400]);
  assert.deepEqual(decodeVlq(AT_COLUMN_400), [400, 0, 8, 2, 0]);
});

test('a column past what a 32-bit shift would survive still decodes', () => {
  // One minified line of a real app is megabytes wide. Assembling these with `<<`
  // silently wraps, and a wrapped column lands on a segment that is not the one.
  const wide = decodeVlq('ggggggC');
  assert.equal(wide.length, 1);
  // Six empty groups then a payload of 2: 2 * 32^6, which is 2^31 before the sign bit
  // comes off it — one past what a signed 32-bit shift can hold.
  assert.equal(wide[0], 1073741824);
});

test('text that is not a segment is refused rather than half-read', () => {
  assert.equal(decodeVlq('A$'), null, 'not a base64 digit');
  assert.equal(decodeVlq('g'), null, 'ends mid-number, with the continuation bit still set');
});

// ---------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------

test('a generated position comes back as the line somebody wrote', () => {
  const map = parseSourceMap(JSON.stringify(mapFile(AT_COLUMN_400, ['src/app.ts'], ['save'])));
  const at = map.originalFor(0, 400);
  assert.equal(at.source, 'src/app.ts');
  assert.equal(at.line, 9, 'source maps count lines from 0 and everything else counts from 1');
  assert.equal(at.column, 2);
  assert.equal(at.name, 'save');
});

test('a column inside a segment belongs to the segment it started in', () => {
  const map = parseSourceMap(JSON.stringify(mapFile(`AAAA,${AT_COLUMN_400}`, ['src/app.ts'])));
  assert.equal(map.originalFor(0, 399).line, 1, 'still in the first segment');
  assert.equal(map.originalFor(0, 400).line, 9);
  assert.equal(map.originalFor(0, 5000).line, 9, 'the last segment runs to the end of the line');
});

test('a position before the first segment is nothing, not the first segment', () => {
  const map = parseSourceMap(JSON.stringify(mapFile(AT_COLUMN_400, ['src/app.ts'])));
  assert.equal(map.originalFor(0, 12), null);
  assert.equal(map.originalFor(4, 400), null, 'a generated line the map does not cover');
});

test('generated code that came from nothing says nothing', () => {
  // A one-field segment is a bundler’s own runtime helper. Attaching it to whichever
  // source is nearby would be inventing a location for code nobody wrote.
  const map = parseSourceMap(JSON.stringify(mapFile('AAAA,gZ', ['src/app.ts'])));
  assert.equal(map.originalFor(0, 400), null);
  assert.equal(map.originalFor(0, 0).source, 'src/app.ts', 'the mapped segment beside it is unaffected');
});

test('every field but the generated column carries over from the segment before', () => {
  // The deltas persist across the `;` that ends a generated line, so a line cannot be
  // read on its own. "CACA" on line two is +1 column, +0 source, +1 line, +0 column.
  const map = parseSourceMap(JSON.stringify(mapFile(`${AT_COLUMN_400};CACA`, ['src/app.ts'], ['save'])));
  const second = map.originalFor(1, 1);
  assert.equal(second.line, 10, 'one line on from where the first segment left off');
  assert.equal(second.column, 2);
});

test('a relative source is resolved against the map, not the repo root', () => {
  // tsc, esbuild and Vite all write `../src/app.ts`, and resolving it is the difference
  // between a repo-relative path and one that matches nothing.
  const map = parseSourceMap(JSON.stringify(mapFile(AT_COLUMN_400, ['../src/app.ts'])), 'dist/app.js.map');
  assert.equal(map.originalFor(0, 400).source, 'src/app.ts');
});

test('a source with a scheme on it is left exactly as written', () => {
  // `webpack:///./src/app.ts` needs a prefix stripped, not a directory prepended.
  const map = parseSourceMap(
    JSON.stringify(mapFile(AT_COLUMN_400, ['webpack:///./src/app.ts'])),
    '.next/static/chunks/main.js.map',
  );
  assert.equal(map.originalFor(0, 400).source, 'webpack:///./src/app.ts');
});

test('a sourceRoot is joined on before anything else', () => {
  const raw = { ...mapFile(AT_COLUMN_400, ['app.ts']), sourceRoot: 'src/' };
  const map = parseSourceMap(JSON.stringify(raw));
  assert.equal(map.originalFor(0, 400).source, 'src/app.ts');
});

test('an index map hands the question to the section that covers it', () => {
  const raw = {
    version: 3,
    sections: [
      { offset: { line: 0, column: 0 }, map: mapFile('AAAA', ['src/first.ts']) },
      { offset: { line: 4, column: 0 }, map: mapFile('AAAA', ['src/second.ts']) },
    ],
  };
  const map = parseSourceMap(JSON.stringify(raw));
  assert.equal(map.originalFor(0, 0).source, 'src/first.ts');
  assert.equal(map.originalFor(4, 0).source, 'src/second.ts', 'the offset is subtracted before the lookup');
});

test('text that is not a source map is null, not a throw', () => {
  assert.equal(parseSourceMap('not json at all'), null);
  assert.equal(parseSourceMap('{"version":3}'), null, 'no mappings and no sections');
});

// ---------------------------------------------------------------------------
// Finding it on disk
// ---------------------------------------------------------------------------

test('the map beside the bundle is the one that answers', () => {
  const root = tempRoot({
    'dist/app.bundle.map': mapFile(AT_COLUMN_400, ['../src/app.ts'], ['save']),
  });
  const at = bundleMaps(root).lookup('/var/task/dist/app.bundle', 1, 401);
  assert.ok(at, 'the frame’s own directory prefix is from another machine and does not matter');
  assert.equal(at.source, 'src/app.ts');
  assert.equal(at.line, 9);
  assert.equal(at.mapPath, 'dist/app.bundle.map');
});

test('a map inside a directory git ignores is still found', () => {
  // Every map worth having lives somewhere a repo ignores. Honouring `.gitignore` here
  // would mean finding none of them.
  const root = tempRoot({
    '.gitignore': '.next\n',
    '.next/static/chunks/main.js.map': mapFile(AT_COLUMN_400, ['../../../src/app.ts']),
  });
  const at = bundleMaps(root).lookup('/_next/static/chunks/main.js', 1, 401);
  assert.ok(at);
  assert.equal(at.source, 'src/app.ts');
});

test('two maps that could both be it are only used if they agree', () => {
  const root = tempRoot({
    'a/chunk.js.map': mapFile(AT_COLUMN_400, ['../src/one.ts']),
    'b/chunk.js.map': mapFile(AT_COLUMN_400, ['../src/two.ts']),
  });
  assert.equal(bundleMaps(root).lookup('chunk.js', 1, 401), null, 'picking one would be a coin flip');

  const same = tempRoot({
    'a/chunk.js.map': mapFile(AT_COLUMN_400, ['../src/one.ts']),
    'b/chunk.js.map': mapFile(AT_COLUMN_400, ['../src/one.ts']),
  });
  assert.equal(bundleMaps(same).lookup('chunk.js', 1, 401).source, 'src/one.ts', 'no disagreement to resolve');
});

test('the map whose path agrees with more of the frame wins outright', () => {
  const root = tempRoot({
    'build/ios/main.jsbundle.map': mapFile(AT_COLUMN_400, ['../../src/ios.ts']),
    'build/android/main.jsbundle.map': mapFile(AT_COLUMN_400, ['../../src/android.ts']),
  });
  const at = bundleMaps(root).lookup('/data/app/build/android/main.jsbundle', 1, 401);
  assert.equal(at.source, 'src/android.ts', 'a shared directory is evidence, and beats the tie');
});

test('no map at all is null rather than a guess', () => {
  const root = tempRoot({ 'dist/app.bundle': 'var a=1' });
  assert.equal(bundleMaps(root).lookup('dist/app.bundle', 1, 401), null);
});

test('a map that does not cover the position is null too', () => {
  const root = tempRoot({ 'dist/app.bundle.map': mapFile(AT_COLUMN_400, ['../src/app.ts']) });
  assert.equal(bundleMaps(root).lookup('dist/app.bundle', 1, 12), null, 'before the first segment');
});

// ---------------------------------------------------------------------------
// Knowing when to look
// ---------------------------------------------------------------------------

test('build output is recognised by where it is, what it is called, or how it reads', () => {
  assert.ok(looksBuilt('dist/app.js', 40, 12), 'a build directory');
  assert.ok(looksBuilt('/srv/app/.next/static/chunks/main.js', 40, 12));
  assert.ok(looksBuilt('index.android.bundle', 40, 12), 'a bundler’s name for its output');
  assert.ok(looksBuilt('vendor.min.js', 40, 12));
  assert.ok(looksBuilt('assets/index-D35dqtPP.js', 40, 12), 'the hash Vite and Rollup put in a filename');
  assert.ok(looksBuilt('app.js', 1, 483920), 'nothing anybody typed has a column in the hundreds of thousands');
  // A real Vite bundle breaks every few thousand characters, so the wide column that
  // gives it away turns up deep in the file rather than on line one.
  assert.ok(looksBuilt('https://example.com/static/app.js', 41, 10397));
});

test('a file somebody wrote is not mistaken for build output', () => {
  assert.equal(looksBuilt('src/lib/email.ts', 9, 3), false);
  assert.equal(looksBuilt('app/routes/users.ts', 240, 88), false, 'a deep line is normal; a wide column is not');
  assert.equal(looksBuilt('src/distance.ts', 4, 2), false, 'a name that merely starts with dist');
  assert.equal(looksBuilt('src/components/UserProfileSettingsPanel.tsx', 12, 4), false, 'a long name is not a hash');
});
