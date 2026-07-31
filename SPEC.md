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

**v1.1 — MCP server (`app-atlas mcp`):**
- Tools over the atlas model: `get_overview`, `find_boundaries`, `trace_flow(entry_point)`, `who_uses(symbol)`, `impact_of(file)`, `auth_coverage()`
- Works with every MCP client (Claude Code, Cursor, Codex, etc.) — one integration, all agents
- The compelling loop: the agent edits code → watch mode re-analyzes → the agent queries the *updated* atlas to verify its own change ("does this new route have auth?"). Atlas becomes the agent's ground-truth map, not just the human's
- Not in MVP because the export file delivers 60% of the value at 5% of the effort, and MCP tool design will be better informed once the model is stable

## 8. v1.x — near-term follow-ons (spec'd, not built in v1.0)

- **"What changed" overlay:** after an agent session, familiar map with added nodes glowing green, modified amber, removed ghosted + AI changelog paragraph. Uniquely valuable to this audience; strong candidate for the killer feature of v1.1. (`--watch` already gives the live version a foundation.)
- **MCP server** (see 7)
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
