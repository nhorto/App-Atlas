/**
 * Test helpers. Exported, and still not part of anybody's public API — nobody's
 * semver depends on `randomSeconds`.
 */
export function randomSeconds(): number {
  return Math.floor(Math.random() * 1000);
}

export interface Recorded {
  input: number;
  output: string;
}
