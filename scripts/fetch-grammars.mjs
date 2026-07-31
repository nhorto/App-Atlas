/**
 * Fetches the tree-sitter grammars listed in `grammars.mjs` and checks them against the
 * hashes recorded there.
 *
 * The `.wasm` files are committed, so nobody needs to run this to build or use App
 * Atlas — it is offline and deterministic without it. This script exists so that the
 * bytes in `vendor/grammars` can always be shown to be the bytes a named version of a
 * named package published, and so that bumping a grammar is one command rather than a
 * binary someone pasted in.
 *
 *   node scripts/fetch-grammars.mjs           verify what is committed
 *   node scripts/fetch-grammars.mjs --write   fetch and write, failing on a hash mismatch
 *   node scripts/fetch-grammars.mjs --update  fetch, write, and record the new hashes
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { GRAMMARS, grammarFile } from './grammars.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const write = process.argv.includes('--write') || process.argv.includes('--update');
const update = process.argv.includes('--update');

let failures = 0;

for (const grammar of GRAMMARS) {
  const target = path.join(root, grammarFile(grammar.id));

  if (!write) {
    if (!fs.existsSync(target)) {
      console.error(`✗ ${grammar.id}: ${grammarFile(grammar.id)} is missing — run with --write`);
      failures++;
      continue;
    }
    const actual = sha256(fs.readFileSync(target));
    if (actual === grammar.sha256) console.log(`✓ ${grammar.id}: matches ${grammar.package}@${grammar.version}`);
    else {
      console.error(`✗ ${grammar.id}: committed file hashes ${actual}, expected ${grammar.sha256}`);
      failures++;
    }
    continue;
  }

  const url = `https://registry.npmjs.org/${grammar.package}/-/${basename(grammar.package)}-${grammar.version}.tgz`;
  console.log(`… ${grammar.id}: fetching ${url}`);
  const tarball = Buffer.from(await (await fetchOrDie(url)).arrayBuffer());
  const bytes = extract(zlib.gunzipSync(tarball), `package/${grammar.entry}`);
  if (!bytes) {
    console.error(`✗ ${grammar.id}: ${grammar.entry} is not in that tarball`);
    failures++;
    continue;
  }

  const actual = sha256(bytes);
  if (!update && actual !== grammar.sha256) {
    console.error(`✗ ${grammar.id}: published file hashes ${actual}, expected ${grammar.sha256}`);
    failures++;
    continue;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  console.log(`✓ ${grammar.id}: wrote ${grammarFile(grammar.id)} (${(bytes.length / 1024).toFixed(0)} KB, ${actual})`);

  // Redistributing somebody's compiled grammar means redistributing their licence with
  // it. Taken from the same tarball as the bytes, so the two can never drift apart.
  const licence = extract(zlib.gunzipSync(tarball), 'package/LICENSE');
  if (licence) fs.writeFileSync(path.join(root, `vendor/grammars/tree-sitter-${grammar.id}.LICENSE`), licence);
  else console.warn(`  ! ${grammar.id}: no LICENSE in the tarball — check ${grammar.package} before shipping this`);

  if (update && actual !== grammar.sha256) {
    console.log(`  ↳ record this in scripts/grammars.mjs: sha256: '${actual}'`);
  }
}

if (failures > 0) process.exit(1);

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** `@scope/name` publishes its tarball as `name-version.tgz`. */
function basename(pkg) {
  return pkg.startsWith('@') ? pkg.slice(pkg.indexOf('/') + 1) : pkg;
}

async function fetchOrDie(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response;
}

/**
 * Pulls one file out of an uncompressed tar. A 40-line reader rather than a dependency:
 * npm tarballs are plain ustar, and this script's whole job is to be something you can
 * read end to end before trusting the bytes it writes.
 */
function extract(tar, wanted) {
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const name = tar.toString('utf8', offset, offset + 100).replace(/\0.*$/, '');
    if (!name) break;
    const size = parseInt(tar.toString('utf8', offset + 124, offset + 136).replace(/\0.*$/, '').trim(), 8) || 0;
    const start = offset + 512;
    if (name === wanted) return tar.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
  }
  return null;
}
