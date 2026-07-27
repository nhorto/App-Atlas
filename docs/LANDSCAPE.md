# The landscape — who else is doing this

*Researched July 2026. This is an independent pass, not a rewrite of [SPEC.md](../SPEC.md)
§2. Where it contradicts §2, that is the point: several claims in §2 have aged, and two
were probably never quite right.*

Every number here is what the source reported on the day it was read. Vendor comparison
pages are marked as such — a lot of the writing in this space is SEO published by
competitors about each other, and it should not be trusted about anything except the
existence of the product.

---

## The short version

Nobody ships App Atlas. But every *ingredient* of App Atlas ships somewhere, and three
of the four gaps SPEC §2 claimed are now contested:

| SPEC §2 claim | Verdict now |
|---|---|
| Nobody draws the boundary view statically | **Narrowed.** Nobody draws it as one picture. But OWASP Noir does doors-in across 50+ frameworks, Privado does data-out, and codegraph/repowise/code-graph-mcp all resolve URL patterns to handlers. The parts are commodity; the composition isn't. |
| Nobody serves the "can't read my own codebase" persona | **Wrong now.** An entire vibe-code-scanner industry sells to exactly that person. It sells them a security checklist, not comprehension — which is a different product, but the same buyer and the same fear. |
| Nobody combines ground truth with narrative | **Contested.** CodeBoarding, OpenVisio and repowise all do deterministic index + LLM prose. The remaining edge is *labelled provenance* and docstrings-first, not the combination. |
| Nobody does static "trace a request" storytelling | **Holds.** Nothing found generates a walkthrough of what happens when a specific door is knocked on, from static facts, without a model writing it. |

And one gap SPEC §2 never mentioned, which matters more than any of the above:

> **The agent-facing map is a solved, crowded, enormous market.** `codegraph` alone has
> 62.6k stars doing local-SQLite, auto-syncing, MCP-served code graphs with
> framework-aware route resolution across 20+ languages. `ATLAS.md` and the planned MCP
> server are not differentiators; they are table stakes, entered late.

The defensible ground is the part nobody else wants: **a picture a non-programmer can
read, that under-claims about security.**

---

## Bucket 1 — closest to the whole thesis

### OpenVisio — *the closest positioning found anywhere*

- Site: openvisio.io · OSS core: `syntaxPriest/openvisio-oss` (10★, TypeScript)
- Self-described as an open-source CodeSee alternative: "a live codebase map for humans
  plus an MCP code graph your AI agent can query."
- Local-first, **deterministic indexing — no LLM sees your code during indexing**, with
  an AI narrator layered on top that cites what it's talking about. Tree-sitter.
  Dependency and call graphs. VS Code extension, MCP endpoint.
- Four view modes: City, Service Map, Flow, Folder Graph.

**Why it matters:** the sentence they lead with is the sentence App Atlas leads with.
Deterministic facts + narrated on top + local + human view + agent view. If a positioning
collision exists, it is this one.

**Where App Atlas is still different:** their graphs are dependency/call graphs rendered
four ways — a prettier hairball is still a hairball. No evidence of entry-point
enumeration as a first-class view, per-route auth badges, env-var inventory, or DB tables
drawn beside code types. Their OSS component has 10 stars against a marketing site with
a full comparison-page SEO funnel, which suggests the real product is commercial and the
open source is a lead magnet.

### CodeBoarding

- `CodeBoarding/CodeBoarding` — 2.4k★, 197 forks
- Static analysis via **LSP clients** + LLM reasoning → Mermaid architecture diagrams and
  markdown in `.codeboarding/`. Incremental (only changed code). IDE, CI and docs
  integrations. Python, TypeScript, JavaScript, Java, Go, PHP, Rust, C#.
- Positioning: *"See what your AI is building before it breaks."*

**Why it matters:** that tagline is aimed at the same anxiety App Atlas is aimed at, from
a project with real traction and eight languages to App Atlas's two.

**Where App Atlas is still different:** component-level structure only. No route/webhook/
cron enumeration, no auth coverage, no outbound-service inventory, no env inventory.
Developer-oriented output (Mermaid in a repo folder, not an interactive local app).
Diagrams are LLM-composed from static input, so the *grouping* is a model's opinion —
App Atlas's containment hierarchy is the filesystem and its zones, which cannot be wrong.

