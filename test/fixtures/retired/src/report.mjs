/** @fileoverview Formats the summary the dashboard prints. */
import { loadJobs } from './jobs.mjs';

export function summarise(rows) {
  return { rows: rows.length, jobs: loadJobs().length };
}
