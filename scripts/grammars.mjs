/**
 * The grammars the generic tier can read, and where each one came from.
 *
 * Adding a language starts here: one row, then `npm run grammars`, then a dialect and a
 * query file under `src/analyze/generic/`. That is the whole cost, and it is the reason
 * this tier exists — nobody is writing a fortieth analyzer by hand.
 *
 * The `.wasm` is taken out of the grammar's own npm tarball rather than depending on the
 * package: those packages carry an `install: node-gyp-build` script and native prebuilds
 * for six platforms, none of which we use. An install script that can fall back to
 * compiling C is not something to put between a customer and `npx app-atlas` for the sake
 * of a file we could just keep.
 */
export const GRAMMARS = [
  {
    id: 'go',
    package: 'tree-sitter-go',
    version: '0.25.0',
    /** Path inside the tarball, under its `package/` root. */
    entry: 'tree-sitter-go.wasm',
    license: 'MIT',
    sha256: '9504573f352b20be7f2f1911754d710622aedc15afff16d5ed8fb5645681aee7',
  },
];

/** Where a fetched grammar lands, repo-relative. */
export function grammarFile(id) {
  return `vendor/grammars/tree-sitter-${id}.wasm`;
}
