# The landscape, second pass — August 2026

*Researched 8 August 2026 against App Atlas v0.19.0, nine days after
[LANDSCAPE.md](LANDSCAPE.md) was last revised. Four independent research passes were run
in parallel over four segments — agent-context tooling, codebase visualization and
architecture conformance, security-flavoured surface mapping, and a sweep specifically for
2025–26 entrants that a model's training data would miss.*

*This does not replace [LANDSCAPE.md](LANDSCAPE.md). That document was written at v0.6.0,
when App Atlas had two languages, no MCP server and no npm presence, and its conclusions
were shaped by that position. This one is written from v0.19.0 with five languages, an MCP
server, and a tarball waiting on a token. Where the two disagree, the disagreements are
listed at the bottom rather than silently resolved.*

**Provenance warning, same as the July pass.** Every number is what a source reported on
the day it was read, gathered by desk research. Star counts and download figures move,
vendor comparison pages in this space are SEO published by competitors about each other,
and self-reported benchmarks ("99% fewer tokens") are marketing until independently
reproduced. Nothing below was installed and run — that is what [BAKEOFF.md](BAKEOFF.md)
is for, and a bakeoff against the new entrants has not been done.

---

## The one-paragraph version

Nobody occupies App Atlas's exact position: a local, deterministic, semantic map of an
application — doors, guards **with confidence grades**, data stores, outbound calls — with
a human viewer, an agent-facing artifact, and an MCP server. Across roughly forty products
examined, not one combines those. But the abstraction level immediately *below* us —
generic symbol-and-call graphs served to agents over MCP — went from niche to commodity in
under a year, with four free, local, open-source projects between 25k and 47k stars. Our
moat is not indexing and never was. It is the semantic layer on top, and the discipline of
grading our own certainty, which remains genuinely unique: every other tool in this space
either binary-flags, tags, or claims AI-driven certainty.

---

## The four lanes

The category has split, and the split is useful because it tells you who is actually
competing with what.

| Lane | What it answers | Who | Traction |
|---|---|---|---|
| **Flatteners** | "Here is the code" | Repomix, GitIngest, files-to-prompt, code2prompt | Repomix ~26k stars, ~255k npm downloads/month |
| **Graph / query engines** | "Where is this symbol, what calls it" | CodeGraph, codebase-memory-mcp, GitNexus, Serena, Augment Context Engine | 25k–47k stars each, mostly under a year old |
| **LLM doc generators** | "Here is a narrative about this repo" | DeepWiki, CodeBoarding, deepwiki-open | DeepWiki: 50k+ repos pre-indexed |
| **Security mappers** | "Here is what is exposed and wrong" | Apiiro, StackHawk, Ghost, OWASP Noir, route-detect | Enterprise contracts; Noir is OSS, ~1.4k stars |

App Atlas sits in none of them cleanly, which is either the opportunity or the problem
depending on how the pitch is written. The closest honest description is *the map above the
graph*: the engines tell an agent where a function is; we tell it what the application is.

---

# Lane 1 — Flatteners

**Repomix** — packs a repo into one AI-friendly XML/Markdown file, with a tree-sitter
"compress" mode that strips bodies to signatures (~70% token reduction claimed), secret
scrubbing, and token counts. MIT, free, ~26k stars, ~255k npm downloads/month. Ships a
CLI, a website, editor extensions and an MCP server.

**GitIngest** — replace `hub` with `ingest` in a GitHub URL and get a prompt-friendly
digest. ~15k stars. **files-to-prompt** (Simon Willison) and **code2prompt** are the same
idea at smaller scale.

**Relevance to us.** Not competitors, but they own the mindshare of the sentence *"get my
repo into the model."* They perform zero interpretation, which is the entire difference:
they hand over raw material, we hand over a reading of it. Worth knowing because a first-time
visitor may well arrive thinking App Atlas is one of these, and the README's opening
sentence has to disabuse them in one line.

---

# Lane 2 — Graph and query engines (the crowded one)

This lane did not meaningfully exist in this form eighteen months ago.

