/** Keeps a number inside a range, inclusive at both ends. */
export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
