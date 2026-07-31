/** @fileoverview Reached only through `await import(...)` from the home page. */
export function lazyThing(): string {
  return 'loaded on demand';
}
