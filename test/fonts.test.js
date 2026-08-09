/**
 * @fileoverview A font ships with its license or it does not ship (#138).
 *
 * #109 vendored Literata so the atlas looks the same offline as on, and committed
 * `OFL.txt` beside the two woff2 files. That put the license in the repository and
 * nowhere else. Vite emits what something imports; `styles.css` imports the two
 * binaries, and nobody imports a license, so `dist/web` held the font and not its
 * terms — and `package.json#files` ships `dist`, so the repo copy never travelled
 * either. `npm pack` would have redistributed the font bare.
 *
 * SIL OFL 1.1 §2 asks for the opposite: each copy of the font software carries the
 * copyright notice and the license. The suite was green through all of it, because
 * every other test reads the analyzer and none of them read the package.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = path.join(root, 'dist', 'web');

const built = readdirSync(path.join(web, 'assets'));
const fonts = built.filter((f) => f.endsWith('.woff2'));

test('the build still emits the font the stylesheet asks for', () => {
  // If this drops to zero the rest of the file passes vacuously, which is the one
  // way a licensing test quietly stops being one.
  assert.ok(fonts.length > 0, `no woff2 in dist/web/assets: ${built.join(', ')}`);
});

test('a shipped font is shipped with its license', () => {
  const license = readFileSync(path.join(web, 'OFL.txt'), 'utf8');
  assert.match(license, /SIL OPEN FONT LICENSE/i);
  assert.match(license, /Literata/i);
});

test('the license travels in the tarball, not just the checkout', () => {
  // `files` ships dist wholesale, so the check is that the license lands *inside*
  // dist rather than only at web/src/fonts, where npm pack cannot see it.
  assert.ok(
    readdirSync(web).includes('OFL.txt'),
    `dist/web holds ${readdirSync(web).join(', ')} — the license is not among them`,
  );
});
