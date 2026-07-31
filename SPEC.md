# App Atlas — Draft Spec v0.2

> **One-liner:** Understand any app — including the one your AI built. Run one command in any project and get an interactive, always-accurate atlas of your application — where data enters, what happens to it inside, and where it goes.

**Status:** ✅ Approved by Nick (2026-07-25). M1–M6 shipped — the v1.0 feature set is complete, and the language seam is open. See section 13 for the build log. Incorporates feedback rounds 1–2: name locked, open source, provider-agnostic AI with agent-CLI passthrough, dual audience, security badges in v1.0, agent/MCP integration, explanation-source ladder (docstrings first).

---

## 1. The problem & audience

**Primary persona:** people who build applications with AI coding agents (Claude Code, Codex, Cursor, Lovable, Bolt, Replit) and end up with large codebases they didn't write and can't read. They can steer the agent, but they can't answer basic questions about their own product.

**Secondary persona:** professional developers. The research shows the boundary/traceability UX gap exists for *everyone* — even experts have no good tool for "show me every door into this app and trace what happens to data from entry to exit." Since App Atlas is open source, there's no pricing barrier keeping developers away; the same views serve both audiences, with plain-English narration layered on top rather than replacing the precise facts (signatures, types, locations are always one click away).

The design rule for serving both: **facts are precise, narration is optional.** A developer reads the same map and can ignore the prose; a beginner leans on the prose. Neither gets a dumbed-down or jargon-locked experience.

Questions the tool must answer:

- What are all the ways data gets into my app?
- Where does my data go? What companies does my app talk to?
- What does this file/function/type actually do?
- How are the pieces connected?
- What did the agent just change?
- Which of my routes are protected, and which aren't?

Every existing code-visualization tool assumes a developer reader (UML, dependency graphs, DSMs, IDE plugins) — and even for that reader, none delivers the boundary/trace view well. Nobody serves the non-coder builder persona at all, and it's a large, fast-growing market.

## 2. Market findings (from research, July 2026)

**The gap is real. Four things nobody does:**

1. **Nobody draws the boundary view statically.** Every static tool draws file-to-file import graphs (madge, dependency-cruiser, Emerge, Codemap). AppMap draws real boundaries (HTTP in, SQL out) but requires runtime instrumentation — an adoption killer even for professionals. No tool statically derives *"here are your app's doors: 12 routes, 3 webhooks, 2 crons in; Postgres, Stripe, OpenAI, Resend out"* as the top-level picture.
2. **Nobody serves the "can't read my own codebase" persona.**
3. **Nobody combines ground truth with narrative.** DeepWiki = narrative without guarantees (LLM-generated, can hallucinate). dependency-cruiser = ground truth without narrative. CodeBoarding is attacking the middle but is developer-oriented.
4. **Nobody does static "trace a request" storytelling.** "What happens when someone submits this form" is the most-requested comprehension question; today only answerable via runtime tracing.

**Lessons from the graveyard:**

- **CodeSee (dead, 2024):** sold comprehension to people who already comprehended. Our audience is different in kind — they *cannot* read the code.
- **arkit, tsviz, GitHub's repo-visualization (all dead/shelved):** a pretty static picture with no narrative or curation doesn't retain users.
- **Mutable.ai AutoWiki (dead, 2024):** auto-docs alone weren't a business.
- **What survives is decision support, not pictures:** CodeScene (what to refactor), knip (what to delete), dependency-cruiser (CI rules). The map must *answer questions*, not just look good.
- **Pure-LLM diagrams have a hard ceiling:** they hallucinate components that don't exist (documented by Ilograph's testing; confirmed by CodeBoarding's pivot to static-analysis-validated LLM labeling).

## 3. Product principles

1. **Facts from the compiler, words from the code's own docs first, AI second.** Static analysis produces the structure (files, functions, types, edges, boundaries) — it is never wrong. Explanations follow a deterministic ladder: docstrings/JSDoc when present, AI generation only for the gaps (see 5.5). Everything in the UI carries one of three trust labels — code facts / from your docs / AI explanation — so users learn what's ground truth.
2. **Never show the whole graph.** No force-directed hairballs, ever. Hierarchical containment (boxes inside boxes), semantic zoom, breadcrumbs, and local graphs (click a node → its neighborhood lights up, everything else dims). The full graph lives in the data layer; the canvas only ever renders the current level's slice.
3. **Opinionated top-level schema.** The home screen is not a generic graph — it's the boundary view: inputs → your app → outputs. That matches the mental model non-developers already have ("my app talks to Stripe").
4. **Deterministic layout.** Same code → same map, every session (elkjs layered layout, no physics). Spatial memory is a feature: "the auth stuff is always top-left."
5. **Attach answers to the map.** Not just pictures: "this route has no auth check," "your app sends data to these 4 companies," "this env var is read in 3 places," "deleting this file is safe."
6. **Plain English everywhere.** Module labels say "User accounts," not `src/auth`. Every hover card leads with the AI's one-line summary, not a type signature.

## 4. Decisions locked in

| Decision | Choice |
|---|---|
| Name | **App Atlas** (atlas = book of maps = the four lenses) |
| Business model | **Fully open source** |
| Form factor | CLI + local web app (`npx app-atlas` → analyzer runs → browser opens). Code stays local; only snippets go to the AI backend. |
| Analysis | Static analysis skeleton + tiered AI explanations |
| AI backend | **Provider-agnostic from day one** — pluggable enricher interface (see 5.5): API keys (Anthropic, OpenAI, …) *or* the user's already-installed agent CLI (Claude Code, Codex CLI, OpenCode) |
| Languages (v1) | TypeScript/JavaScript (deep) + Python (good) + Go (grammar tier, over tree-sitter); data model is language-agnostic and the grammar tier makes a new language a query file and a dialect |
| Views (v1) | Boundary/data-flow, Architecture map w/ drill-down, Type explorer, Guided overview/tour, security insight badges |
| AI timing | Tiered: app/area/file summaries up front; function-level on first click; all cached by content hash |
| Freshness | Snapshot + incremental re-run by default; `--watch` mode included in v1 |
| Audience | Open-source product for both non-coder agent-builders (primary) and professional developers (secondary) |
| Monorepos | v1: detect workspaces, one atlas per app/package with a switcher; cross-package edges in v1.x (see 5.7) |
| Agent integration | Atlas is agent-readable from day one (SQLite/JSON + `export`); MCP server in v1.1 (see 7) |

## 5. System architecture

```
┌─────────────┐   ┌──────────────────┐   ┌─────────────┐   ┌────────────────┐
│  CLI         │──▶│  Analyzer         │──▶│  Atlas Model │──▶│  Local web app  │
│  npx         │   │  per-language     │   │  (SQLite +   │   │  React + React  │
│  app-atlas   │   │  + framework      │   │  JSON export)│   │  Flow + elkjs   │
└─────────────┘   │  plugins          │   └──────┬──────┘   └────────────────┘
                  └──────────────────┘          │
                                        ┌───────▼────────┐
                                        │  AI enricher    │
                                        │  (Claude API,   │
                                        │  hash-cached)   │
                                        └────────────────┘
```

### 5.1 CLI
- `npx app-atlas` — analyze current directory, start local server, open browser.
- `app-atlas --watch` — file-system watcher; incremental re-analysis on change; UI live-updates.
- `app-atlas --no-ai` — pure static mode (free, offline).
- `app-atlas init` — adds the docstring convention block to CLAUDE.md / AGENTS.md / Cursor rules so the user's coding agent documents as it builds (see 5.5).
- First run: friendly setup — detects frameworks, auto-detects an installed agent CLI (Claude Code / Codex / OpenCode) or accepts an API key for explanations, shows estimated cost (or "using your subscription") before the first AI pass.

### 5.2 Analyzer (the facts layer)

**TypeScript/JavaScript — deep tier.** TypeScript Compiler API via **ts-morph**. We need the *type checker*, not just a parser: boundary detection ("is this `db` a PrismaClient? is this `.get` axios or a Map?") requires resolving identifiers to declarations and types. Extracts:
- Files, exported/internal functions (name, params, return type, async, JSDoc)
- Types/interfaces/enums/zod schemas: definition site, fields, and every usage site
- Import/export graph (module edges)
- Reference edges: pragmatic "who references this symbol" via checker (findReferences semantics). Sound JS call graphs are a research problem — we don't promise them; we label confidence. Agent-written code is unusually plain and statically typed, which works in our favor.

**Python — good tier.** Structure via Python's own `ast` (or tree-sitter) + import graph; boundary detectors for FastAPI/Flask/Django routes, Celery tasks, SQLAlchemy/Django ORM, `requests`/`httpx` calls, `os.environ`. Type depth is shallower than TS in v1; the model tolerates per-language depth differences.

**Everything else — grammar tier (added post-M5, see 13).** One extractor over tree-sitter grammars shipped as WebAssembly: symbols, imports, calls, bindings and doc comments, flattened into the same record shape `extract.py` produces. Per language it costs a `.scm` query file and a dialect; the boundary detectors on top are optional and separate. Real syntax, no resolution — names are matched rather than resolved, cross-file edges are `likely`, and every node carries `tier: 'tree-sitter'` so no screen can present the difference as anything else. Go is the first and, deliberately, the only one until the seam has been proved on it.

**Framework plugins (the moat).** knip proved convention-detection works at scale (150+ plugins). Our target market concentrates on a small stack, so ~10 detectors cover most real users:
Next.js (App Router routes, server actions, middleware), Express/Fastify/Hono, tRPC, React Router/Remix, Vite/CRA SPA entries; FastAPI/Flask/Django; Prisma (+ free bonus: parse `schema.prisma` → data-model diagram), Drizzle, Supabase client, Mongoose; NextAuth/Clerk/Supabase Auth.

