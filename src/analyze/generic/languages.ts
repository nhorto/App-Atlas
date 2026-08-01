/**
 * @fileoverview Every language the generic tier can read, and what finds its boundaries.
 *
 * One row per language. Adding the next one means a `.scm` query file, a dialect, a row
 * in `scripts/grammars.mjs`, and — only if you want doors rather than just structure — a
 * boundary detector. Nothing else in the codebase changes, which is the point: the merge
 * layer in `boundaries/build.ts` has never known what language a finding came from.
 *
 * Go came first, alone, because a seam is worth proving on one language before it is
 * claimed for forty. C# is the proof: it cost a query file, a dialect and a detector,
 * and nothing outside this directory changed to make room for it.
 */
import type { BoundaryFinding } from '../boundaries/types.js';
import type { ProjectSignals } from '../signals.js';
import type { Dialect } from './dialect.js';
import { goDialect } from './go/dialect.js';
import { detectGoBoundaries } from './go/boundaries.js';
import { csharpDialect } from './csharp/dialect.js';
import { detectCSharpBoundaries } from './csharp/boundaries.js';
import type { GenericFile } from './ir.js';

export interface BoundaryInput {
  file: GenericFile;
  /** Atlas id of the file. */
  fileId: string;
  /**
   * Where a site sits: the definition containing it, or the file when there is none.
   * Always an answer, because every line is somewhere.
   */
  nodeIdForScope(scope: string | null): string;
  /**
   * The node a name refers to, or null when this file does not declare it.
   *
   * Kept apart from `nodeIdForScope` because the file is a fine answer to "where is this
   * line" and a dangerous one to "what answers this door". A handler that falls back to
   * the file inherits every check anywhere in that file — which is how `mux.Handle(
   * "/debug/vars", expvar.Handler())` came to be reported as protected by a middleware it
   * has never been near.
   */
  nodeIdForName(name: string): string | null;
  signals: ProjectSignals;
}

export interface GenericLanguage {
  dialect: Dialect;
  /**
   * Finds this language's doors, guards, stores and outbound calls. Optional: a language
   * can be worth reading for its structure alone, and a missing detector shows up as a
   * repo with files and no boundary rather than as a wrong one.
   */
  boundaries?: (input: BoundaryInput) => BoundaryFinding[];
}

export const LANGUAGES: GenericLanguage[] = [
  { dialect: goDialect, boundaries: detectGoBoundaries },
  { dialect: csharpDialect, boundaries: detectCSharpBoundaries },
];

/** The language that claims a file, by extension, or null when none does. */
export function languageFor(relPath: string): GenericLanguage | null {
  const dot = relPath.lastIndexOf('.');
  if (dot === -1) return null;
  const ext = relPath.slice(dot).toLowerCase();
  for (const language of LANGUAGES) {
    if (!language.dialect.extensions.includes(ext)) continue;
    if (language.dialect.skip?.some((pattern) => pattern.test(relPath))) return null;
    return language;
  }
  return null;
}
