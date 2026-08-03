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
  {
    id: 'csharp',
    package: 'tree-sitter-c-sharp',
    version: '0.23.5',
    /** The grammar spells it with an underscore; the file we keep is named for our id. */
    entry: 'tree-sitter-c_sharp.wasm',
    license: 'MIT',
    sha256: '6f69e1cae44e1c32c1eccc170dc5a9778fb94ff716f71113fe1f8c4299aa2f40',
  },
  {
    id: 'rust',
    package: 'tree-sitter-rust',
    version: '0.24.0',
    entry: 'tree-sitter-rust.wasm',
    license: 'MIT',
    sha256: 'f65f354215611fd94ad34134b3427eb3d58cbb745df7b6509ba722184db73d57',
  },
];

/** Where a fetched grammar lands, repo-relative. */
export function grammarFile(id) {
  return `vendor/grammars/tree-sitter-${id}.wasm`;
}