**CodeGraph** (`colbymchenry/codegraph`) — tree-sitter ASTs into a local SQLite symbol,
call and import graph, served over MCP, with OS-native file watchers for incremental sync.
No embeddings, no API keys. MIT. Reported ~47k stars, launched January 2026, with a
reported 21k stars gained in a single week in late May. Markets on numbers: "94% fewer tool
calls," "100% local." Eight agent integrations.

**codebase-memory-mcp** (DeusData) — a single static C binary, MCP server, persistent
knowledge graph over 158 languages via tree-sitter with LSP type resolution for ~12.
**Extracts HTTP routes and cross-service links.** Reported ~38k stars. Markets on "99%
fewer tokens" and sub-millisecond queries, with a benchmark claim of 11k tokens versus 38k
for an architecture question. Solo maintainer.

**GitNexus** — client-side knowledge graph, 16 MCP tools, cross-repo groups, browser or
CLI. Reported ~42k stars. PolyForm Noncommercial licence plus a commercial tier, which is
a licensing distinction App Atlas can point at without saying anything unkind.

**Serena** (oraios) — LSP-over-MCP symbol retrieval and symbolic editing, 40+ languages,
MIT, ~25k stars, and reportedly the most-visited codebase MCP server on PulseMCP.

**Augment Context Engine** — the notable commercial move: Augment unbundled its semantic
retrieval index and shipped it as a standalone MCP server (GA February 2026), priced by
usage. First major vendor to sell "context" as a product separate from the agent.

**Relevance to us.** This is the lane that matters, for three reasons.

1. **It commoditized the plumbing.** Local + tree-sitter + SQLite + MCP is no longer
   distinctive; it is table stakes, and four projects give it away.
2. **It is one level below us.** They model symbols; we model applications. None of them
   grades auth, and only codebase-memory-mcp touches routes at all.
3. **It is the direction a competitor would move next.** The distance from "I extract HTTP
   routes" to "I tell you which ones are guarded" is not large for a motivated maintainer.

---

# Lane 3 — LLM documentation generators

**DeepWiki** (Cognition/Devin) — auto-generated wiki-style docs and architecture diagrams
for GitHub repos; the `github.com` → `deepwiki.com` URL trick; 50k+ public repos
pre-indexed; conversational Q&A. Free for public repos, funnelling into paid Devin, and
being folded into usage-based pricing as of Cognition's 2026 self-serve repricing.

**CodeBoarding** — static analysis plus LLM reasoning producing Mermaid diagrams and
markdown into `.codeboarding/`; CLI, web, VS Code extension; ~2.4k stars, MIT, requires LLM
API keys. Tagline: *"See what your AI is building before it breaks."*

**Relevance to us.** DeepWiki owns the "help me understand this repo" mindshare, and its
weaknesses are precisely our talking points: your code goes to a cloud service, the output
is model-written prose that cannot be checked, and it is being monetized. This is the same
argument [LANDSCAPE.md](LANDSCAPE.md) recorded from Ilograph — a competitor demonstrating
that models asked to diagram a codebase hallucinate services that do not exist.

One new piece of external evidence for the same position: a 2026 ETH Zurich study
("Headwind") reported that naively auto-generated agent context files *reduced* task
success by roughly 3% while raising cost about 20%. **Not verified** by us, and worth
reading before it is ever quoted publicly — but if it holds, it is a direct argument for
grounded static facts over generated prose.

---

# Lane 4 — Security-flavoured mappers

App Atlas is not a security product, but it uses security vocabulary — entry points,
guards, exposure — so this lane collides with ours on words if not on purpose.

**OWASP Noir** — the closest free thing to our "doors." Crystal CLI, statically extracts
endpoints, params, headers and cookies across a claimed 193 frameworks, outputs JSON /
OpenAPI / SARIF / cURL / Postman, pipes into ZAP and Burp, and has an `--ai-context` flag
emitting guards and sinks for LLM auditors. MIT, local, v1.0.0 May 2026, ~1.4k stars.
Differences: offence-framed (the endpoint list exists to be attacked), endpoints only — no
stores, outbound calls, workers or CLI commands — tags rather than graded confidence, no
viewer, and no MCP server as of the README read.

**route-detect** — curated Semgrep rules that find routes and classify authn/authz status,
with a `viz` subcommand. Conceptually the closest thing to our *guards* feature
specifically. ~280 stars, last pushed September 2025, effectively one maintainer.