### 5.3 Boundary detectors (v1 list)

**Inbound (data enters):**
- HTTP routes: Next.js `app/**/route.ts` + server actions, `pages/api/**`, Express/Fastify/Hono route calls, NestJS decorators, tRPC procedures, FastAPI/Flask/Django routes
- Webhooks: route paths matching webhook patterns; signature-verification calls (`stripe.webhooks.constructEvent`, svix)
- Scheduled/queued: `vercel.json` crons, node-cron, BullMQ workers, Inngest, Celery
- CLI args: `process.argv`, commander/yargs; `argparse`/click
- Env/config: `process.env.*`, `import.meta.env`, zod/envalid env schemas, `os.environ` — full enumerable inventory
- File reads, WebSocket/realtime subscriptions

**Outbound (data exits):**
- Database: Prisma/Drizzle/Kysely/knex/pg/Mongoose/SQLAlchemy usage; Supabase `.from('table')` with statically-extracted table names
- Outbound HTTP: `fetch`/`axios`/`got`/`requests`/`httpx` call sites with literal-URL resolution → **external-services inventory** (Stripe, OpenAI, Resend…). SDK imports mapped against a curated catalog of known services
- Email/SMS/notifications: Resend, SendGrid, nodemailer, Twilio, Slack webhooks
- File/blob writes: fs, S3, Vercel Blob, Supabase Storage
- Responses: route-handler return types via the type checker (recoverable payload shapes)
- **Auth boundary (first-class):** which routes are protected, by what (middleware matchers, Clerk/NextAuth/Supabase auth) — and which are *not*

### 5.4 Atlas model (the data layer)
Language-agnostic graph in SQLite (JSON-exportable):
- **Nodes:** app, zone (UI/API/logic/data — derived), module (folder-derived, AI-named), file, function, type, boundary endpoint (route/webhook/cron/env/…), external service, data store
- **Edges:** contains, imports, references, reads-from, writes-to, exposed-by, protected-by
- Every node: content hash (drives incremental re-analysis + AI cache), source location, provenance (`static` | `ai`)
- Every AI summary keyed by node hash — unchanged code never re-bills

### 5.5 The words layer — explanation source ladder + provider-agnostic enricher

**Explanation source ladder.** For every file and function, the displayed explanation comes from the first available rung — deterministic sources always win over generated ones:

1. **Docstrings/JSDoc in the code** (`@fileoverview` at file level, function JSDoc; Python module/function docstrings) → used verbatim. Free, instant, deterministic, versioned with the code.
2. **AI-generated summary** → only where no docstring exists; hash-cached so it's generated once and stable until the code changes.
3. **Compiler facts only** (`--no-ai`, no docstring) → signature, types, references.

