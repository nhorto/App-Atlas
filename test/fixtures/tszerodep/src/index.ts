// A real zero-dependency library: its main exists, so its exports are a commitment.
export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