**Apiiro** — enterprise "deep ASPM": a risk graph of APIs, data models, sensitive flows and
controls; launched a CLI in April 2026 explicitly *"designed for AI coding agents rather
than humans."* Cloud, sales-led, opaque pricing. Its marketing claims to *eliminate* false
positives, which is the exact opposite of our stance and a useful contrast.

**StackHawk** — DAST with source-code API discovery and an org-wide coverage dashboard;
unusually transparent pricing (free single app, $42/contributor/month Pro).

**Ghost Security** — repo-cloning agentic analysis producing an API inventory with
severity *and confidence* scores, plus an MCP server. The closest anyone comes to our
grading idea, but cloud-hosted, LLM-agent-driven, and enterprise-priced.

**Semgrep / CodeQL** — both can find routes and missing auth, but as *findings*, not as an
inventory. CodeQL models route setup internally as plumbing for taint queries; getting a
map out means writing QL yourself.

**Relevance to us.** Almost nobody in this lane serves an individual developer: the
commercial set is uniformly sales-led and sells to security teams. The free local options
— Noir, route-detect, Bearer CLI — each cover one axis of what App Atlas covers, none
combine them, and none grade confidence honestly.

---

# The graveyard, and what killed it

This is the most useful part of the research and the least pleasant.

| Product | Fate |
|---|---|
| **CodeSee** — "GPS for your code," VC-backed codebase maps | Shut down February 2024; assets acquired by GitKraken; sunset as a standalone product |
| **Sourcetrail** — the beloved OSS code explorer | Discontinued December 2021. "Sourcetrail alternative" is still a common search — demand outlived the product |
| **Swimm** — docs synced to code, per-seat SaaS | Pivoted to enterprise legacy/mainframe modernization services |
| **Structure101** — architecture analysis | Acquired by Sonar, October 2024; folded into SonarQube |
| **OWASP Attack Surface Detector** — endpoints from static analysis, 2018 | Abandoned ~2022; the idea is older than it looks |
| **Akita Software** — developer-first API observability | Acquired by Postman 2023; became an enterprise-tier feature |

The pattern is consistent enough to be a warning: **a map people look at occasionally does
not sustain a subscription.** Usage spikes at onboarding and decays; the buyer and the user
are different people; and by 2024 models could answer "how does this codebase work?"
well enough to erode the casual case.

What survived did so by attaching to something with a heartbeat:

- **CI enforcement** — dependency-cruiser, ArchUnit, eslint-plugin-boundaries. Free, OSS,
  and permanent, because the rules run on every commit where developers already look.
- **Enterprise budgets** — CAST Imaging ($10k–$108k/year per application by LOC), vFunction,
  Lattix, Swimm. Comprehension sells at the modernization layer, not the individual layer.
- **Agent workflows** — the entire Lane 2 explosion.

App Atlas is free, OSS, and in the agent-workflow lane, which is the surviving side of that
line. The deferred drift-check in [DIRECTION.md](DIRECTION.md) would put it in the CI lane
too — the strongest of the three — which is an argument for that feature that has nothing
to do with whether the skeleton workflow is pleasant.

---

# What is actually defensible

Three things, in order of durability.

**1. Grading our own confidence.** Nothing else in forty products does this. Noir tags,
route-detect flags binary, Apiiro claims to eliminate false positives, Ghost scores
confidence but inside a cloud vuln product. Our `certain` / `likely` / `possible`, and the
refusal to round `likely` up to "protected," is a stance rather than a feature — and after
the M11 work it reaches the headline itself ("all matched, none proven"). Stances are
harder to copy than functions, because copying one means admitting your previous answer
overclaimed.

**2. The semantic layer.** Doors, guards, stores, and outbound calls composed into one
picture, above the symbol graph rather than inside it. Currently unoccupied. Not
permanently safe: Carto (below) is the same idea, and codebase-memory-mcp is one feature
away.

**3. Deterministic facts over model prose.** Compiler-derived structure, with the model
allowed only to write sentences next to it. This one has external support (Ilograph's
hallucination test, the ETH study) and matters more as agent-written code grows.

**What is not defensible:** local-first, tree-sitter, SQLite, MCP, an agent-facing markdown
artifact. All commodity, all given away by projects with forty thousand stars. Any pitch
resting on those is a pitch about the plumbing.

