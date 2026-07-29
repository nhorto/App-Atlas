/**
 * @fileoverview A script you run, not a server that listens.
 *
 * Reads a file named on the command line, summarises it, writes the result back to
 * disk. No routes, no screens, nothing exported for anyone else to import — which is
 * exactly the shape the archetype classifier has to land on as `pipeline`.
 */
import fs from 'node:fs';
import { summarise } from './summarise.js';

const [, , inputPath, outputPath] = process.argv;

/** Runs the whole job once and returns how many rows it wrote. */
function main() {
  const raw = fs.readFileSync(inputPath, 'utf8');
  const rows = raw.split('\n').filter(Boolean);
  const report = summarise(rows);
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  return rows.length;
}

main();