### repowise

- `repowise-dev/repowise` — 4.2k★, AGPL-3.0, plus hosted tiers (free public repos, Pro
  $15/mo, Teams $60/mo, enterprise/air-gapped)
- Tree-sitter over 16 languages (11 "full", 5 "good" — the same tiering language App
  Atlas uses), **plus dedicated handlers for SQL, dbt, OpenAPI, Protobuf, GraphQL,
  Terraform**. Deterministic core, no LLM required; LLM only for wiki prose.
- Outputs: auto-generated freshness-scored wiki, MCP server (10 tools), **local dashboard
  with architecture visualization and C4 diagrams**, CLI health/risk/dead-code reports,
  and **generated `CLAUDE.md` / `AGENTS.md`**.
- Detects framework-aware routes/handlers, dead and unreachable code, co-change coupling,
  git hotspots, ownership.
- Positioning: *"Your AI agent burns most of its budget rediscovering your codebase.
  Index it once, and it never has to again."*

**Why it matters:** this is the most feature-complete overlap on the list — it already
does route detection, a local dashboard, agent instruction files, freshness scoring, and
a monetised business around it. It also independently arrived at "deterministic core,
optional LLM prose," which is App Atlas's principle #1.

**Where App Atlas is still different:** repowise is a **CodeScene alternative** — its
questions are *what should I refactor, what's risky, what's dead, who owns this*. Not
*where does data get in and who's guarding the door*. No security posture view, no
outbound-service inventory, no non-coder framing anywhere.

---

## Bucket 2 — agent-facing code graphs (the crowded part)

This is where the volume is, and where `ATLAS.md` + the planned MCP server compete.

| Project | Scale | What it is |
|---|---|---|
| `colbymchenry/codegraph` | **62.6k★**, MIT | Rust + tree-sitter kernel, 20+ languages, local `.codegraph/codegraph.db` SQLite, auto-syncs on change, MCP `codegraph_explore`. **Detects framework routing files and links URL patterns to handlers across 17 frameworks** (Express, Django, FastAPI, NestJS, Rails, Spring…). Impact/blast-radius. Cross-language bridging (Swift↔ObjC, RN TurboModules). No visual UI at all. |
| `abhigyanpatwari/GitNexus` | 44.7k★ | Zero-server, browser-only knowledge graph from a repo or zip, with a Graph-RAG agent. |
| `giancarloerra/SocratiCode` | 3.2k★, AGPL | AST-aware chunking + embeddings (Qdrant) + polyglot graph, 18+ languages. **Self-contained interactive HTML graph viewer** (Cytoscape + Dagre), blast-radius overlay. Claims endpoint detection, DB tables via context artifacts, infra (K8s/Terraform/Compose), and auth-middleware identification via call tracing. Benchmarked on VS Code's 2.45M LOC. |
| `yvgude/lean-ctx` | 3.4k★ | Context-governance layer for agents; 76 MCP tools. |
| `DeusData/codebase-memory-mcp` | — | Knowledge-graph MCP, 158 languages, single static binary. |
| `sdsrss/code-graph-mcp` | — | Tree-sitter AST graph MCP with **HTTP route tracing** and impact analysis. |
| `tirth8205/code-review-graph` | — | Local-first graph for MCP + CLI, benchmarked context reduction. |
| CoreStory | commercial, enterprise | Recursive decomposition into an "Intelligence Model" — architecture, **business rules mined from code** (incl. legacy languages), change impact, served over MCP. On-prem available. |

**The honest read:** App Atlas's facts layer is not novel, and its agent story is behind.
codegraph does route→handler resolution in 20 languages with a Rust kernel and 62k stars;
App Atlas does it in two languages with ts-morph. What codegraph *doesn't* have is a
screen a human being can look at, and it does not try to.

---

## Bucket 3 — narrative and wiki generation

- **DeepWiki** (Cognition) — free AI wiki for any public GitHub repo: structured docs,
  architecture diagrams, module explanations, dependency maps, chat. The reference point
  for "narrative without guarantees." Third-party comparisons (vendor-published, treat
  with care) fault it for shallow static analysis — can't find unreachable modules or
  never-imported exports — and for weak MCP support as of mid-2026.
