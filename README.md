# App Atlas

> **Understand any app — including the one your AI built.**

Run one command in any project and get an interactive, always-accurate map of your
application: every way data gets in, everywhere it goes, and what all the pieces in
between actually do.

![The boundary view: inputs on the left, your app in the middle, outputs on the right](docs/boundary-view.png)

---

## Why this exists

A lot of people now ship real software without writing it. You steer a coding agent,
the code appears, it works — and you cannot answer basic questions about your own
product. Where does data come in? What does this file do? What breaks if I delete
this? Which of my routes have no auth on them?

Every existing code-visualization tool assumes a reader who can already read the
code. App Atlas is built for the person who can't — and it turns out professional
developers don't have a good answer to those questions either.

Two rules keep it trustworthy:

1. **Facts come from the compiler.** The structure you see — files, functions, types,
   who-uses-what — is derived by the TypeScript type checker. It is not an LLM's
   impression of your codebase, so it cannot be subtly wrong.
2. **Words come from your code first.** Descriptions are read verbatim from your own
   docstrings when they exist. Generated explanations fill only the gaps, and
   everything is labelled with where it came from.

## Status

**Early development.** Milestones M1–M3 are complete: the CLI, the
TypeScript/JavaScript analyzer, the atlas data model, the drill-down architecture map,
the boundary view, the security badges and the plain-English explanations all work on
real repositories. See [the roadmap](#roadmap) and [SPEC.md](SPEC.md) for the full design.

## Quick start

Requires **Node 22.5 or newer** (App Atlas uses Node's built-in SQLite, so there is
nothing to compile).

```bash
git clone https://github.com/nhorto/App-Atlas.git
cd App-Atlas
npm install
npm run build
```

Then point it at any project:

```bash
node dist/node/cli.js "C:\path\to\your\project"
```

The analyzer runs, writes the atlas into `.app-atlas/` inside that project, and opens
the map in your browser.

### Commands

| Command | What it does |
|---|---|
| `app-atlas [dir]` | Analyze, then open the map |
| `app-atlas analyze [dir]` | Analyze only, write the atlas to disk |
| `app-atlas serve [dir]` | Serve an atlas that was already analyzed |
| `app-atlas init [dir]` | Teach your coding agent to write docstrings as it builds |

### Options

| Flag | Meaning |
|---|---|
| `-p, --port <n>` | Port for the local server (default 4477) |
| `--no-open` | Don't open a browser |
| `--no-refs` | Skip the symbol-reference pass — much faster on very large repos |
| `--max-files <n>` | Cap on files analyzed (default 5000) |
| `--json <path>` | Also write the JSON export somewhere specific |
| `-q, --quiet` | Less output |
| `--no-ai` | Skip generated explanations entirely — docstrings and compiler facts only |
| `--ai-backend <id>` | Force a backend: `claude`, `codex`, `opencode`, `anthropic`, `openai` |
| `--ai-model <name>` | Override the backend's default model |
| `--ai-max-files <n>` | Cap on files described in one pass (default 400) |
| `--ai-yes` | Approve metered API spending in advance, for scripts |
| `--refresh-ai` | Throw away cached descriptions and write them again |

## The four views

### Boundaries — the home screen

Every door into your app on the left, your app in the middle, everywhere your data
goes on the right. Band thickness is the number of code paths. It knows about:

- **Routes and pages** — Next.js App Router and Pages Router, Express, Fastify, Hono,
  Koa, NestJS controllers, tRPC procedures
- **Server actions**, the quietest door in a Next.js app: an exported async function
  any browser can invoke
- **Webhooks**, recognised by the signature check rather than the URL
- **Scheduled and background jobs** — `vercel.json` crons, node-cron, BullMQ workers,
  Inngest, Trigger.dev
- **The command line, realtime subscriptions, files read off disk, and every
  environment variable you read**
- **Databases** — Prisma (including the engine and table names from `schema.prisma`),
  Drizzle, Kysely, Knex, pg, Mongoose, Supabase, plus browser `localStorage` and
  IndexedDB, which are easy to forget and mean your data lives on one device
- **Outbound calls** — `fetch`/`axios` with a literal URL resolved to a hostname, and
  official SDKs resolved through the package they came from

### Security — the answers the map implies

![Auth coverage, external services and the environment inventory](docs/security-badges.png)

Three questions, answered from static facts:

1. **Who can get in.** Every route, page and server action badged with what protects
   it — a middleware matcher, Clerk, NextAuth, Supabase, a tRPC `protectedProcedure`,
   or your own `requireUser`. When the check is in the handler itself the badge is
   definite; when it is a middleware pattern we had to approximate, it says *likely*.
   Claiming a route is protected when it is not would be the most damaging thing this
   tool could do, so it never rounds up.
2. **Where your data goes.** Every company your app sends data to, with the package or
   hostname that proves it.
3. **Configuration and secrets.** Every environment variable you read, where you read
   it, and whether it is documented in `.env.example`.

### Overview — what this thing actually is

![The overview page, with the app description, its parts, and where to start reading](docs/overview-page.png)

One paragraph saying what your app takes in, does, and stores; the parts it is made of;
and a ranked list of the files everything else leans on — each with a sentence saying
what it is for. At the bottom, an honest accounting of how much of the page was read
from your own docstrings and how much was generated.

### Map — the drill-down

![The architecture map, drilled into a folder](docs/architecture-map.png)

- **Hover** a box for a one-line answer to "what is this?", with a marker saying
  whether the sentence came from your own docstring or was generated.
- **Click** a box to see what it is, what it uses, and what would break without it.
  Its immediate neighbours light up; everything else dims.
- **Press ›** on a box to go inside it. The breadcrumb takes you back out, as does
  <kbd>Backspace</kbd>.
- **<kbd>Ctrl</kbd>+<kbd>K</kbd>** searches every file, function, type and endpoint.
- Colour always means one thing: which zone something belongs to — interface, API,
  logic, data, config or tests.
- The URL tracks where you are, so you can send someone a link to a specific spot.

Drill all the way into a file and you get its types laid out with their fields, wired
to whatever uses them:

![Types inside a file, with their fields and connections](docs/type-view.png)

## Where the words come from

Structure comes from the compiler. Sentences come from a ladder, and the rung is
always shown on screen:

1. **Your own docstrings**, used verbatim. Free, instant, versioned with the code, and
   better than anything generated after the fact — the person who wrote the docstring
   knew the intent.
2. **A generated description**, only where no docstring exists.
3. **Nothing but compiler facts**, under `--no-ai`. Always works, always offline.

If a docstring stops matching its code, App Atlas notices. Bodies and docstrings are
hashed separately, so when the body changes and the comment doesn't, it gets badged
*may be outdated* rather than repeated as though it were still true.

### It uses the AI subscription you already have

Most people building this way have a Claude Code or Codex subscription, not an API
key. App Atlas runs enrichment through whichever agent CLI it finds on your machine,
in headless mode, so explanations cost nothing extra and need no setup:

```bash
app-atlas analyze .
```

Failing that, it uses `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY` with any
OpenAI-compatible endpoint — which covers OpenAI, OpenRouter, and a local model through
Ollama or LM Studio via `OPENAI_BASE_URL`.

**You are asked before anything is spent, and only when there is something to spend.**
A subscription is free at the margin, so interrupting you for it would be friction with
nothing on the other side; the run just tells you afterwards what wrote the
descriptions. An API key gets a real question first, with the number of items, an
estimate rounded up, and a note of what leaves your machine. Answers are cached against
the facts they were derived from, so unchanged code is never paid for twice.

### Make it free

```bash
app-atlas init
```

Writes a short convention block into your `AGENTS.md` / `CLAUDE.md` asking your coding
agent to document as it builds. Your agent then writes the docstrings, App Atlas reads
them verbatim, and the amount it needs to generate — and so the cost — trends toward
zero. Your codebase ends up documented as a side effect of being mapped.

## How it works

```
CLI ──▶ Analyzer ──▶ Atlas model ──▶ Enricher ──▶ Local web app
        (ts-morph)   (SQLite + JSON)  (your CLI    (React Flow + elkjs)
                                       or any API)
```

- **Analyzer** — [ts-morph](https://ts-morph.com) over the real TypeScript compiler.
  The type checker is the point: knowing what an identifier *resolves to* is what
  separates a real map from a regex guess. Language plugins are an interface from day
  one; Python is next. Boundary detectors ride along on the same traversal, so finding
  every door costs one extra pass, not ten.
- **Atlas model** — a language-agnostic graph of nodes (app, folder, file, function,
  type, endpoint, service, store) and edges (contains, imports, references, reads-from,
  writes-to, exposed-by, protected-by), stored in SQLite with a JSON export any agent
  can read. Every node carries a content hash and a provenance label, which is what
  incremental re-analysis and explanation caching build on.
- **Enricher** — a pluggable `run(request)` behind an explanation ladder, a cache keyed
  by the facts each description was derived from, and a validation layer that drops
  anything the model returned about something we never asked about. The tiers are
  batched so one process start buys a dozen descriptions, and per-symbol detail is
  generated only when someone clicks.
- **Web app** — one level of the graph on screen at a time, laid out deterministically
  by [elkjs](https://github.com/kieler/elkjs) so the same code always produces the
  same picture. There is no force-directed hairball anywhere in this project, by
  design.

## Roadmap

| | Milestone | Status |
|---|---|---|
| **M1** | CLI, TypeScript analyzer, atlas model, drill-down architecture map | ✅ done |
| **M2** | Framework plugins, boundary detectors, the boundary view, security badges | ✅ done |
| **M3** | Explanations — docstrings first, provider-agnostic AI for the gaps | ✅ done |
| **M4** | Type explorer, guided walkthroughs, `ATLAS.md` export for coding agents | next |
| **M5** | Incremental re-analysis, `--watch`, Python, monorepo scopes, launch | |

## Development

```bash
npm run build       # build the CLI and the web app
npm test            # end-to-end tests against the built output
npm run typecheck   # both TypeScript projects
npm run dev:web     # Vite dev server (expects `app-atlas serve` running on 4477)
```

Tests run against `dist/`, not `src/`, so they cover what actually ships.

## Contributing

Contributions are welcome, particularly:

- **Language plugins.** The analyzer takes source files and emits atlas nodes and
  edges — see [`src/analyze/plugin.ts`](src/analyze/plugin.ts). Go, Ruby and Rust are
  all wide open.
- **Boundary detectors.** A detector is one small file that recognises one family of
  conventions — see [`src/analyze/boundaries/`](src/analyze/boundaries/). If your
  framework, ORM or auth library is missing, that is the file to add.
- **The service catalog.** [`catalog.ts`](src/analyze/boundaries/catalog.ts) maps
  packages and hostnames to the company behind them. Adding an entry is a one-line PR
  and immediately improves everyone's boundary view.
- **AI backends.** A backend is one `run(request)` function plus a `probe()` — see
  [`src/enrich/backends/`](src/enrich/backends/). Everything above it (the ladder, the
  cache, the trust tiers, the consent rules) is provider-independent.
- **Real-world repos that produce a bad map** — or, worse, a route badged protected
  that is not. Those are the most useful bug reports this project can get.

[SPEC.md](SPEC.md) is the source of truth for the design and explains why each
decision was made, including what was deliberately left out.

## License

MIT — see [LICENSE](LICENSE).
