/**
 * @fileoverview The language plugin interface.
 *
 * A language plugin takes discovered source files and emits atlas nodes and edges.
 * That is the whole contract — the model is language-agnostic, so plugins may differ
 * wildly in depth (TypeScript uses a real type checker; Python will start shallower)
 * without the rest of the system knowing. See SPEC.md section 5.7.
 */
import type { AtlasEdge, AtlasNode } from '../model/types.js';
import type { BoundaryFinding } from './boundaries/types.js';
import type { ProjectInfo, SourceFileRef } from './project.js';

export interface PluginContext {
  project: ProjectInfo;
  /** Only the files this plugin claimed. */
  files: SourceFileRef[];
  options: PluginOptions;
  onProgress?: (stage: string, done: number, total: number) => void;
}

export interface PluginOptions {
  /** Run the symbol-reference pass. Off makes very large repos much faster. */
  followReferences: boolean;
  /** Run the boundary detectors. */
  detectBoundaries: boolean;
}

export interface PluginResult {
  nodes: AtlasNode[];
  edges: AtlasEdge[];
  /**
   * Raw boundary observations. They stay unmerged here on purpose: turning forty
   * Stripe call sites into one Stripe box needs the whole project, not one file, and
   * that merge happens once for every language at the end.
   */
  boundaries: BoundaryFinding[];
  warnings: string[];
  timings: Record<string, number>;
}

export interface LanguagePlugin {
  id: string;
  displayName: string;
  /** Which of the discovered files this plugin handles. */
  claims(file: SourceFileRef): boolean;
  analyze(ctx: PluginContext): Promise<PluginResult> | PluginResult;
}
