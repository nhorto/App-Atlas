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

/**
 * One file's whole contribution to the atlas, kept between runs so an unedited file is
 * never parsed twice. Every edge in here starts inside the file it belongs to, which is
 * what lets slices be restored in any order (see `cache.ts`).
 */
export interface FileSlice {
  relPath: string;
  /** Hash of the file's text — the cache key, and why `positions` can be trusted. */
  hash: string;
  nodes: AtlasNode[];
  edges: AtlasEdge[];
  boundaries: BoundaryFinding[];
  /** Character offset of each declaration → the atlas node id it became. */
  positions: [number, string][];
  /** Repo-relative paths this file imports. */
  imports: string[];
}

export interface PluginContext {
  project: ProjectInfo;
  /** Only the files this plugin claimed. */
  files: SourceFileRef[];
  options: PluginOptions;
  /**
   * Slices from the last run for files that have not changed since. A plugin that
   * ignores this still produces a correct atlas — just a slower one.
   */
  reuse?: ReadonlyMap<string, FileSlice>;
  /** Text hash of every claimed file, already computed by the cache. */
  hashes?: ReadonlyMap<string, string>;
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
  /** Slices for the files this run actually read, for the cache to keep. */
  slices?: FileSlice[];
  /** How many files were restored rather than parsed. Reported to the user. */
  reused?: number;
}

export interface LanguagePlugin {
  id: string;
  displayName: string;
  /** Which of the discovered files this plugin handles. */
  claims(file: SourceFileRef): boolean;
  analyze(ctx: PluginContext): Promise<PluginResult> | PluginResult;
}
