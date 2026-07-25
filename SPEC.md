# App Atlas — Draft Spec v0.2

> **One-liner:** Understand any app — including the one your AI built. Run one command in any project and get an interactive, always-accurate atlas of your application — where data enters, what happens to it inside, and where it goes.

**Status:** ✅ Approved by Nick (2026-07-25). M1 and M2 shipped; M3 (the words layer) is next. See section 13 for the build log. Incorporates feedback rounds 1–2: name locked, open source, provider-agnostic AI with agent-CLI passthrough, dual audience, security badges in v1.0, agent/MCP integration, explanation-source ladder (docstrings first).

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
| Languages (v1) | TypeScript/JavaScript (deep) + Python (good); data model is language-agnostic for future plugins |
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

### 5.8 Web app (the lens layer)
React + **React Flow (@xyflow/react)** for canvas (nodes are real React components — type cards, folder boxes, hover cards are just JSX) + **elkjs** for deterministic hierarchical layout (only mainstream JS engine with proper boxes-inside-boxes support; runs in a web worker) + **d3-sankey** for boundary-view flow bands. Canvas only ever receives the current level's slice of the graph.

## 6. The views (v1)

### 6.1 Boundary view — the home screen
Left→right (beats the ring: reading order, causality, scales better; rings die past ~10 spokes).
- **Left edge:** input sources as cards — Users/browser, Stripe webhooks, cron jobs, env/config, third-party APIs
- **Center:** one large box = your app, containing 3–6 auto-detected zones (UI, API, business logic, data)
- **Right edge:** outputs — database, external APIs, email, file storage
- Sankey-style bands connect them; thickness = number of code paths. Max ~8–10 endpoints per side; minor flows group into "other"
- Hover a band → its full path highlights. Click → launches a trace walkthrough
- Below the diagram, one AI paragraph: "Your app takes X in, does Y with it, and stores/sends Z"

### 6.2 Architecture map — drill-down
- Top level: 5–9 modules as nested rounded rectangles with plain-English labels, aggregated arrows ("12 calls") between them
- Double-click → camera zooms in; siblings collapse to slim tabs at the border (context preserved); files render inside
- Click a file → local-graph highlight (1-hop neighbors lit, rest dimmed to ~15%) + detail panel
- Breadcrumb top-left (`App › User accounts › login.ts`), minimap bottom-right, Cmd-K search top-center
- Inside a file: its functions and types as rows/cards, each with AI one-liner, params, return type

### 6.3 Type explorer — dbdiagram for your code
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
3. **M3 — Words:** provider-agnostic AI enricher (agent-CLI passthrough first, then API keys) + overview page + hover cards + detail panels + trust labels.
4. **M4 — Types & tours:** type explorer + walkthrough primitive + auto-generated "what happens when…" tours + `export --md` for agents.
5. **M5 — Freshness & Python:** incremental re-analysis, `--watch`, Python analyzer, monorepo scope switcher, polish, docs, open-source launch.

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
2. **Onboarding cost UX:** exact wording/flow for the "this AI pass will cost ~$X / use your Claude Code subscription" moment. *(Still open — needed for M3.)*
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