**Three-tier trust labels** (refines principle #1): **code facts** (compiler-derived, cannot be wrong) → **from your code's docs** (deterministic but human/agent-authored claims, could be stale) → **AI explanation** (generated). Visually distinct, subtly.

**Stale-docs detection:** hash function bodies and docstrings separately. If a re-analysis shows the body changed but its docstring didn't, badge it "docs may be outdated" — the tool actively catches the classic stale-comment problem instead of inheriting it.

**The ecosystem loop — `app-atlas init`:** writes a short convention block into the repo's agent instructions (CLAUDE.md / AGENTS.md / Cursor rules): *"write a `@fileoverview` docstring in every file and detailed docstrings on exported functions."* The user's own coding agent then documents as it builds → the atlas reads those docs for free → the AI enricher only fills gaps → enrichment cost trends toward zero on well-documented repos, and the repo itself ends up better documented as a side effect. Existing docstrings also feed the AI as input when it *does* generate (module naming, tours).

**Provider-agnostic enricher.** The enricher is a small pluggable interface: `summarize(promptBundle) → text`. Everything above it (the ladder, tiering, caching, validation) is backend-independent. Backends, in order of build priority:

1. **Agent CLI passthrough** — if the user already has Claude Code, Codex CLI, or OpenCode installed, run enrichment through it in headless mode (`claude -p`, `codex exec`, `opencode run`). Huge for this audience: most agent-builders have a *subscription*, not an API key — this makes AI explanations effectively free for them and requires zero setup. Auto-detected on first run.
2. **Direct API keys** — Anthropic, OpenAI, and any OpenAI-compatible endpoint (covers most other providers + local models via Ollama/LM Studio).
3. **`--no-ai`** — pure static mode, always works, free and offline.

- Tiered pass on first run: ① app overview + zone/module naming and grouping (validated against the static graph — the AI proposes groupings *of real nodes only*, never invents structure), ② per-file one-liners + short descriptions, ③ function/type-level detail generated lazily on first click, then cached
- Generates: overview page, module labels, hover-card one-liners, walkthrough scripts, "what changed" changelogs
- Cost control: show estimate before first pass; lazy detail means cost scales with what you explore; hash-keyed cache means unchanged code never re-bills

### 5.6 Monorepo handling (v1 decision)
- Detect workspaces (`pnpm-workspace.yaml`, npm/yarn workspaces, turborepo/nx config, uv/poetry workspaces)
- Each deployable app or package gets **its own atlas scope**; the UI shows a scope switcher (like a database picker). Shared internal packages appear inside a consuming app's map as a distinct "internal library" node style
- Full cross-package boundary tracing (e.g., web app → shared package → API app) is v1.x — the model's edges already support it; only the UI work is deferred
- Rationale: keeps every v1 view within its readable size budget, ships sooner, and matches how users think ("my web app," "my API")

### 5.7 Language extensibility
The analyzer is a plugin interface from day one: a language plugin consumes source files and emits atlas nodes/edges (the model is already language-agnostic). TS/JS and Python are the first two plugins, at different depth tiers — which proves the interface tolerates depth differences before any third language (Go, Ruby, Rust…) is attempted. Community language plugins are an explicit open-source goal.

**Settled by the grammar tier.** Nobody writes forty analyzers; the neighbours that cover forty languages wrote *one* extractor over tree-sitter grammars and layered framework detectors on it. `src/analyze/generic/` is that extractor. A language costs a grammar, a query file naming which of its syntax answers to a fixed capture vocabulary, and a dialect of about fifty lines — and it inherits the whole boundary layer, because `boundaries/build.ts` has never known what language a finding came from. Go was added without one line of change to it: route prefixes compose through the machinery written for FastAPI's `include_router`, and a Go middleware is decided to be a check by the rule that decides it for a NestJS guard.

The deep tiers claim their files first and the grammar tier takes what is left, so adding a grammar can never downgrade a language a compiler was already reading.

### 5.8 Web app (the lens layer)
React + **React Flow (@xyflow/react)** for canvas (nodes are real React components — type cards, folder boxes, hover cards are just JSX) + **elkjs** for deterministic hierarchical layout (only mainstream JS engine with proper boxes-inside-boxes support; runs in a web worker) + **d3-sankey** for boundary-view flow bands. Canvas only ever receives the current level's slice of the graph.

## 5.9 Project archetypes (what kind of thing is this repo?)

The five views were designed for a web app, and shipping them in that order to every
project meant a Python scripts repo opened on a nearly-empty diagram of doors it does
not have. Framework detection already existed (`detectFrameworks` in
`src/analyze/project.ts`); nothing downstream consumed it.

So the analyzer now classifies an **archetype** — a different question from which
framework is in use, since two FastAPI repos can be a service and a library.

| Archetype | Decided by | Home view |
|---|---|---|
| `web-app` | screens, or network doors plus a UI framework / interface files | Boundaries |
| `service` | network doors, no UI | Boundaries |
| `pipeline` | a `cli` door, a `bin` entry, or a schedule — and nothing answering a URL | Map |
| `library` | files with exports, and no doors of any kind | Map |
| `unknown` | none of the above | Map |

Rules that keep this honest:

- **It is a fact, not a guess by a model.** Every input is something the compiler or a
  manifest told us, and the verdict carries `because` — the signals that produced it —
  which is rendered on the Overview page. A wrong verdict that shows its reasoning is
  a bug report; one that hides it is a mystery.
- **It changes emphasis, defaults and wording. Nothing else.** No view is ever hidden,
  no fact ever changes, and there are no per-framework screens — that would be a
  maintenance explosion and would fight the one-atlas-many-lenses design.
- **Landing is decided once.** A bare URL lands on the archetype's home view; an
  explicit `#hash` always wins, and a watch-mode rebuild never moves someone.
- **Tab emphasis comes from the counts, not the archetype**, so a misclassified project
  still gets an honest tab bar. `unknown` is a real answer, not a failure.

## 6. The views (v1)

Every view states its own question in a fixed strip under the tabs. Two of them are a
canvas of boxes joined by lines, so without that line they read as variations on one
picture rather than as different questions — and the tab labelled "Data" collided with
both the data-*flow* reading the boundary view owns and the Data *zone* in the map's
legend. It is called **Data model** for that reason; the URL hash stays `#types`.

| View | Hash | The question it answers |
|---|---|---|
| Boundaries | `#boundaries` | What gets into your app, and where it ends up |
| Overview | `#overview` | What this app is, and where to start reading |
| Map | `#map` | How your code is organized — the folders and files, and what uses what |
| Data model | `#types` | What your data looks like — the shapes your app moves around |
| Security | `#insights` | Who can get in, where your data goes, and what you rely on |

### 6.1 Boundary view — the home screen
Left→right (beats the ring: reading order, causality, scales better; rings die past ~10 spokes).
- **Left edge:** input sources as cards — Users/browser, Stripe webhooks, cron jobs, env/config, third-party APIs
- **Center:** one large box = your app, containing 3–6 auto-detected zones (UI, API, business logic, data)
- **Right edge:** outputs — database, external APIs, email, file storage
- Sankey-style bands connect them; thickness = number of code paths. Max ~8–10 endpoints per side; minor flows group into "other"
- Hover a band → its full path highlights. Click → launches a trace walkthrough
- Below the diagram, one AI paragraph: "Your app takes X in, does Y with it, and stores/sends Z"

**Parameterized by archetype (§5.9).** One view, not three screens — if the
implementation ever forks, the abstraction is wrong. The geometry never changes,
because left→right *is* the argument for this view over a ring. Only the vocabulary
and what counts as a door do:

| Archetype | Left column | Right column |
|---|---|---|
| `web-app` | What gets in | Where data goes |
| `service` | What calls it | Where data goes |
| `library` | What consumers can call | What it reaches for |
| `pipeline` | What it reads | What it writes |

A **library's doors are its exported names**, emitted into the atlas as endpoints of
kind `export` and split into two cards — functions (breaking a caller at runtime) and
types (breaking them at compile time). They are real graph nodes rather than a
rendering trick, so the detail panel, tours and `ATLAS.md` get them for free. Two
rules keep them honest: they are only built for projects classified `library` (on an
app, every helper would become a door and the picture would say nothing), and `export`
is deliberately excluded from `isAuthRelevant`, because badging an import
"unprotected" would be a false alarm in the one place this tool must never cry wolf.

A **pipeline** needs no new detectors — the CLI, file reads, env reads and file
writes already exist as boundary findings. What it needed was the vocabulary, so the
same picture reads as an I/O diagram.

The headline follows the same rule: the first count is renamed per archetype
("3 names in its public API", "2 inputs"), and zero counts drop out rather than
padding the line with `0 services out · 0 data stores`.

### 6.2 Architecture map — drill-down
- Top level: 5–9 modules as nested rounded rectangles with plain-English labels, aggregated arrows ("12 calls") between them
- Double-click → camera zooms in; siblings collapse to slim tabs at the border (context preserved); files render inside
- Click a file → local-graph highlight (1-hop neighbors lit, rest dimmed to ~15%) + detail panel
- Breadcrumb top-left (`App › User accounts › login.ts`), minimap bottom-right, Cmd-K search top-center
- Inside a file: its functions and types as rows/cards, each with AI one-liner, params, return type

### 6.3 Data model (the type explorer) — dbdiagram for your code
Types are the "tables" of application code:
- Type cards: header (name + kind badge), rows = fields with their types
- Field-level edges to other type cards; elkjs layered left→right layout
- Click a card → neighbors stay lit; side panel: "Defined in `models/user.ts`", AI description ("A User is…"), usage list ("used in 14 places — 8 UI, 4 API, 2 DB") with click-to-fly
- Bonus: if Prisma/Drizzle schema exists, DB tables appear as a distinct card style with type↔table links — connecting the app to the DB visualizer experience that inspired this project

### 6.4 Overview & guided tours
- **Overview page:** what this app is, the parts, tech stack, 10 most important files, suggested tours, headline stats (routes, types, external services)
- **Walkthrough primitive** (the AI-narration delivery mechanism, Ilograph-style): a sequence of steps, each = {highlight set, zoom target, explanation paragraph, code snippet in bottom drawer} with Back/Next stepper. Users can detour and resume
- **Auto-generated tours:** "Welcome to your codebase" (5 steps, first-open onboarding); "What happens when…" flows traced from each major entry point (signup, checkout, webhook received)

### 6.5 Universal node detail panel
Any node click → right panel: AI summary, provenance-labeled facts, "connects to" chips, "Explain like I'm new" (spawns a scoped walkthrough), "Open in editor" link.

### 6.6 Security insight badges (promoted to v1.0)
The security-relevant subset of the insights layer ships in v1.0 — for the primary persona this is arguably the most valuable output of the whole tool:
- **Auth coverage:** every route badged protected/unprotected, with *what* protects it (middleware matcher, Clerk/NextAuth/Supabase auth). Boundary view gets an "unprotected doors" filter; a route with no auth on a data-writing path gets a warning badge
- **External data flows:** "your app sends data to these N companies" — the statically-derived external-services inventory, one click from the boundary view
- **Secrets/config inventory:** every env var read, where it's read, and whether it's documented in `.env.example`
- All statically derived (provenance: code, not AI) — these are facts, not guesses. Non-security insights (unused code, health skin) stay in v1.x

## 7. Agent integration (how Claude Code / Codex / Cursor interact with the atlas)

Two directions, deliberately staged:

**v1.0 — the atlas is agent-readable (nearly free to ship):**
- The atlas model is plain SQLite + JSON export; any agent can already query it
- `app-atlas export --md` writes `ATLAS.md`: a compact, token-efficient summary (app overview, boundary inventory, module map, key types) that users drop into CLAUDE.md / AGENTS.md / Cursor rules. This gives agents the same "map before the territory" benefit that aider's repo-map proved out — and it markets the tool inside every agent session
- Docs include a recipe: "make your agent atlas-aware in one line"

**v1.1 — MCP server (`app-atlas mcp`): ✅ shipped ([#42](https://github.com/nhorto/App-Atlas/issues/42), see section 13):**
- Works with every MCP client (Claude Code, Cursor, Codex, etc.) — one integration, all agents
- The compelling loop: the agent edits code → watch mode re-analyzes → the agent queries the *updated* atlas to verify its own change ("does this new route have auth?"). Atlas becomes the agent's ground-truth map, not just the human's
- Not in MVP because the export file delivers 60% of the value at 5% of the effort, and MCP tool design will be better informed once the model is stable — which is what happened. The six that shipped are `unguarded_doors`, `list_doors`, `what_calls`, `where_is`, `data_stores` and `env_vars`, not the `get_overview`/`trace_flow`/`impact_of` sketched here: those were guessed at before the model existed, and the ones chosen against a stable graph are the ones it can answer without hedging

## 8. v1.x — near-term follow-ons (spec'd, not built in v1.0)

- **"What changed" overlay:** after an agent session, familiar map with added nodes glowing green, modified amber, removed ghosted + AI changelog paragraph. Uniquely valuable to this audience; strong candidate for the killer feature of v1.1. (`--watch` already gives the live version a foundation.)
- ~~**MCP server**~~ **shipped** (see 7 and the build log)
- **Remaining insight badges:** "unused export/file" (knip-style), dead-code report, dependency risk. (Security badges shipped in v1.0 — see 6.6)
- **Health skin:** same map geometry, recolored by size=LOC / color=churn. One toggle, no new layout.
- **Share/export:** static HTML export of the atlas to share with a collaborator.
- **Cross-package monorepo tracing** (see 5.6)

## 9. Explicitly out of scope (v1)

- Runtime tracing (AppMap-style) — accuracy gold standard, adoption killer; maybe a later "verify the map" add-on
- Sound call graphs — we ship pragmatic reference edges with confidence labels
- Hand-editing/authoring diagrams — everything derives from code (hand-drawn maps rot)
- 3D/"software city" views, DSM/matrix views — wrong audience
- Hosted/cloud analysis, GitHub App — local-first for v1
- Languages beyond TS/JS + Python

## 10. Build milestones

1. **M1 — Skeleton: ✅ done.** CLI + TS analyzer (files/functions/types/imports) + atlas model + architecture map with drill-down (no AI). *Proves the core interaction on real repos.* See section 13.
2. **M2 — Boundaries & badges: ✅ done.** Framework plugins + boundary detectors + boundary view with Sankey bands + security insight badges (auth coverage, external services, env inventory). *Proves the differentiator.* See section 13.
3. **M3 — Words: ✅ done.** Provider-agnostic AI enricher (agent-CLI passthrough first, then API keys) + overview page + hover cards + detail panels + trust labels + `app-atlas init`. *Proves the explanation ladder.* See section 13.
4. **M4 — Types & tours: ✅ done.** Type explorer (including database tables) + walkthrough primitive + auto-generated "what happens when…" tours + `app-atlas export` writing `ATLAS.md` for agents. *Proves the map can explain itself.* See section 13.
5. **M5 — Freshness & Python: ✅ done.** Incremental re-analysis, `--watch` with live updates, the Python analyzer, and monorepo scopes with a switcher. *Proves the map can keep up with the agent writing the code.* See section 13.

Each milestone is testable against real agent-built repos (dogfood on Nick's own projects).

## 11. Resolved questions (round 1)

| Question | Resolution |
|---|---|
| Name | **App Atlas** — locked |
| Business model | **Fully open source** |
| AI provider | **Provider-agnostic from day one**; agent-CLI passthrough (Claude Code / Codex / OpenCode) is the flagship backend, API keys and local models also supported |
| Monorepos | Workspace detection + per-app atlas scopes with a switcher in v1; cross-package tracing in v1.x *(decision delegated to Claude)* |
| Insight badges in v1.0? | **Yes — the security subset** (auth coverage, external data flows, secrets inventory); rest in v1.x |
| Audience | Both: non-coder builders (primary) + professional developers (secondary); facts precise, narration optional |
| Agent interaction | `ATLAS.md` export in v1.0; MCP server in v1.1 *(decision delegated to Claude)* |

## 12. Remaining open questions

1. **Distribution & repo:** GitHub org/repo name still open. License: **MIT** (chosen — ecosystem default, simplest; recorded in `package.json`).
2. ~~**Onboarding cost UX:**~~ **Resolved (M3): ask only when it costs.** A subscription the user already pays for is free at the margin, so a prompt buys them nothing and trains them to hit Enter without reading; the run says afterwards what wrote the descriptions and that there was no charge. A metered API key blocks first, with the number of items, an estimated token count, an amount in dollars rounded up, which key is in play, and a line saying names and paths are sent but file contents are not. Non-interactive runs decline rather than spend, and `--ai-yes` approves in advance.
3. ~~**Naming the CLI:**~~ **Resolved:** `atlas` is taken on npm, `app-atlas` is available and is now the package name.

## 13. Build log

**M1 — Skeleton: ✅ complete (2026-07-25).** CLI (`app-atlas` / `analyze` / `serve`), TypeScript-JavaScript analyzer on ts-morph, SQLite atlas model on Node's built-in `node:sqlite` (no native dependency), and the drill-down architecture map (React Flow + elkjs). 12 end-to-end tests green.

Decisions made during the build, worth carrying forward:

- **`node:sqlite` instead of better-sqlite3.** Node 22.5+ ships SQLite in core, so `npx app-atlas` never compiles a native module on a user's machine — a real adoption risk removed. `engines.node >= 22.5`.
- **Reference edges come from checker symbol resolution, not `findReferences`.** Every identifier is resolved to its declaration and attributed to the enclosing function. Same practical answer, predictable linear cost, and it gives function-level "who uses whom" rather than file-level.
- **Pass-through folders collapse.** `src/app/(dashboard)/settings` renders as one box, not four empty ones. Keeps every level inside its readability budget without hand-tuning.
- **`--no-refs`** added as the escape hatch for very large repos (the reference pass dominates runtime).
- **Zones are computed in M1** (from path/extension conventions) and drive the map's colour language, one milestone earlier than planned. They become real container nodes in the boundary view (M2).

Measured on real repos: a 23-file project in 1.5s; an 80-file Next.js app in 0.9s; a 1,874-file / 6,606-function project in 37s (2,568 imports, 19,805 reference edges).

**M2 — Boundaries & badges: ✅ complete (2026-07-25).** Boundary detectors for both directions, the left→right boundary view as the home screen, and the security badges. Ten detectors covering Next.js (both routers, server actions, middleware), Express/Fastify/Hono/Koa, NestJS, tRPC, crons and queues, webhooks, CLI, realtime, env, file reads, Prisma/Drizzle/Kysely/Knex/pg/Mongoose/Supabase, browser storage, blob storage, outbound HTTP with literal-URL resolution, and an SDK/hostname service catalog.

Decisions made during the build, worth carrying forward:

- **Detectors report findings; a separate pass builds nodes.** No detector may create an atlas node. Forty Stripe call sites in twelve files have to become one Stripe box, and only a project-wide merge can do that — the same reason a middleware matcher in `middleware.ts` can lock a route declared elsewhere. Language plugins return raw findings; `boundaries/build.ts` merges them once for every language.
- **Guard confidence is carried to the badge.** A check found *inside* the handler is `certain`; one found elsewhere in the file, or matched through an approximated Next.js middleware pattern, is `likely`. The UI says "likely · Clerk" rather than rounding up to "protected". Telling someone a route is safe when it is not is the worst failure mode this product has, so under-claiming is the default everywhere.
- **A function-scoped guard never covers its neighbour.** A `route.ts` exporting a public `GET` and an authenticated `POST` is the common case; attributing the `POST`'s `auth()` call to the `GET` would be exactly the failure above. Guards attach by exact handler id, and only fall back to file scope when no precise handler was resolvable (a page component, say).
- **Detectors are gated on the project's own dependencies.** `db.select(...)` in an app with no `drizzle-orm` dependency is somebody's array helper, not a database call. An invented box on the map is worse than a missing one.
- **Auth coverage is measured over reachable doors only.** Crons, queue workers, the CLI and config reads are excluded — counting them as "unprotected" would inflate the number that matters and teach people to ignore it.
- **Boundaries live under two real container nodes** (`zone:inbound`, `zone:outbound`) rather than in a side table, so they appear in search, the detail panel and the drill-down map for free, and M4's `ATLAS.md` export gets them without new plumbing.
- **The Sankey is hand-rolled SVG, not d3-sankey.** The spec named d3-sankey, but d3-sankey sizes nodes by flow, which fights the fixed-size readable cards section 6.1 asks for. Ribbons are ~40 lines of geometry; cards stay ordinary HTML buttons sitting on top. One fewer dependency and exact control over the "max 8–10 per side" rule.
- **Config files are a first-class source.** `vercel.json` crons, the engine and table list in `schema.prisma`, and `.env.example` say things no AST walk would. A cron whose path matches a route folds into that route rather than appearing twice.
- **Browser storage counts as a data store.** An app whose only store is `localStorage` keeps its data on one device and loses it when the cache is cleared. Found this on a real dogfood project that otherwise reported no storage at all.
- **Fixed an M1 CLI bug:** the default command and the subcommands share flag names, and commander treated the shared ones as global, so `app-atlas serve . --port 5000` and `analyze . -q` silently used defaults. `enablePositionalOptions()` fixes it.

Measured: the boundary pass adds roughly 10% to analysis time. The M2 fixture (9 files) in 0.5s; an 80-file Next.js app in 1.5s, finding 39 doors, 36 unprotected routes, 1 external service and 2 stores.

**M3 — Words: ✅ complete (2026-07-25).** The explanation ladder end to end: docstrings verbatim, generated text only for the gaps, three trust tiers on screen, stale-docstring detection, the overview page, hover cards on the map, explain-on-click, and `app-atlas init`. Backends: Claude Code, Codex CLI and OpenCode through their headless modes; Anthropic and any OpenAI-compatible endpoint (which covers OpenAI, OpenRouter, Ollama and LM Studio) by key. 16 new tests, 43 in total.

Decisions made during the build, worth carrying forward:

- **Ask only when it costs** (section 12, question 2). The prompt is triggered by `billing === 'metered'`, not by "AI is about to run". A user with a subscription is never interrupted; a user spending an API key always is.
- **Installed is not the same as working.** Every backend answers a throwaway question before it is trusted. This is not defensive programming for its own sake: a signed-out agent CLI exits zero and prints "Not logged in · Please run /login" to stdout, and without the probe that sentence becomes the description of forty files. Found on the first real run.
- **The spawned CLI's environment is scrubbed.** App Atlas is often run from inside an agent session — that is the audience — and a parent session exports variables that point a child CLI at a gateway holding none of the user's credentials. Session markers are always removed; redirection variables only when a parent session is detected, so a user's own proxy config survives.
- **Requests are batched, and replies are keyed by position.** A dozen files per request is what makes agent-CLI passthrough viable at all: one process start for twelve descriptions instead of twelve. **But models key their answer by the most human-looking identifier on the line whatever the prompt says** — Codex returned `{"src/lib/db.ts": …}` when asked for `{"1": …}`. The prompt now states the key explicitly *and* the parser accepts the path as an alternate. Both were in the prompt, so neither can smuggle in a node we never sent.
- **The cache key is a hash of the facts we send, not of the file.** Slightly stricter than "keyed by node hash": reformatting a file's internals does not change what its one-line description was derived from, so it does not re-bill either. A fully cached project never starts a backend process at all.
- **A generated sentence never displaces a docstring**, at any tier, in any order. The ladder is enforced in one function so it cannot be forgotten in a new code path.
- **Staleness is sticky.** It is detected by comparing consecutive runs, so a docstring that went stale three analyses ago looks unchanged now; comparing only the latest pair would quietly forgive it. The flag survives until the docstring itself is rewritten, which is the only event that can resolve it.
- **Only the on-click tier sends source code.** Bulk passes send names, paths and exports. A function's purpose is genuinely not recoverable from its signature, so the detail panel does send the body — and the button says so before it is pressed.
- **Sentence-splitting must not split on a dot inside a word.** "Reads config from next.config.js and applies it" was being truncated to "Reads config from next" — not a shorter description, a wrong one. Caught by a test written for something else.
- **A pass that runs and produces nothing has to say so.** Silence reads as "there was nothing to describe", which is the opposite of what happened.

Measured, against a real Codex CLI on a subscription: the 9-file M2 fixture enriched in 21s (23 descriptions, 3 requests), and a second run over unchanged code did no work at all. The app paragraph named the real routes, the real companies and the real table names.

**M4 — Types & tours: ✅ complete (2026-07-25).** The type explorer with field-level links and database tables read out of `schema.prisma`; the walkthrough primitive; auto-generated "welcome" and "what happens when…" tours; and `app-atlas export` writing `ATLAS.md` for coding agents. 20 new tests, 63 in total.

Decisions made during the build, worth carrying forward:

- **A link between two types records the field that made it.** The reference pass already knew that `Order` mentions `User`; it now notes the enclosing property name when the identifier sits in a field's *type annotation*, which is what lets a card draw its line out of the row that actually holds the reference. Only annotations count — a property initializer that happens to call something is not that property pointing at a type.
- **Database tables are `type` nodes, not a new node kind.** A table is a named thing with typed fields, which is exactly what the type explorer draws, so `typeKind: 'table'` means every view that already understands types understands tables for free. The schema file joins the folder tree like any other file, which gives its tables somewhere to live.
- **`///` is a docstring.** Prisma's own comment convention is read verbatim, exactly like JSDoc, so a documented schema never needs a generated description.
- **A shared name is a link of its own kind.** A `User` table and a `User` interface are usually the same idea, and saying so is useful — but the compiler never said it, so a name match is drawn dashed, labelled "same name only", and *never enters the atlas itself*. Confining the guess to one view keeps the facts layer clean.
- **Tours are traversals, not essays.** "What happens when someone posts to /api/checkout" is door → handler → what it reaches → where it lands, walked over the existing edges. Nothing calls a model, so tours are free, work offline, work under `--no-ai`, and cannot go stale. Every step body is compiler fact; a docstring or generated sentence rides along as a labelled *quote* rather than being blended into the narration.
- **A webhook is not called by the framework that found it.** `meta.framework` is the detector's convention; "Next.js calls your webhook" is simply false. Small phrasing bugs like this are how a tool loses a reader's trust in everything else it says — the same reason "5 parts at the top level" was fixed to stop counting the two boundary containers as parts of the code.
- **Framework-positional filenames get their folder back.** `route.ts` four times in a row tells the reader nothing, and neither does `types.ts` twice; names are disambiguated within whatever list they appear in.
- **The export marks generated sentences `(ai)` and caps every list.** An agent reading `ATLAS.md` should weigh its own species' output accordingly, and a map that does not fit in a context window is not a map. 5 KB for a 75-file project. Webhooks and crons get their own short section: nothing outside can knock on them so they never appear in the auth table, but code that runs on its own is exactly what an agent about to make a change needs to know about.
- **A card that reports its own size is what gives React Flow per-row handle positions.** Telling React Flow a node's dimensions up front (as the map does, to avoid a measurement flash) skips the measurement that registers where each field row's handle sits — and every field-level line is then silently dropped. The type explorer sizes through `style` instead.
- **Fixed a Windows bug on the way through:** a checkout with CRLF line endings left `\r` at the end of every line, so any `$`-anchored pattern matched nothing. That read as "this schema has no documentation" rather than as the bug it was. Config readers now split on `/\r?\n/`.

Measured: the M2 fixture (10 files, 3 tables) produces 6 tours and a 2.7 KB `ATLAS.md`; App Atlas itself (75 files, 194 types) produces 60 type cards with 58 links and a 5.5 KB export. Neither costs a model call.

**M5 — Freshness & Python: ✅ complete (2026-07-25).** Incremental re-analysis behind a per-file cache, `--watch` with live updates in the open page, the Python analyzer as the second language plugin, and monorepo scopes with a switcher. 28 new tests, 91 in total.

Decisions made during the build, worth carrying forward:

- **The unit of caching is one file's whole contribution.** Its nodes, the edges that start inside it, its boundary findings and the offsets of its declarations, stored under a hash of its text. This works because every edge a file produces starts inside that file — an import it wrote, a reference from one of its own functions — so slices restore in any order and never collide. The refactor that made this true (accumulate per file, not into one pile) was worth more than the cache itself.
- **Editing a file also invalidates whatever imports it.** Renaming an export changes the id its callers point at, and only re-reading those callers can notice. One hop is provably enough: a reference cannot cross a module boundary without an import. The test that matters checks the files that were *not* edited.
- **A blunt project-wide fingerprint beats a clever one.** The tool version, the analysis flags, the dependency list the detectors are gated on and the contents of tsconfig are folded into one hash, and when it moves the whole cache is discarded. Working out which files a newly-enabled detector would have changed is harder than reading them all again.
- **`cache: 'off'` exists because a library must not write to someone's project.** Analysis used to touch no disk at all; adding a cache quietly changed that, and the tests were the first thing to notice by leaving `.app-atlas` directories in the fixtures.
- **Watch mode never asks about money.** A consent prompt that appears mid-edit, repeatedly, is not consent — it is a key someone learns to mash. A metered backend is declined and told to run an explicit analysis; a subscription is unaffected, because it never reaches the question. Same rule as section 12 question 2, applied to a case that did not exist when the rule was written.
- **A rebuild that finds a new unprotected route says so immediately, in yellow.** This is the whole product in one line: the agent added a door, and the human watching found out in 0.3 seconds rather than in an incident.
- **Server-sent events, not a websocket.** The traffic only goes one way, it is a dozen lines over the http server that already exists, and the browser reconnects by itself when the CLI restarts. The page discards what it had and refetches rather than merging: the server is the truth, and a half-refreshed screen is worse than a second of loading.
- **Python is read by Python.** Shelling out to the project's own interpreter is the only way to be sure the parse agrees with the interpreter, and a Python project you can run is a Python project that has one. `extract.py` reports what is *written* and resolves nothing; deciding which file a name lives in happens on the Node side, where the whole project is in view. Same probe-before-trusting rule as M3's agent CLIs, and for a sharper reason: on Windows a bare `python3` is usually a Microsoft Store stub that prints an advertisement and exits zero.
- **Python's cross-file edges are `likely`, and that is the honest answer.** There is no checker; a name is matched through the import that introduced it. Inside one file that is as good as certain, across files it is an inference. The same restraint applies to `Depends(get_current_user)` — a guard, but never a certain one. Section 5.7 promised the model would tolerate per-language depth differences; this is what that looks like in practice.
- **Python gets its own zone table.** `app/` is a Next.js router in one ecosystem and simply the package name in the other. Sharing the JavaScript rules would paint a whole Django backend as interface code, and a colour that is wrong once is a colour nobody trusts again.
- **A monorepo is N atlases, each beside its own app.** One map of six apps is the hairball this tool exists to avoid. Each scope keeps its atlas and its cache in its own directory, so `app-atlas apps/web` alone is the same operation as a single-app repo — only a small manifest at the workspace root knows they are related. One package in a workspace produces no scopes at all, because a switcher with one option is a control that does nothing.
- **Switching app clears the screen.** It is closer to opening a different project than to changing a filter; keeping the breadcrumb would point at folders that do not exist.

Measured: App Atlas itself (92 files) analyzes cold in 4.1s and warm in 0.3s, producing a byte-identical atlas. A watch-mode rebuild after adding one route is 0.3s. The Python fixture (5 files) is read, linked and badged in under a second.

The last two screenshots — the Data view and a walkthrough step — landed on 2026-07-25, so every view in the README now has a picture.

**Polish pass — dogfooding & identity: ✅ complete (2026-07-25).** The tool was pointed at three real repos it had never seen — an Expo + Supabase app, a Next.js localStorage app, and itself — and everything that looked wrong was fixed. In the same pass the web app traded its stock dashboard look for an identity of its own. 93 tests.

Decisions made during the build, worth carrying forward:

- **The app is set like the thing it is named after.** Warm paper, ink, serif display faces that ship with every OS (offline is a feature), and one terracotta accent used the way a printed map uses red — to mark the route and nothing else. Colour still only ever means zone. The single biggest de-generic move was un-boxing things: the overview's six identical stat cards became one almanac-style figure strip, and the lede became a real paragraph, because it is the one thing on the page meant to be read.
- **Never gate on a signal a library does not actually send.** The map waited for React Flow to report its nodes measured before framing the view — but nodes that arrive pre-sized from elk are never reported as measured, so the map simply never framed itself, and nobody had noticed because the unframed layout often looked plausible. The fit now keys off our own state. The data view had the mirror-image bug: one initial fit aimed at a pile of cards that the async layout then moved. Both were invisible until a screenshot of a *real* repo put a card half off-screen.
- **The tables a Supabase app queries are its data, schema file or no schema file.** The data view drew only `schema.prisma` tables, so the audience this tool is for — an app built on Supabase — opened "Your data" and found theme props where its `cellar_bottles` should be. Every table the code names in a query is now a shape of its own, with reference edges from the files that touch it. Columns are unknowable without a schema, and the card says "named in queries · columns unknown" instead of inventing them — same rule as guard confidence: under-claim, always.
- **A `Deno.serve` under `supabase/functions/` is a door nothing in package.json announces.** The security page told a Supabase app it had no routes at all while its edge function sat on the public internet. The platform's default JWT check is reported `likely`, never `certain`, because a config file we may not see can turn it off.
- **Two guards in one file must merge, not crash.** A platform default plus an in-handler auth call — the exact shape of a well-written edge function — produced two identical `protected-by` edges and a UNIQUE violation. The first real Supabase repo the tool ever met found a crash the fixtures could not, which is the whole argument for dogfooding.
- **The fixture caught up with reality.** It now contains the two-guard edge function and an undeclared `page_views` table, so the crash and both features are pinned by tests rather than by memory.

Measured: cork-and-note (107 files, Expo + Supabase) analyzes in ~2s and now shows 3 ways in, 14 observed tables with per-file usage counts, and 4 stores. The README's seven screenshots were retaken so the first thing a stranger sees is the product that actually ships.

**M6 — Go, and the seam that makes the next language cheap: ✅ complete (2026-07-30).** `src/analyze/generic/`: one extractor over tree-sitter grammars, driven by a per-language query file and a small dialect, with Go as the first and deliberately the only language on it. 24 new tests, 285 in total. Closes the one axis on which every neighbour was ahead (see [GAPS.md](docs/GAPS.md) gap 1).

Decisions made during the build, worth carrying forward:

- **The seam is a capture vocabulary, not a class hierarchy.** A `.scm` file says which of a language's syntax answers to `@def.func`, `@import`, `@call`, `@bind`; `extract.ts` turns those captures into the same flat record `extract.py` produces, and never mentions a language. Everything that needs to know *what a thing is inside* — a call's scope, a struct's fields, the names a function mentions — is answered by character ranges, because containment is the one structural fact every grammar spells the same way.
- **The merge layer needed no changes at all, and that was the bet.** Go route prefixes compose through the machinery written for FastAPI's `include_router`; a Go middleware is decided to be a check by the rule that decides it for a NestJS guard. `boundaries/build.ts` has never known what language a finding came from, and this is the proof. What is language-specific is *extraction*, not reasoning.
- **WebAssembly, and the grammar is committed.** The native tree-sitter bindings mean a compiler toolchain on the machine of anybody who types `npx app-atlas`, and the grammar's own npm package carries an install script that can fall back to compiling C. 212 KB of `.wasm` is taken out of a pinned tarball, checked against a recorded hash by `npm run grammars`, and shipped with its licence. Nothing compiles at install time and nothing needs a network at analysis time.
- **A middleware is a check because of what it writes.** `r.Use(Logger)` and `r.Use(RequireAuth)` are the same line of code; only one of them puts a 401 or a 403 on the wire. Followed up to three calls deep in the same file, because real auth code hands off — gotify's `RequireClient` calls `evaluateOr401`, which calls `abort401`, and only the last of the three has a number in it. Reading one function reported all forty-four of that server's routes as unchecked.
- **A function that registers routes is wiring, and wiring is never a check.** It names every middleware it attaches, so letting the chain run through it made PocketBase's `bindBackupApi` a "check" — and then every handler in that file looked protected by the whole file's worth of locks, whichever route it actually sat on.
- **`[].every(…)` is true, and that had turned "no handler" into "every handler".** A door whose handler we cannot identify used to inherit every check in its file. `mux.Handle("/debug/vars", expvar.Handler())` was reported as protected by a middleware standing in front of the route on the line above it. "We could not find the handler" and "the handler is the whole file" are different statements and now give different answers.
- **The router's *type* is the evidence, not the library.** Every Go repo past a certain size stops building its router in one file and starts passing it in — `func registerRoutes(m *web.Router)` — and half of them wrap it in a type of their own first. A rule that knows the package names of four libraries reports gitea's and PocketBase's entire HTTP API as not existing.
- **A `_test.go` route is not a door, and this is not a heuristic.** The Go toolchain does not compile `_test.go` into the binary, so the address genuinely does not exist in anything anybody deploys. Elsewhere the pipeline deliberately keeps doors found under folders named `test`, because a folder name is a guess; a build rule is not.
- **`github.com/go-chi/chi/v5` is typed `chi`.** Semantic import versioning puts the major version in the path and leaves it out of the name. Taking the last segment gives a package called `v5`, after which `chi.NewRouter()` matches nothing and a chi service reports no routes at all — a one-line bug that would have looked like the whole tier not working.
- **The header had to stop claiming a type checker.** `ATLAS.md` opened with "facts are derived by each language's own parser and type checker", which stopped being true the day a grammar could answer for a language. Every node from this tier carries `tier: 'tree-sitter'`, and the export and the CLI both say what that costs.

Measured, on three Go repos the tool had never seen and with no repo-specific code in it:

| Repo | Files | Routes found | With their check | Time |
|---|---|---|---|---|
| gotify/server (Gin) | 208 | 48 | 31 — the 17 left open are health, docs, swagger, version, the static assets and the three OIDC sign-in doors | 0.8s |
| pocketbase (its own router) | 644 | 53 | 39 | 2.7s |
| go-gitea/gitea (its own router) | 3,265 | 773 | 182 | 7.8s |

**M7 — Reachable, and able to say what changed: ✅ complete (2026-07-31).** Five pieces of work that mostly close [GAPS.md](docs/GAPS.md): the package is installable, the Go tier reads the shapes real Go services are actually written in, two more filesystem-routed frameworks are on the map, and a run can be compared against the one before it. 42 new tests, 327 in total.

Decisions made during the build, worth carrying forward:

- **Every other gap was theoretical until the install was one command.** `git clone && npm install && npm run build` is not something the person this is built for will do, and every neighbour in [LANDSCAPE.md](docs/LANDSCAPE.md) is a single line. Publishing from a tag with provenance, a `files` allowlist that ships the build rather than the fixtures, and a tarball proved by installing it into an empty directory and running it — not by reading the manifest and hoping.
- **A module path can name a directory, and only some languages know it.** `Builds.childOf` reads it as a file first — Python and TypeScript spelling, and the more precise of the two — and falls through to reading it as a folder only when no file answers. That ordering is the whole safety argument: a language whose imports name files never reaches the looser rule, and "exactly one candidate or nothing" is unchanged.
- **Echo names the handler first because its middleware is variadic.** `GET(path, h, m...)` cannot be written any other way, and gin, the standard library and every one-argument router do the opposite. Reading Echo the gin way did not merely misfile the handler: it pointed the door at a logger and badged the guard `certain`, because a check sitting on the handler's own node is something the code states outright — and the "handler" was the checker. The lock was real and the reason given for it was invented, at the highest confidence the tool has.
- **A `handle` hook guards the path it tests, not the site it runs on.** SvelteKit's `hooks.server.ts` runs before every request, and almost everything in a typical one is a lookup rather than a lock. Reading it as site-wide would badge every open door in an app protected on the strength of one `if`. The same reasoning keeps a redirecting layout from claiming the pages beneath it, and keeps a redirect in a universal `load` — which runs in the browser — from counting as a check at all.
- **The dependency gate is exact, never a prefix.** `react-router` is in half the single-page apps ever written and routes inside the browser, where no file is a door; the declaration that matters is the framework-mode package. A prefix match on `@remix-run/` would have put a Remix label on a Django app that happened to depend on `@remix-run/router`.
- **The ids are not content-addressed, and the endpoint hash does not cover its guards.** Both were assumed at the start of the diff work and both are false: an id is a path or a `path#name`, and an endpoint's hash is built from `('endpoint', id, siteCount)`. A route whose auth check is deleted is therefore byte-identical to the run before — so the obvious implementation, diffing hashes, would have silently reported nothing for the single most important thing this feature exists to catch. Doors are compared field by field, and the test asserts the hash equality first so a future shortcut fails loudly instead of going quiet.
- **The baseline is the last run's atlas, not a second copy of it.** `atlas.db` already holds it until `persistAtlas` overwrites it. A `previous.db` would duplicate a fact we have and need its own answer to "was this written by the run I think it was". Both traps then fall out for free: only a completed run replaces the baseline, so a crash cannot poison it, and `--fresh` clears the file cache only.
- **"No baseline" is not "nothing changed", and neither is "everything is new".** Three states, kept distinct because they are three different sentences — and an atlas from a different tool version reports the reason rather than four hundred additions.
- **A repo's own router type is the evidence.** `web.NewRouter()` is not `chi.NewRouter()`, and a house wrapper matched no framework and emitted no router at all — so gitea's entire `/api/v1` surface was absent from the map. Reading the enclosing function's written return type is the same evidence the parameter rule already trusted, read at the other end. Two guards on it are load-bearing: the package must be one the file imported, and the constructor must come from the package that declares the type. `New` is close to the most common function name in Go, and a rule that asked only about the return type would make a router out of every logger opened inside a function that hands a router back.
- **A count going up proves nothing; the list is what proves it.** Every measurement below diffs door *lists*. On gitea, 179 addresses disappeared — and all 179 came back correct, 175 of them wearing the `/api/packages` prefix the mount fix could finally attach and the rest under `/v2/`. Read as a count, that change is a 24% loss.

Measured on the same three Go repos, before and after, by diffing door lists:

| Repo | Doors before | Doors after | Corrected | Genuinely new |
|---|---|---|---|---|
| gotify/server (Gin) | 50 | 50 | 0 | 0 |
| pocketbase (its own router) | 55 | 55 | 0 | 0 |
| go-gitea/gitea (its own router) | 757 | 1,053 | 179 | 475 |

Both limits M7 left open have since been closed. What each turned out to be is worth more than the fact that it was fixed.

**#60 — a prefix written as a name, and the router standing behind it: ✅ fixed (2026-07-31).** Two doors in gitea's map printed `PUT /{artifact_hash}/upload` and `GET /{artifact_id}/download`: the prefix missing and the address still looking complete, which is the one failure worse than a blank. Chain composition was never the gap — `mounts.ts` has walked multi-hop mounts since [#33](https://github.com/nhorto/App-Atlas/issues/33), and has resolved a prefix written as a name for as long as FastAPI's `prefix=settings.API_V1_STR` has been read. What was missing was on the Go side, and it was three things:

- **An address written as a name was read as no address at all.** `m.Group(artifactRouteBase, …)` was matched only against string arguments, so a prefix declared as a constant twenty lines up contributed nothing and was dropped in silence. Carried as `prefixName`, the merge layer either resolves it or prints `…`, and the second outcome is the point: a gap says there is more in front, where a short address says there is not.
- **The first name on a `Mount` line is not always the router.** `r.Mount(prefix, actions.ArtifactsRoutes(prefix))` puts two names on one line, and reading the first as the child pointed the mount at a router called `prefix` that nothing builds — losing the prefix *and* the link to the routes behind it in one go. `Mount(pattern, handler)` is the signature every Go router carrying the method writes, so the address comes first whether it was spelled out or named.
- **Only path-shaped constants join the index, and that filter is load-bearing rather than tidy.** The index is keyed by bare name across the whole repo. gitea declares `prefix = "gitea-gitignore"` in a build script, and unfiltered that is the one repo-wide answer for the `prefix` its actions router mounts under — which would have turned ten honestly partial addresses into ten confidently wrong ones. The fix would have re-created the bug one layer down.

Measured the same way, by diffing door lists on the same three clones: gotify and PocketBase byte-identical, gitea 1,051 doors before and after with ten addresses corrected and none added or lost. The three v1 artifact doors now read `…/_apis/pipelines/workflows/{run_id}/artifacts/{artifact_id}/download` — which is the address gitea's own comment says they answer at, with `…` standing in for the `/api/actions_pipeline` that a variable reassigned three times in one function cannot honestly be pinned to.

**#58 — a busy machine is not a machine with no Python on it: ✅ fixed (2026-07-31).**

- **A blank the reader is told about costs less than a silent one.** The probe waits thirty seconds now rather than five, but the number was never the bug. The bug was that "no interpreter is installed" and "an interpreter was found and the machine would not let it answer" arrived as the same silence, and only the first is something the reader can go and fix. They are now two different sentences, carried on every unread file rather than only in a warning — and a machine with no Python still fails in milliseconds, because the operating system refuses to start a program that is not there and says so immediately. Patience only costs the machines that were already misbehaving.
- **Zero doors is only good news when somebody looked.** A Python project read without a Python reader has no routes at all, and the security screen, the CLI headline and the exported brief all reached for "nothing here answers a URL, so there is nothing to protect" — the most confidently wrong sentence in the product, produced by the analyzer having its eyes shut. All three now say what they could not read, before the numbers that depend on it.

**MCP — the map, answered instead of pasted: ✅ complete (2026-07-31).** `app-atlas mcp`, closing [#42](https://github.com/nhorto/App-Atlas/issues/42) and the agent-facing half of section 7. Six tools over the `AtlasGraph` that already existed — `unguarded_doors`, `list_doors`, `what_calls`, `where_is`, `data_stores`, `env_vars` — in `src/mcp/`, four files and no new dependency. 38 new tests, 365 in total.

This is distribution, not analysis. Every neighbour in [LANDSCAPE.md](docs/LANDSCAPE.md) has been here for a year; the graph, the queries and the export were all already written. What was missing was a wrapper.

Decisions made during the build, worth carrying forward:

- **No SDK, and the numbers are the argument.** `@modelcontextprotocol/sdk` is the obvious choice and it installs 93 packages and 24 MB — express, hono, cors, jose, ajv, zod, eventsource, express-rate-limit, pkce-challenge — to give this command three methods and a `\n`. MCP over stdio is JSON-RPC 2.0 with one message per line; `initialize`, `tools/list` and `tools/call` are the whole surface a tools-only server needs, and the framing is `JSON.stringify` plus a newline. Everything that tree drags in exists for the transports we do not use: HTTP, SSE, OAuth, rate limiting. The same reasoning that put `node:sqlite` in over better-sqlite3 and a hand-rolled tar extractor in over a package with an install script applies exactly: the person this is for types `npx app-atlas`, and every megabyte between them and the map is a real cost paid by everyone to save one afternoon here. Revisit it the day this server needs to be reachable over HTTP, because that is the day the SDK starts earning its tree.
- **The server never analyses, and says so rather than doing it quietly.** Three reasons and any one of them decides it: an MCP client starts its servers at the beginning of a session and will not wait forty seconds for the first answer; analysis writes into the user's project, which a background process spawned by an agent has no business doing unasked; and on a metered backend the enricher asks about money, to a stdin that belongs to a protocol. So the tools read the atlas `analyze` wrote, and a directory nobody has analysed gets a sentence naming the command that fixes it.
- **An empty list is the failure this surface has to avoid.** "No atlas here" comes back with `isError` set and *no* structured content, because an agent handed `{"unguarded": []}` will report that the app has no unprotected routes — the single sentence this whole product exists to stop somebody saying to a customer. "Could not look" and "looked and found nothing" have to be distinguishable by the client, not by a sentence the model may skim.
- **"Nothing is unguarded" and "there is nothing to guard" are kept apart.** A library has no route a stranger can knock on, and telling its owner "everything is protected" answers a question they did not ask with a reassurance they did not earn. `authHeadline` already returns null for exactly that case, so the tool branches off the same function the CLI and the export branch off rather than testing `routes === 0` a fourth time.
- **stdout is taken away from the rest of the process.** Under stdio transport anything on stdout that is not a message is a parse error inside somebody's agent, reported as "App Atlas is broken". The things that write to stdout in a Node process are not all ours — a deprecation notice, a library's debug line, a `console.log` in a path nobody expected to reach. `claimStdout` captures the stream once, points `process.stdout.write` at stderr (which covers `console.log`, since that is what it goes through), and hands back the only door onto the real stream. Diverted rather than dropped: a person reading their client's server log can still see it.
- **Both halves of a result are the whole answer.** The text block is what lands in the transcript for a person to read and is the one field every revision of the protocol has; `structuredContent` is the same facts keyed the way `atlas.json` keys them. Neither is a summary of the other. No `outputSchema` is declared, because declaring one is a promise to conform to it on every future result and the text block is the contract that can actually be kept.
- **Provenance is repeated on every result, not stated once at the handshake.** A model reads the result in front of it, not the `initialize` it saw an hour ago. Each answer ends with which app answered, when it was analysed, that generated sentences are marked `(ai)`, and how to make it current — plus the tree-sitter tier's own caveat when a grammar rather than a compiler read the language. The staleness line is the one that earns its tokens: an atlas from before the agent's last three edits answers confidently and wrongly, and nothing else in a transcript says so.
- **A name that matches two things returns two things.** `what_calls("db")` could pick the highest-scoring `db` and be confidently about the wrong file. It returns the candidates and their ids instead. Same rule as everywhere else: the tool declines rather than guesses.
- **The atlas is re-read when its file moves.** Keyed on the mtime of `.app-atlas/atlas.db`, so somebody running `analyze --watch` in another terminal while their agent works gets answers about the code as it is now. That loop — agent edits, watch re-analyses, agent asks "does my new route have a check" — is the one section 7 predicted, and it only exists if the server notices.
- **The tool list is not the one section 7 guessed at.** `get_overview`/`trace_flow`/`impact_of` were written before the model was; the six that shipped are [#42](https://github.com/nhorto/App-Atlas/issues/42)'s, chosen against what the graph can actually answer without hedging. `unguarded_doors` is first because it is the one no competitor in LANDSCAPE.md answers at all.

Measured: the server answers `initialize`, `tools/list` and a tool call in one round trip each, cold, with three lines on stdout and nothing else; the whole end-to-end test — spawn, handshake, query, exit — is 0.3s.

**M8 — more doors: ✅ complete (2026-07-31).** Three gaps from [GAPS.md](docs/GAPS.md), all the same thing from different sides: a door the map could not see, or a door it saw and described wrongly. 26 new tests, 428 in total.

Two of the three are honesty fixes wearing a coverage label, which is the shape most coverage work in this project turns out to have — the number a reader acts on gets more accurate, and the count goes *down*.

**#39 — a cell that is not Python costs that cell, not the notebook: ✅ fixed (2026-07-31).**
`ETL.ipynb` in a real notebook repo opens with `pip install pandas`, no `!` in front of
it — a form IPython accepts and `ast.parse` does not. `strip_magic` blanks lines starting
with `!`, `%` or `?`, so that line survived into the flattened source, the parse failed on
line 1, and all twenty-one cells went dark. Three of that repo's ten notebooks hit it, in
a repo where the notebooks *are* the work.

The flattening still parses nothing. When the whole fails, and only then, each code cell
is re-parsed on its own and the ones that fail are blanked. There is no `pip` case and
there deliberately is not one: a cell is the unit the kernel itself compiles, so "would
not parse" is the entire mechanism, and the next repo's unreadable line is one nobody has
thought of yet. Blanked cells keep their exact line count, so every range in `cells` and
every line number below a bad cell still lands on the code the author wrote.

Two refusals matter as much as the fix. If every cell parses alone but the whole does not,
the fault is in how they join rather than in any one of them, and the original error is
raised rather than guessed at. If the rebuilt source still fails, that raises too and the
file is reported unread exactly as before — blanking everything would hand the reader a
notebook that claims to declare nothing, which is worse than saying plainly it could not
be read.

`meta.unread` is deliberately *not* set on a partially-read notebook. That flag means the
file was not read, and `exposure.ts` turns it into "whatever they declare is missing from
every number here" plus an `unreadable` verdict on every route importing it. For a
notebook where thirty-eight of forty cells are on the map, that sentence is false. Instead
each dark cell carries its own reason and the run says out loud how many went dark. The
residual risk runs the safe way: a guard hidden in a dark cell produces a false alarm,
never a false assurance.

Measured by diffing definition lists on ten real notebooks: 34 definitions before, 79
after, and the only entries that disappeared were the three `unread` markers themselves.
107 of the 111 cells the issue counted are read; four stay dark and say so. On a second
notebook repo, all twenty-three notebooks that read before still read with identical
function lists and line numbers, and six that were entirely dark came back.

**#40 — the door people sign in through, when it is an action: ✅ fixed (2026-07-31).**
`classifyOpenDoors` knew a sign-in *page* — the `auth-mount` rule, gated on a catch-all
route plus an auth package in the file — and knew nothing about a sign-in *action*. On
`vercel/nextjs-subscription-payments` that was five findings of eleven. A server action
that signs you in cannot require you to already be signed in.

The rule is evidence from the call, never from the name. `signInWithEmail` happens to be
well named; the next repo's will be `doLogin`. So the fact is the call into the auth
library: `authEntryForCall` in the catalog matches a library's published API against the
shape of the call, anchored on the namespace (`*.auth`, `*.api`) rather than the receiver,
because apps build their client in their own `utils/supabase/server.ts` wrapper and
`supabase` traces back to the repo rather than the package. That is the same reasoning
that already lets `*.auth.getUser` count as a guard, and the project's declared
dependencies are what gate it. Any dotted name containing an `admin.` segment is rejected
outright: `auth.admin.signOut` signs somebody *else* out with a service key, and that is
the last door in a repo that should stop being reported.

Only a function counts. A call at file scope would excuse every door the file declares,
and one sign-out button in a module of twenty actions is not a reason to stop reporting
the other nineteen.

Two decisions worth carrying forward:

- **No new `OpenKind`.** `auth-mount` already means "the door people sign in through" in
  all seven surfaces that word it — the tally, `publicRoutes`, the headline caveat,
  insights, the markdown export, the MCP reason phrase and both web badges. A new kind
  would have needed each of them taught a sentence they already say.
- **The `writes` qualification belongs, but `meta.writes` cannot carry it.** `http.ts`
  stamps `writes: true` on every server action the moment it is found, on the grounds that
  it might — so `!meta.writes` would have switched the rule off for exactly the doors it
  exists for. The graph is asked instead: a `writes-to` edge from the handler into a
  *store* disqualifies the door. Not a service, because a sign-out handler that posts to
  the auth provider it is signing you out of has not done anything beyond signing you out.

Measured: 37 routes, unprotected 11 → 4, public 1 → 8. Seven doors moved, none lost, none
gained. Still open and correctly so are `redirectToPath`, which calls nothing, and
`updateEmail` / `updateName` / `updatePassword`, all three of which call `auth.updateUser`
and need a caller already signed in. Door lists byte-identical on taxonomy, mealie, dub,
cal.com and midday — midday being the one that earns its place, a Supabase repo whose
`exchangeCodeForSession` route already carries a guard and whose `verifyOtp` action is
wrapped so it is not a door at all.

Deliberately left out: everything acting on a session that already exists, and
`supabase.auth.resend`, which is genuinely public. Omitting it keeps that door in the
alarm list, which is the cheap direction to be wrong in.

**#45 — the ports a deployment file publishes: ✅ built (2026-07-31).** The first door on
this map that no application code opens, and the seam the rest of infrastructure comes
through. A container port published by a Compose file is a listening socket with no handler
anywhere in the repo, so no amount of reading TypeScript or Python will ever find it. A
`postgres` service with `ports: - "5432:5432"` is a database reachable on the host, and
there is no auth check to look for because there is no code in front of it.

The distinction the whole feature turns on is one line wide:

```
ports:   - "5432:5432"   published on the host — a door
expose:  - "5432"        reachable only by the other containers — not a door
```

Reading the second as the first invents a door; reading the first as the second hides one.
Both are the same over-claim from opposite sides, so `expose:` is matched by name and
dropped on purpose rather than left to fall through a looser test that might one day widen.

Decisions worth carrying to the next infrastructure reader:

- **The subject of the sentence is the file.** There is no guard here, so there is no
  `certain`/`likely` to assign, and the honesty has to live in the wording instead. A name
  with no subject — "port 5432 open" — is read as a statement about a server. So the door
  reads `compose.override.yml publishes 5432 on every interface → db`: a statement about a
  file in this repo, which is all that was read. A Compose file is a description of a
  deployment, never evidence that anything is running.
- **Where it is bound is said in both directions.** `on every interface` and
  `on 127.0.0.1 only` are both spelled out, because leaving the common case unsaid makes
  its absence carry the meaning, and a reader fills that silence with the safer of the two.
- **They do not join the unguarded-doors count.** `AUTH_RELEVANT` is an allow list, so a
  new kind is excluded by construction — and that is the right answer rather than a
  convenience. A web server publishing 80 is the point, not a finding; counting these would
  hand every repo with a Compose file a row saying "nothing checks this" about a port
  nothing is supposed to check, which is the trained-to-skim failure `exposure.ts` exists
  to prevent.
- **The files are never merged.** `up` layers base with override, `-f prod.yml` replaces,
  and which files somebody runs together is not written down anywhere in the repo. Each
  declaration is a door against the file that made it. The fastapi template is the argument:
  `compose.yml` publishes nothing, `compose.override.yml` nine, `compose.traefik.yml` two,
  and one reconciled answer would be an answer no single file supports.
- **A port entry is kept as text and never resolved as a scalar.** Unquoted `22:22` is a
  legal YAML 1.1 sexagesimal integer, and a reader that resolves it returns 1342 instead of
  a port mapping. Not a hypothetical: the fastapi template writes `9323:9323` unquoted.
- **The reader is the repo's, not the app's.** App Atlas lands a large repo on its main app
  ([#34](https://github.com/nhorto/App-Atlas/issues/34)), and the first cut searched from
  there — so on three of six sample repos it started inside `backend/` or
  `packages/app-store/zoomvideo` and found nothing, while the reader exercised on its own
  found everything. The directory the user named is now carried down beside the one we
  narrowed to, sourced from the CLI because that is the only place the user's own argument
  survives. It is never derived by walking upwards: run `app-atlas ./backend` and `./backend`
  is the boundary. Search from the repo root, report paths against the app root, so a stack
  described above a scoped app reads `../compose.override.yml` — uglier, and it resolves.
- **A stack stood up for a test run is not a deployment description.** Decided with
  `classifyZone`, the classifier the rest of the tool already agrees on, rather than a list
  of directory names invented for this. The path decides, not the filename — so a root-level
  `docker-compose.test.yml` stays, because `test` there is the variant word in the
  `compose.<env>.yml` slot that `prod` and `dev` occupy.

Measured through the CLI rather than through the reader, which is the correction this issue
had to make twice: dispatch 2, full-stack-fastapi-template 11, mealie 4, cal.com 8, midday 1,
handson-ml3 2 — every one hand-checked against its source file, with `routes` and
`unprotectedRoutes` unchanged on all six, and taxonomy and requests byte-identical.

The `PublishedPort` shape says nothing about Docker on purpose. A Terraform security group
or a Kubernetes service produces the same row, so the merge layer and the sentence it writes
never have to learn a second vocabulary. Terraform is the next one through this hole.

**M8.1 — the brief is read by somebody who did not run it (2026-07-31).** Two loose ends from M8, both on `ATLAS.md`, and both the same mistake in different clothes: a sentence that is true for whoever ran the command and false for everybody else who reads it. 6 new tests, 434 in total.

**#73 — the ports were on the map and missing from the brief: ✅ fixed.** M8 taught the analyzer to read published ports and did not teach the export to print them, so a coding agent handed `ATLAS.md` — the surface built precisely so an agent can see the app without re-deriving it — was told about the HTTP routes and not about the postgres on 5432. The kind was not simply added to the existing `OTHER_DOORS` set, because that section is introduced by "a stranger cannot knock on them": true of a cron, false of a database published on every interface, and filing one under the other would have put a reachable port under a heading saying nothing can reach it. They get their own section, above the crons rather than below them, and the wording is the deliverable — the line leads with the file and its line number, so every claim is about a file in this repo rather than about somebody's server, and the section opens by saying it was declared and not observed.

**#69 — regenerating a committed map destroyed its own history: ✅ fixed.** `ATLAS.md` is committed; the baseline it compares against lives in `.app-atlas/`, which is not. So the section said "8 new doors since the last run" to readers with no way to know whose run that was — and anybody regenerating from a fresh checkout had no baseline at all, produced an honest "first run", and silently replaced real information with none in a diff that looked like an ordinary update. It had already cost a contributor an afternoon, who spotted the collapse and reverted rather than commit the loss.

The fix is to ask git whether it is tracking the file being written, and to write less when it is. Tracked is the right question rather than "is there a `.git` above this": almost every project this runs on is a repository and only some of them commit their map, and the moment somebody commits it the answer flips, which is exactly when it should. `--stdout` is never shared — it goes to whoever typed the command — and neither is a map nobody has committed, so both keep the full comparison.

What a committed map gets instead is a sentence, not a silence. Deleting the heading would let the next reader take its absence for "nothing changed", which is the failure the section was written against in the first place; so it says the comparison is machine-local, why that makes it unanswerable here, and which command answers it for you. The renderer is told rather than told to look: it is handed a graph and has no business asking the filesystem questions, and only the caller knows where the text is going.

The general rule, worth applying to the next export as well: anything in a shared artifact that depends on *who ran it, where, and when* has to be stated as such or left out. The MCP server (#42) solved the same problem from the other side, by putting provenance on every result — and that is the same rule, not a different one.

**M8.2 — where to look first, ranked rather than counted (2026-07-31).** The overview's opening suggestion sorted files by the number of edges touching them, which counts neighbours — a different question from the one the section asks, and the two come apart on exactly the files where it matters. 8 new tests, 442 in total. The first half of [#46](https://github.com/nhorto/App-Atlas/issues/46).

The interesting part was getting the direction wrong first, and only finding out by measuring. Textbook PageRank over an import graph sends a file's score to the things it imports, so a file ranks highly when much of the app depends on it. Built that way it returns the leaves: on this repo `util/paths.ts` and three files of type declarations; on Netflix's dispatch `enums.py`, `models.py` and `config.py`; on mealie a `datetime.py` helper and a `guid.py`. Every one of them genuinely depended upon, and not one a place to start reading — nobody understands an app by reading its type aliases. Two test fixtures made this repo's own top ten.

So the graph is reversed: a file collects score from what it *imports*, and ranks highly when it pulls together things that themselves pull together things. Measured the same way, that returns `analyze/index.ts` and `cli.ts` here; `api.py`, `main.py` and `cli.py` on dispatch; the repository factory and the recipe routes on mealie; the layouts and pages on taxonomy. Those are the files somebody opening the codebase should actually open.

Three rules keep the list honest, and all three are facts about a file rather than guesses about its name:

- **A file that declares nothing of its own** — a barrel, an `index.ts` re-exporting its folder — stays *in* the graph and out of the *answer*. Its score still flows through to whatever it re-exports; it is simply not the destination, because sending a reader there wastes the one click they were told to make. This is what keeps a barrel out, not the ranking: a file everything imports scores well whether or not it holds anything. Counted rather than matched against filenames, so a project whose barrels are called `mod.ts`, `__init__.py` or `exports.go` needs nobody to add it to a list.
- **Test files, on both ends of every edge.** A test imports a great deal on purpose, which under this direction looks exactly like wiring an app together.
- **A file that imports nothing is left out** rather than padding a short list. By this ranking's own logic it pulls nothing together and holds only the score every node starts with, so the tail would otherwise fill with whatever sorts first among files that scored identically — an arbitrary answer wearing a ranked one's clothes.

The number printed beside each file is *how many files it imports*, not the score. A score is a number about a graph and means nothing on its own; the count is a fact somebody can go and check. It is deliberately not what the list is sorted by, and the section's own sentence says so — otherwise the first entry looks like a mistake whenever a file that imports six things outranks one that imports twenty.

`OverviewView.busiestFiles` became `whereToLookFirst`, because a field still called "busiest" would have been the one thing in the atlas quietly describing the old answer.