- **CodeWiki** — `FSoft-AI4Code/CodeWiki`, ACL 2026 paper + framework for holistic
  repo-level documentation. Worth reading for the evaluation methodology: somebody has
  now published a benchmark for "is this generated architecture doc actually right,"
  which is directly relevant to defending App Atlas's provenance claims.
- **RepoAgent** (OpenBMB), `cyanheads/repo-map`, **Repo Atlas** (a Claude Code / Codex
  skill that writes `docs/atlas/`), **Blazity/atlas** (scaffolds AGENTS.md + CLAUDE.md),
  **ArchToCode** (LLM → Mermaid from any GitHub repo, credit-metered),
  **oh-my-mermaid** (1.8k★, codebase → navigable Mermaid with Claude Code integration).
- **Stale-docstring prior art**, narrow but real: `docsweeper` (uses VCS history to flag
  docstrings older than the code they describe) and `pystaleds` (compares docstring to
  signature). Neither does content-hash separation of body vs. doc, which is what App
  Atlas does — so the *mechanism* is still ours, the *idea* isn't new.

---

## Bucket 4 — the security/boundary angle (sharper overlap than SPEC §2 assumed)

This is the bucket SPEC §2 underweighted.

### OWASP Noir — the strongest existing "ways in"

- `owasp-noir/noir` — 1.4k★, 4,662 commits, joined OWASP June 2024
- *"Hunt every Endpoint in your code, expose Shadow APIs, map the Attack Surface."*
- Static extraction of endpoints — **paths, methods, parameters, headers, cookies, and
  the source file behind each** — across **50+ frameworks**, with an LLM fallback for
  unsupported ones. Shadow APIs, deprecated routes and undocumented handlers come out in
  the same inventory.
- Outputs JSON, YAML, **OpenAPI**, SARIF, cURL, Postman, HTML. Explicitly built for three
  consumers: human auditors, **AI auditors**, and DAST tools (ZAP, Burp, Caido).

**This is the single most direct overlap with the left-hand side of the boundary view**,
and it has broader framework coverage than App Atlas will have for a long time. It does
not do outbound services, data stores, env vars, auth coverage, or any map.

### Privado — the strongest existing "where does my data go"

- `Privado-Inc/privado` — open-source static scanner. Builds a knowledge graph of data
  flows: 110+ personal-data elements traced from collection point to **sinks — third
  parties, databases, logs, internal APIs**. Detects and classifies third-party
  integrations. Scans locally; code never leaves the machine.
- Framed for privacy engineering (RoPA reports, Play Store Data Safety), not comprehension.
- Cycode publishes the same technique for security data-flow mapping.

**So "every company your app sends data to, proven by the package or hostname" is not a
new capability.** It's a new *audience* for an existing capability.

### The vibe-coded-app scanner industry — App Atlas's audience, already monetised

A dense, commercially active cluster selling to non-technical people who shipped an
AI-built app and are frightened:

- **Vibe App Scanner** — 150+ checks against your live DB, auth and APIs; understands
  Supabase / Firebase / Clerk; finds OpenAI, Anthropic and Stripe keys **in shipped JS
  bundles**; Lovable-specific checks (missing RLS via `pg_tables`, Vercel/Netlify env
  audit, Supabase anon-vs-service-role). Delivers "a fix list, formatted for your AI tool."
- **CheckVibe**, **VibeZero**, **vibe-eval**, `ApacheWang/vibe-audit` ("catches the
  vulnerabilities that Cursor, Bolt, Lovable and Replit Agent generate but never warn you
  about"), `csmoove530/vibe-codebase-audit`, and `Su1ph3r/vercelsior` (130+ Vercel/Next
  checks including `NEXT_PUBLIC_` secret leaks).
- The demand is documented, not speculative: a Replit employee scanning 1,645
  Lovable-built apps found 170 exposing user data; a widely-reported March 2026 incident
  leaked ~1.5M API keys from an unreviewed vibe-coded app.

**What this changes.** The persona is served — badly, and from a different angle. They get
a ranked list of things that are wrong. They still cannot answer *"what is my app?"* App
Atlas answers the second question and touches the first. That is a real position, but
"nobody serves this persona" is no longer a defensible thing to say in a README, and
"which of my routes have no auth" now has to be honest that it is a comprehension
feature, not a security product — those scanners check live infrastructure and RLS
policies, which static analysis of source cannot see.

