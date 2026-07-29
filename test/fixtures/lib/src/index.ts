/**
 * @fileoverview A library and nothing else: no routes, no CLI, no scheduler.
 *
 * The archetype classifier has to land on `library` here, which it can only do by
 * noticing that things are exported and no door of any kind was found.
 */
export { Duration, format } from './duration.js';
export { clamp } from './math.js';
