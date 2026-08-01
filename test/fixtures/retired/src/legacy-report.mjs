/**
 * @fileoverview Builds the old quarterly sheet.
 * @deprecated Use `report.mjs`. Kept because finance still runs it by hand in April.
 */
import { loadJobs } from './jobs.mjs';

export function quarterlySheet() {
  return loadJobs();
}
