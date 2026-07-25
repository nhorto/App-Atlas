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
   who-uses-what — is derived by the language's own parser and type checker. It is not
   an LLM's impression of your codebase, so it cannot be subtly wrong.
2. **Words come from your code first.** Descriptions are read verbatim from your own
   docstrings when they exist. Generated explanations fill only the gaps, and
   everything is labelled with where it came from.

## Status

**Milestones M1–M5 are complete.** The CLI, the TypeScript/JavaScript analyzer, the
Python analyzer, the atlas data model, incremental re-analysis, watch mode, the
drill-down architecture map, the boundary view, the security badges, the plain-English
explanations, the type explorer, guided walkthroughs, monorepo scopes and the
`ATLAS.md` export all work on real repositories. See [the roadmap](#roadmap) and
[SPEC.md](SPEC.md) for the full design.

## Quick start

Requires **Node 22.5 or newer** (App Atlas uses Node's built-in SQLite, so there is
nothing to compile). Python projects also need **Python 3.9 or newer** on the machine
— App Atlas reads Python with Python's own parser rather than guessing at the grammar.

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
| `app-atlas export [dir]` | Write `ATLAS.md` — the map, for your coding agent |
| `app-atlas init [dir]` | Teach your coding agent to write docstrings as it builds |

### Options

| Flag | Meaning |
|---|---|
| `-p, --port <n>` | Port for the local server (default 4477) |
| `--watch` | Keep watching, and update the map whenever the code changes |
| `--no-open` | Don't open a browser |
| `--no-refs` | Skip the symbol-reference pass — much faster on very large repos |
| `--fresh` | Re-read every file instead of reusing the last run |
| `--scope <name>` | In a monorepo, work on one app only |
| `--ignore <glob...>` | Leave paths out — example apps, vendored code |
| `--max-files <n>` | Cap on files analyzed (default 5000) |
| `--json <path>` | Also write the JSON export somewhere specific |
| `-q, --quiet` | Less output |
| `--no-ai` | Skip generated explanations entirely — docstrings and compiler facts only |
| `--ai-backend <id>` | Force a backend: `claude`, `codex`, `opencode`, `anthropic`, `openai` |
| `--ai-model <name>` | Override the backend's default model |
| `--ai-max-files <n>` | Cap on files described in one pass (default 400) |
| `--ai-yes` | Approve metered API spending in advance, for scripts |
| `--refresh-ai` | Throw away cached descriptions and write them again |
| `--md <path>` | `export` only: where to write the file (default `ATLAS.md`) |
| `--stdout` | `export` only: print it instead of writing a file |

## The five views

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

This page is also where the **tours** live — see [Guided tours](#guided-tours).

### Data — dbdiagram for your code

![Every shape the app moves around, with lines from the field that holds the reference](docs/data-view.png)

Every shape your app moves around, on one canvas: interfaces, types, classes and enums
from your code, **and your database tables** read straight out of `schema.prisma`, in
the same picture. A line leaves the row that actually holds the reference, the way a
database diagram draws a foreign key — so you can see that `Order.user` points at
`User` rather than just that the two are somehow related.

- Each card lists its fields, marks the primary key, and says where the shape is used
  and in which parts of the app: *used in 95 places · 51 Data, 40 Logic, 4 API*.
- **Solid lines are declared** — a field's type, or a relation the schema states.
  **Dashed violet lines are only a shared name**: a `User` table and a `User` type are
  usually the same idea, but nothing in the code says so, and App Atlas will not
  pretend otherwise.
- Big codebases show the most-used shapes first and say how many were left out.

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

## Guided tours

Instead of reading the map, have it read itself to you. The overview page offers a
short list of walkthroughs, and any door in your app has a **Walk me through what
happens** button:

- **Welcome to your codebase** — five steps: what this is, how the outside gets in,
  the parts it is made of, where your data ends up, and where to start reading.
- **What happens when…** — one per major entry point, traced through the code:
  *what happens when something sends POST to /api/users*, *when an outside service
  calls your webhook at /api/webhooks/stripe*, *when the schedule fires (0 8 \* \* \*)*.

![A tour at step 3 of 5, with the parts it is describing lit and everything else dimmed](docs/walkthrough.png)

Each step moves the map to the level being discussed, lights up what it is talking
about, and offers the code underneath. You can click away mid-tour to follow your own
thread — **Show me again** puts the step back.

Tours are **derived, not written**. Every step is a traversal of the graph, so they
cost nothing, work with `--no-ai`, and cannot go stale: change the code, re-analyze,
and the tour describes the new code. Where a step quotes a description, it says whether
that came from your docstring or from a model — the paragraph itself is always
compiler fact.

## For your coding agent

The tool exists because agents write code faster than people can read it. The same map
is worth more if the agent reads it too:

```bash
app-atlas export
```

That writes `ATLAS.md` — about 5 KB for a 75-file project — with what the app is, every
door and what guards it, where data goes, the folder map, the database tables and key
types, and where to look first. Then add one line to `CLAUDE.md`, `AGENTS.md` or your
Cursor rules:

```
Read ATLAS.md before changing code. It is the map of this app.
```

Sentences in it that a model wrote are marked `(ai)`; everything else is compiler fact.
Re-run the export after a session and the map is current again. (The full atlas is
plain SQLite and JSON in `.app-atlas/`, so an agent that wants more can query it
directly. An MCP server is planned for v1.1.)

## It keeps up with your agent

The map is only useful if it is right *now*. Two things make that cheap.

**Only what changed is read again.** Every file's contribution to the atlas — its
nodes, its edges, its boundary findings — is cached under a hash of that file's text.
A second run restores everything you have not edited and never hands it to the
compiler. On this repo that is 4.1s down to 0.3s.

Editing a file also invalidates whatever imports it, because renaming an export
changes the id its callers point at and only re-reading those callers can notice. If
you ever want the paranoid version, `--fresh` re-reads the lot.

**Watch mode closes the loop.**

```bash
app-atlas --watch
```

The map now updates itself while your agent works. Every save triggers a rebuild — the
same pipeline as a normal run, so the two cannot drift — and the open page follows
along without a reload. And it says the thing this tool exists to say:

```
  ↻ src/app/api/orders/route.ts · 0.3s
    1 new route has no auth check App Atlas can see.
```

Watch mode never stops to ask about spending money. A question that appears mid-edit,
repeatedly, is not consent — so a metered API key is quietly declined and a
subscription is unaffected.

## Python, at the good tier

```bash
app-atlas ~/code/my-fastapi-app
```

Python gets the same treatment as TypeScript: files, functions, classes with their
fields, imports, docstrings, and the whole boundary layer — FastAPI, Flask and Django
routes; Celery tasks; SQLAlchemy and Django ORM calls; `requests` and `httpx` with
their literal URLs resolved to the company on the other end; `os.environ` read however
you spell it.

App Atlas reads Python with **Python's own `ast` module**, by shelling out to whatever
interpreter your project already uses — a virtual environment in the project wins, and
`APP_ATLAS_PYTHON` overrides everything. A parser reimplemented in JavaScript would
disagree with the interpreter eventually, and being subtly wrong is the one thing this
tool must not be. If there is no Python on the machine, the files still appear on the
map; they just have no insides.

One difference is stated rather than hidden. TypeScript gets a type checker, so "this
identifier is that declaration" is a fact. Python matches a name through the import
that introduced it: inside a file that is as good as certain, across files it is an
inference — and every one of those edges carries **likely** instead of **certain**.
The same rule applies to auth: a FastAPI `Depends(get_current_user)` counts as a
guard, but only ever a likely one, because a function with that name that returns
`None` for a stranger is not a check.

## Monorepos get one map each

```
  3 packages in this workspace, 2 of them apps

  api  1 file · 1 way in    1 of 1 routes unprotected
  web  2 files · 2 ways in  2 of 2 routes unprotected
  ui   1 file
```

App Atlas reads the package list from npm, yarn, pnpm, uv or Poetry — whichever one
declared it — and gives every app its own atlas, with a switcher at the top of the
page. One map of six apps is exactly the hairball this tool exists to avoid, and "my
web app" is how people talk about their own repo anyway.

Each app keeps its atlas and its cache in its own directory, so `app-atlas apps/web`
on its own is the same operation as running it in a repo with one app in it. Use
`--scope web` to work on one without leaving the root.

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
                                       or any API)      │
                                              ATLAS.md ─┘
```

- **Analyzer** — [ts-morph](https://ts-morph.com) over the real TypeScript compiler,
  and Python's own `ast` module for Python. The checker is the point: knowing what an
  identifier *resolves to* is what separates a real map from a regex guess. Language
  plugins are an interface, and the two shipped ones sit at deliberately different
  depths to prove that interface tolerates it. Boundary detectors ride along on the
  same traversal, so finding every door costs one extra pass, not ten.
- **The cache** — one row per file, keyed by a hash of its text, holding everything
  that file contributed. It works because every edge a file produces starts inside it,
  so slices restore in any order; it stays correct because editing a file also
  invalidates whatever imports it, and because anything project-wide that could change
  an answer (the tool version, the flags, the dependency list, the config files) is
  folded into one fingerprint that discards the lot when it moves.
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
- **Tours and the export** — both are pure functions of the graph. A walkthrough step
  is a traversal (door → handler → what it calls → where it lands) and `ATLAS.md` is a
  rendering, which is why neither needs a model, a network, or an update when the code
  changes.

## Roadmap

| | Milestone | Status |
|---|---|---|
| **M1** | CLI, TypeScript analyzer, atlas model, drill-down architecture map | ✅ done |
| **M2** | Framework plugins, boundary detectors, the boundary view, security badges | ✅ done |
| **M3** | Explanations — docstrings first, provider-agnostic AI for the gaps | ✅ done |
| **M4** | Type explorer, guided walkthroughs, `ATLAS.md` export for coding agents | ✅ done |
| **M5** | Incremental re-analysis, `--watch`, Python, monorepo scopes | ✅ done |

After v1.0, in rough order of how useful they'd be: an MCP server so an agent can
query the atlas directly instead of reading a file; a "what changed" overlay that
shows what your agent just did to the map, with the new routes glowing; cross-package
tracing so a monorepo can follow a call from the web app through a shared package into
the API; and more language plugins.

## Development

```bash
npm run build       # build the CLI and the web app
npm test            # end-to-end tests against the built output
npm run typecheck   # both TypeScript projects
npm run dev:web     # Vite dev server (expects `app-atlas serve` running on 4477)
```

Tests run against `dist/`, not `src/`, so they cover what actually ships. The Python
tests skip themselves when there is no Python 3.9+ on the machine, so working on the
TypeScript side never requires installing one.

`build:node` compiles TypeScript and then copies
[`extract.py`](src/analyze/py/extract.py) into `dist/` — it is source for a different
language, so `tsc` will not do it.

App Atlas maps itself: [`ATLAS.md`](ATLAS.md) in this repo is its own export, and
[`AGENTS.md`](AGENTS.md) was written by `app-atlas init`. Regenerate both after a
change with:

```bash
node dist/node/cli.js analyze . -q --ignore "test/fixtures/**" && node dist/node/cli.js export .
```

The `--ignore` matters: `test/fixtures/` holds small deliberately-insecure apps, and
without it App Atlas reports *their* unprotected routes as its own. Any repo that
ships example code has the same problem.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and the one rule everything else
follows. Contributions are welcome, particularly:

- **Language plugins.** The analyzer takes source files and emits atlas nodes and
  edges — see [`src/analyze/plugin.ts`](src/analyze/plugin.ts). TypeScript and Python
  are done and sit at different depths on purpose;
  [`src/analyze/py/`](src/analyze/py/) is the shorter of the two to read first. Go,
  Ruby and Rust are all wide open.
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
