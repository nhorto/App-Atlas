/**
 * @fileoverview Pulls the estimates together. Replaced the deprecated purchasing
 * exporter that used to live under `_archive`, and is itself very much current.
 */
import { loadJobs } from './jobs.mjs';

export function runPipeline() {
  return loadJobs().map((job) => ({ ...job, priced: true }));
}