Enterprise adjacents, for completeness: 42Crunch (static OpenAPI audit — flags missing
auth definitions), Metlo (endpoint inventory + runtime), SonarQube/Checkmarx, Wiz.

---

## Bucket 5 — visualization, and the graveyard

**Alive:**

- `braedonsaunders/codeflow` — **4.8k★**. "Paste any GitHub URL → interactive
  architecture map. See how files connect, find what breaks if you change something. No
  install, no accounts — runs entirely in your browser." Single-file HTML + D3. This is
  what a curious non-programmer will find first, and the zero-install bar it sets is
  higher than `git clone && npm install && npm run build`.
- **AppMap** — *not dead.* v0.83.2 shipped April 2026; VS Code, Visual Studio and
  JetBrains distribution; "AI software architect" (Navie) layered on runtime traces. Still
  requires instrumentation and a request to actually run, so SPEC §2's adoption argument
  holds — but it is a funded, IDE-distributed product that draws true HTTP-in/SQL-out
  boundaries, and it should not be described as a relic.
- **CodeScene** (hotspots, code health, decision support — the survivor SPEC §2 correctly
  identified), **CodeCharta** (3D city view, OSS), **Understand** (SciTools), **NDepend**,
  **JArchitect**, **madge**, **dependency-cruiser**, **knip**.
- **CodeLayers** — spatial code exploration on Apple Vision Pro. Mentioned only because it
  keeps appearing in "best code visualization 2026" listicles.

**Dead, and why — this part of SPEC §2 held up:**

- **CodeSee** — closed 22 Feb 2024, acquired by GitKraken, brand sunset. Founder's stated
  reason: sales growth was inconsistent, and covering more codebases / IDEs / stacks to
  fix that was too expensive. Post-mortems add: web-only, code had to leave your machine,
  no agent integration.
- **arkit**, **tsviz**, **GitHub's repo-visualization**: pretty pictures, no retention.
- **Mutable.ai AutoWiki** — SPEC §2 lists it as dead in 2024. *I did not verify this.*

The lesson SPEC §2 drew is the right one and worth restating: **the survivors answer a
question and the casualties draw a picture.** App Atlas's answer-shaped features (auth
coverage, env inventory, service inventory, "what breaks if I delete this") are the part
that matters; the map is the delivery mechanism.

---

## Naming

"Atlas" in developer tooling is saturated, and this will cost discoverability:

