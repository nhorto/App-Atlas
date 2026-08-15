/**
 * @fileoverview What a tree-sitter parse is flattened into.
 *
 * Deliberately the same shape as `py/types.ts`: a list of definitions, a list of imports,
 * a list of calls with their arguments, and the local names bound to calls. That shape is
 * already known to be enough to find doors, guards, stores and outbound traffic, because
 * the Python detectors find all four from nothing else.
 *
 * Nothing here is language-specific and nothing here is interpreted. Every field is what
 * the source literally said, so a detector reading it cannot accidentally depend on Go.
 */
export {};
//# sourceMappingURL=ir.js.map