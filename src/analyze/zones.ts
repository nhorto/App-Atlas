/**
 * @fileoverview Zone classification.
 *
 * Assigns every file one of a handful of coarse architectural roles (UI, API,
 * business logic, data, config, test). Zones give the map its colour language and
 * become real container nodes in the boundary view (M2).
 *
 * These are conventions, not compiler facts, so they stay deliberately simple and
 * predictable: a user should be able to guess why a file was coloured the way it was.
 */
import type { Zone } from '../model/types.js';
import { baseNameOf, extOf } from '../util/paths.js';

const TEST_HINTS = [/(^|\/)__tests__\//, /(^|\/)tests?\//, /\.(test|spec)\.[cm]?[jt]sx?$/];
const CONFIG_NAMES = new Set([
  'next.config.js', 'next.config.mjs', 'next.config.ts',
  'vite.config.ts', 'vite.config.js', 'tailwind.config.ts', 'tailwind.config.js',
  'jest.config.ts', 'jest.config.js', 'vitest.config.ts', 'playwright.config.ts',
  'eslint.config.js', 'eslint.config.mjs', 'postcss.config.js', 'drizzle.config.ts',
  'svelte.config.js', 'astro.config.mjs', 'nuxt.config.ts', 'webpack.config.js',
]);
const DATA_HINTS = [
  /(^|\/)prisma\//, /(^|\/)drizzle\//, /(^|\/)migrations?\//, /(^|\/)db\//,
  /(^|\/)database\//, /(^|\/)models?\//, /(^|\/)entities\//, /(^|\/)repositor(y|ies)\//,
  /(^|\/)schemas?\//, /(^|\/)seed(s)?\//,
];
const API_HINTS = [
  /(^|\/)api\//, /(^|\/)routes?\//, /(^|\/)server\//, /(^|\/)trpc\//,
  /(^|\/)controllers?\//, /(^|\/)handlers?\//, /(^|\/)endpoints?\//,
  /(^|\/)functions\//, /(^|\/)actions\//,
];
const API_FILES = new Set(['route.ts', 'route.js', 'middleware.ts', 'middleware.js', 'server.ts', 'server.js']);
const UI_HINTS = [
  /(^|\/)components?\//, /(^|\/)ui\//, /(^|\/)views?\//, /(^|\/)screens?\//,
  /(^|\/)pages?\//, /(^|\/)layouts?\//, /(^|\/)styles?\//, /(^|\/)app\//,
];
const LOGIC_HINTS = [
  /(^|\/)lib\//, /(^|\/)utils?\//, /(^|\/)services?\//, /(^|\/)hooks?\//,
  /(^|\/)domain\//, /(^|\/)core\//, /(^|\/)helpers?\//, /(^|\/)store\//,
];

/**
 * Classifies a repo-relative file path into a zone. Order matters: the most specific
 * signals (tests, config, data) win over the broadest ones (a file under `app/`).
 */
export function classifyZone(relPath: string): Zone {
  const lower = relPath.toLowerCase();
  const base = baseNameOf(lower);
  const ext = extOf(lower);

  if (TEST_HINTS.some((r) => r.test(lower))) return 'test';
  if (CONFIG_NAMES.has(base) || /\.config\.[cm]?[jt]s$/.test(base)) return 'config';
  if (DATA_HINTS.some((r) => r.test(lower))) return 'data';
  if (API_FILES.has(base) || API_HINTS.some((r) => r.test(lower))) return 'api';
  if (ext === '.tsx' || ext === '.jsx' || ext === '.css' || ext === '.scss') return 'ui';
  if (UI_HINTS.some((r) => r.test(lower))) return 'ui';
  if (LOGIC_HINTS.some((r) => r.test(lower))) return 'logic';
  return 'logic';
}

/** The zone a container should take, given the zones of everything inside it. */
export function dominantZone(zones: Zone[]): Zone {
  if (zones.length === 0) return 'unknown';
  const counts = new Map<Zone, number>();
  for (const z of zones) counts.set(z, (counts.get(z) ?? 0) + 1);
  // Tests and config never define a container's identity unless that is all it holds.
  const ranked = [...counts.entries()].sort((a, b) => {
    const aWeak = a[0] === 'test' || a[0] === 'config' ? 1 : 0;
    const bWeak = b[0] === 'test' || b[0] === 'config' ? 1 : 0;
    if (aWeak !== bWeak) return aWeak - bWeak;
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
  return ranked[0]![0];
}
