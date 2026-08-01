/**
 * DEPRECATED 2026-04-30 — replaced by Modules/PurchasingModule.cs.
 * Kept as a backstop. Do not run as part of the pipeline.
 */
import { loadJobs } from '../jobs.mjs';

export function exportPurchasing() {
  return loadJobs();
}