`expo/atlas` (React Native bundle visualizer), `Blazity/atlas`, `pacifio/atlas` +
tryatlas.cc, `astrio-ai/atlas-code`, gitatlas.dev ("Git-Atlas — visualize any codebase
with interactive maps"), codeatlas.live, WorkOS Code Atlas / nexar.dev ("maps your
codebase into a knowledge graph"), `FITIMDOTORG/Code-Atlas` ("a visual map of your
codebase"), `lucyb0207/CodeAtlas`, a "Codebase Atlas" Claude Code skill on mcpmarket, a
Codeatlas GitHub Action, "Repo Atlas", plus Apache Atlas and MongoDB Atlas soaking up
every generic search.

gitatlas.dev and FITIMDOTORG/Code-Atlas describe themselves in nearly the same words as
this project.

One piece of good news: **`app-atlas` on npm is unclaimed** (registry returns 404 as of
this research). The name is available; the search term is not.

### So what would you rename it to?

I checked 70 candidates against the npm registry directly. The headline finding is not
about any one name:

> **npm's single-word English namespace is exhausted.** Of 70 checked, 47 were taken —
> including every strong metaphor: `legend`, `cutaway`, `portico`, `lintel`, `threshold`,
> `sextant`, `astrolabe`, `fathom`, `plumbline`, `sounding`, `waypoint`, `doorway`,
> `frontdoor`, `everydoor`, `entryway`, `porthole`, `transom`, `jamb`, `vestibule`,
> `foyer`, `schematic`, `floorplan`, `surveyor`, `cartograph`, `traverse`, `datum`,
> `lodestar`, `trailhead`, `perimeter`.

So "rename it to one clean evocative word" is not an available option. What is available:

**Free on npm, and worth something:**

| Name | The idea | Problem |
|---|---|---|
| `keyplan` | A drafting term: the small orientation diagram showing where the detailed drawing sits in the whole building. Exactly what drill-down + breadcrumbs do. | Obscure; reads as "pricing plan" to some |
| `groundtruth` | Literally product principle #1 | Collides with the ML sense (labelled training data), which owns the search results |
| `openings` | Architecture's word for the doors and windows in a building — the ways in | Common English word, so no better for SEO than "atlas" |
| `exploded-view` | The mechanical drawing that separates the parts so you can see how they fit — instantly clear to a non-engineer | Hyphenated, long to type |
| `cutplan`, `sectionview`, `boundaryview`, `insidemap`, `whatsinside`, `doorcount`, `waysin`, `frontdoors`, `fixpoint`, `levelset`, `landfall`, `chartroom`, `hatchway`, `soffit`, `doorsill` | — | see below |

**Two that looked strong and then didn't survive checking:**

- **Chartroom** — the room on a ship where the charts live. Free on npm, evocative. Killed
  by two things: `simonw/chartroom` already exists (50★, a CLI tool, February 2026), and
  "chartroom" is a common misspelling of "chatroom", so GitHub is full of chat apps under
  that name. The search problem would be worse than "atlas".
- **Hatchway** — free on npm, distinctive, a door. Killed by hatchways.io, an existing
  developer-tools company, plus `django-hatchway` (154★).

**Honest recommendation.** Nothing found beats "App Atlas" enough to pay for a rename.
The name is accurate, the metaphor is right, the npm package is free, and the alternatives
are either obscure (`keyplan`), ambiguous (`groundtruth`), or clunky (`exploded-view`).
The discoverability problem is real but it is a launch problem, and it is solved by the
tagline and the boundary-view screenshot, not by the noun — nobody searches "atlas" and
hopes to find this; they search "what are all the routes in my app" or "is my vibe coded
app secure."

If a rename does happen, do it before any adoption, and the two worth considering are
**`keyplan`** (precise, professional, uncontested) and **`openings`** (on-thesis, plain
English, reads well in a sentence: "Openings found 12 unprotected doors").

*Availability checked against the npm registry on 27 July 2026, and against GitHub
repository search. Domains and trademarks were not checked — do that before committing to
anything.*

---

## What to do with this

Ordered by how much it changes:

1. **Stop claiming the persona is unserved.** Claim instead that it is served by
   checklists, and that a checklist cannot tell you what your app *is*. That framing
   survives contact with vibeappscanner.com; the current one doesn't.
2. **Lead with the boundary view harder, not the map.** The map competes with codeflow,
   OpenVisio, CodeBoarding and a dozen graph viewers. "Every door into your app, and what
   guards it, on one screen, from a static run, without instrumentation" competes with
   nothing — Noir has no picture, AppMap needs a running request, Privado is a privacy
   report.
3. **Treat the agent-facing side as commodity and integrate rather than compete.**
   codegraph, repowise, SocratiCode and three MCP graph servers already own it. An
   `ATLAS.md` differentiated only by being a map is a weak claim next to 62k stars.
4. **Note what auth badges can and cannot see, prominently.** The scanner crowd checks
   live RLS, deployed env vars and shipped bundles. App Atlas reads source. A user who
   reads "who can get in" and thinks they have been security-scanned has been misled —
   which is exactly the failure mode CONTRIBUTING.md is built to prevent.
5. **Cheap credibility win:** run codegraph, CodeBoarding, repowise and Noir against the
   same repo and put the four outputs beside App Atlas's boundary view in the README. If
   the thesis is right, the difference will be visible without an argument.
6. **Framework coverage is the moat everyone else has and this doesn't.** Noir: 50+.
   codegraph: 17 across 20 languages. App Atlas's detector list is good for TS/Python
   web apps and empty everywhere else. That's the honest gap.

---

## Method and caveats

- Sources: GitHub repository search and READMEs, project sites, and web search. Star
  counts and commit dates are as reported when read (26 July 2026).
- openvisio.io, codemap.app, gitatlas.dev and codeatlas.live all returned HTTP 403 to
  direct fetches; those entries rest on search-result summaries and are correspondingly
  softer. Anything described from a vendor comparison page is flagged above.
- Not verified: Mutable.ai's shutdown, Ilograph's hallucination testing (both inherited
  from SPEC §2), CoreStory pricing, and any claim a competitor makes about its own
  benchmark numbers.
- Not searched: closed-source enterprise tooling behind sales calls, and non-English
  sources.
