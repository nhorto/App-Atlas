/**
 * @fileoverview The dashboard's entry point. This is the live lane.
 */
import { runPipeline } from './pipeline.mjs';
import { summarise } from './report.mjs';

export function main() {
  return summarise(runPipeline());
}
