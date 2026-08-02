/**
 * SUPERSEDED by pipeline.mjs. Left here so the old import path keeps resolving.
 */
import { loadJobs } from './jobs.mjs';

export function oldPipeline() {
  return loadJobs();
}