---

# Three to watch

1. **codebase-memory-mcp** — already extracts routes and cross-service links, already
   markets itself with our sentence ("give your coding agent a map"), and has ~38k stars.
   The gap between it and us is the semantic layer. Solo maintainer, which cuts both ways.
2. **Carto** (`theanshsonkar/carto`, Show HN June 2026) — 71 stars, and near-identical in
   concept: a portable local SQLite container with route detection, data-model extraction
   from Prisma/Zod/Drizzle/Pydantic, risk scoring, agent-first, MIT. Tiny today. It matters
   because it is independent confirmation that the gap we see is visible to others.
3. **CodeBoarding** — same mission, real traction, differentiated only by being
   LLM-assisted rather than deterministic. If it goes deterministic, it converges on us.

Also noted: **TheAuditor** (local code intelligence with a security framing) went
proprietary and was heading to commercial release in August 2026 — the closest thing to a
paid version of our angle.

---

# Where this pass disagrees with the July pass

Recorded rather than reconciled, because a document quietly edited to agree with a newer
one is a document nobody can check.

- **codegraph's star count.** July recorded 62.6k; this pass found ~47k for
  `colbymchenry/codegraph`. There are at least two unrelated projects called codegraph
  (a second, `suatkocar/codegraph`, is Rust with 32 languages), so these may be different
  repos rather than a contradiction. **Unresolved.** Do not cite either number without
  re-reading the repo.
- **"MCP is table stakes, entered late."** July's judgement holds and hardened. We now ship
  one, which moves us from absent to ordinary — not to differentiated.
- **"The defensible ground is a picture a non-programmer can read, that under-claims about
  security."** The second half is confirmed emphatically and is stronger than July gave it
  credit for. The first half — the non-programmer viewer — was not tested by this pass at
  all; nothing in these four segments competes on it, which is either a moat or an absence
  of demand, and this research cannot tell which.
- **CodeAtlas**, July's "closest competitor," did not surface in any of the four August
  passes. Not evidence it is gone; evidence that four differently-worded searches did not
  reach it. Its entry in [LANDSCAPE.md](LANDSCAPE.md) stands unrevised.

---

---

# The one this research missed entirely

*Added 8 August 2026, hours after the rest of this document, when npm refused to publish
the package.*

**There is another project called App Atlas.**
[`zharmedia386/app-atlas`](https://github.com/zharmedia386/app-atlas), on npm as
`appatlas`: *"Architecture observability for JS/TS backends — scans NestJS+Prisma code
into an interactive local dashboard. No AI, no API keys, 100% local."* MIT, TypeScript, a
website, thirteen versions published between 11 and 15 June 2026 and nothing since — 0
stars, ~1 download a week.

Same name. Adjacent pitch, down to *no AI* and *100% local*. Far narrower scope: one
framework pair, no confidence grading, no agent surface.

**Two consequences.** npm compares names with punctuation stripped, so `app-atlas` reads
as `appatlas` and is refused; this project publishes as `@app-atlas/cli`, and the command
stays `app-atlas`. And at launch the name is contested in search results by a project that
looks abandoned but is not gone.

**Why it is filed here rather than quietly fixed.** The four passes above searched by
*capability* — forty products, four segments, and not one query for the product's own
name. That is not a subtle gap; it is the first thing anyone checks before naming a thing,
and it was skipped by research thorough enough to catalogue a graveyard. It stayed
invisible until a registry said no, which is the same lesson as
[the artifact rule](../SPEC.md): a claim nobody tried to *use* is a claim nobody has
tested. Read the confidence of everything above with this in mind.

---

## What was not done

- **Nothing was installed or run.** No 2026 entrant has been through a
  [BAKEOFF](BAKEOFF.md). Every capability claim above is a claim its author makes.
- **No self-reported benchmark was reproduced** — "99% fewer tokens," "94% fewer tool
  calls," "83% answer quality."
- **The ETH Zurich "Headwind" finding is unverified** and should be read before it is
  quoted anywhere public.
- **Star counts are a single-day reading** in a category where a project gained a reported
  21k stars in one week.
- Closed-source enterprise tooling behind sales calls was characterized from marketing
  pages, not use.
