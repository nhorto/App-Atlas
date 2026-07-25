/**
 * Copies the non-TypeScript files the compiled code needs at runtime.
 *
 * `tsc` only emits what it compiles, and `extract.py` is source for a different
 * language — one App Atlas hands to an interpreter rather than running itself. Keeping
 * it as a real .py file rather than a string inside a .ts file means it can be read,
 * linted and run on its own, which for a 300-line parser is worth one build step.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ASSETS = [['src/analyze/py/extract.py', 'dist/node/analyze/py/extract.py']];

for (const [from, to] of ASSETS) {
  const source = path.join(root, from);
  const target = path.join(root, to);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  console.log(`copied ${from} → ${to}`);
}
