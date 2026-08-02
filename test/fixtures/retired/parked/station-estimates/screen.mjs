/**
 * @fileoverview The station-estimates screen, as it was before the rewrite.
 *
 * No deprecation notice anywhere in this file — the folder is the whole of the
 * evidence, and it is enough.
 */
import { loadJobs } from '../../src/jobs.mjs';

export function stationScreen() {
  return loadJobs();
}
