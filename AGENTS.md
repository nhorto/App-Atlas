# Working on App Atlas

Read [ATLAS.md](ATLAS.md) before changing code. It is the map of this app — every way
in, where data goes, the folder map and the key types — regenerated with
`node dist/node/cli.js export .` after a build.

`SPEC.md` is the source of truth for what this product is; section 13 is the build log.
Split work into several focused commits along real seams rather than one large one.

<!-- app-atlas:conventions -->
## Documentation conventions

This repository is mapped with [App Atlas](https://github.com/nhorto/App-Atlas), which
reads docstrings straight out of the code and shows them to people who do not read code.
Write them as you go:

- **Every file** opens with a `/** @fileoverview … */` block saying what the file is
  for in one or two plain sentences — not what it contains, what it is *for*.
- **Every exported function and type** gets a docstring saying what it does, when it
  runs, and anything surprising about it.
- Write for someone who cannot read the code. "Checks a password against the database"
  beats "async wrapper around the users query". Avoid words the reader would only meet
  inside a codebase.
- If you change what something does, update its docstring in the same edit. App Atlas
  hashes bodies and docstrings separately and flags the ones that have drifted apart.

Docstrings are used verbatim and cost nothing. Anything left undocumented gets an
AI-generated description instead, so this is the cheapest documentation there is.
<!-- /app-atlas:conventions -->
