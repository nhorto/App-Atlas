/**
 * @fileoverview Registers a global and exports nothing. Nothing was ever going to
 * import it, so "nothing imports it" says nothing about whether it is still wanted.
 */
declare const globalThis: Record<string, unknown>;
globalThis.__fixtureReady = true;
