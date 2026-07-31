# Contributing to App Atlas

Thanks for looking. This is a small project with a clear opinion, so the short version
is: the map must never claim more than it knows.

## Getting set up

```bash
git clone https://github.com/nhorto/App-Atlas.git
cd App-Atlas
npm install
npm run build
npm test
```

Requires **Node 22.5+**. Python 3.9+ is optional — without it the Python tests skip
themselves, which is the same way the analyzer degrades on a machine that has no
interpreter.

```bash
npm run build       # the CLI and the web app
npm run typecheck   # both TypeScript projects
npm test            # end-to-end tests against dist/
npm run dev:web     # Vite dev server, expects `app-atlas serve` on port 4477
```

Tests run against `dist/`, not `src/`, so they cover what actually ships. Run
`npm run build` before `npm test` if you have only edited TypeScript.

## The rule everything else follows

**Under-claim.** Telling somebody a route is protected when it is not is the worst
thing this tool can do, and every design decision bends toward avoiding it:

- Static analysis produces facts; AI only names and explains things, and everything it
  writes is labelled.
- Every edge and every guard carries a confidence. `certain` means the compiler said
  so. `likely` means a convention matched. Nothing rounds `likely` up.
- A detector is gated on the project actually depending on the library it recognises.
  An invented box on the map is worse than a missing one.
- A guess never enters the atlas. The type explorer draws a dashed "same name only"
  link between a `User` table and a `User` interface, and that link is computed inside
  the view — the facts layer stays clean.

If a change would make the map say something it cannot support, it is the wrong
change, however useful the feature sounds.

## Good first contributions

- **The service catalog.**
  [`src/analyze/boundaries/catalog.ts`](src/analyze/boundaries/catalog.ts) maps package
  names and hostnames to the company behind them. Adding an entry is a one-line PR and
  immediately improves everyone's boundary view.
- **Boundary detectors.** One small file per family of conventions, in
  [`src/analyze/boundaries/`](src/analyze/boundaries/) for TypeScript and
  [`src/analyze/py/boundaries.ts`](src/analyze/py/boundaries.ts) for Python. If your
  framework, ORM or auth library is missing, that is where it goes.
- **A new language.** The cheapest useful contribution in the repo, and the one with
  the widest effect. Four steps, none of them long:

  1. A row in [`scripts/grammars.mjs`](scripts/grammars.mjs) naming the grammar's npm
     package and version, then `npm run grammars -- --update` to fetch the `.wasm`,
     record its hash and pull its licence in beside it.
  2. A query file next to [`queries/go.scm`](src/analyze/generic/queries/go.scm),
     saying which of that language's syntax answers to each capture name. The
     vocabulary is listed at the top of
     [`extract.ts`](src/analyze/generic/extract.ts); most of it can be cribbed from the
     grammar's own upstream highlight queries.
  3. A dialect the size of [`go/dialect.ts`](src/analyze/generic/go/dialect.ts) — what
     "exported" means, which node types are strings, how a comment is written.
  4. A row in [`languages.ts`](src/analyze/generic/languages.ts).

  That is enough for files, functions, types, imports, doc comments and reference
  edges. Boundary detectors — routes, guards, stores — are optional, separate, and go
  in a `boundaries.ts` beside the dialect; the merge layer they feed has never known
  what language a finding came from, so whatever you emit composes with everything
  already there.

  A language that deserves a real type checker instead gets a deep plugin: the
  contract is [`src/analyze/plugin.ts`](src/analyze/plugin.ts), and
  [`src/analyze/py/`](src/analyze/py/) is the shorter of the two shipped ones.
- **AI backends.** One `run(request)` plus a `probe()`, in
  [`src/enrich/backends/`](src/enrich/backends/). Everything above it — the
  explanation ladder, the cache, the trust tiers, the consent rules — is
  provider-independent.

## The most valuable bug report

A real repository that produces a bad map. Especially a route badged protected that is
not, a service on the boundary view that the app does not actually talk to, or a
description that contradicts the code. Those are the failures this project cares most
about, so please open an issue with enough of the shape of the code to reproduce it.

## Style

- Comments explain *why*, not what. If a line needs a comment to say what it does,
  rename something instead.
- Write a `@fileoverview` on every new file. App Atlas reads its own docstrings, so
  this is not a formality — it is the description that shows up in the map.
- Commits are small and focused, each one building on its own.

[SPEC.md](SPEC.md) is the source of truth for the design, including a build log
explaining why each decision was made and what was deliberately left out. Read it
before a large change.
