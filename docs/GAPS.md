# The gaps — what the neighbours do that App Atlas doesn't, and how

*Written 30 July 2026 against App Atlas v0.6.0, from [LANDSCAPE.md](LANDSCAPE.md) (desk
research, revised the same day) and [BAKEOFF.md](BAKEOFF.md) (tools installed and run on
the same two repos). Every gap below names who has the capability and how they built it,
because "they have X" is not actionable and "they get X from tree-sitter grammars" is.*

The point of this document is to become issues. Each gap ends with a **Shape** line: what
the smallest honest version of the fix looks like here.

---

## The one-paragraph version

App Atlas wins on exactly one axis and it is a narrow one: **it puts a verdict on a door.**
Guarded or not, by what, how sure, with a line number. Nobody else in this research does
that — Noir finds the doors and says nothing about locks; CodeAtlas draws the middleware
as a participant in a sequence diagram and makes no security claim anywhere on its site;
OpenVisio's engine doesn't model routes at all. That verdict, and the discipline of
under-claiming it, is the product.

On **every other axis it is behind**, and mostly behind by a lot. Two languages against
eleven, forty, and fifty. No MCP server in a market where the MCP server is table stakes.
Not on npm, so the install is `git clone && npm install && npm run build`. No sense of
what changed since yesterday. That is the honest position.

---

# Tier 1 — the moat is thin, and this is where

## Gap 1. Two languages

> **Closed, 30 July 2026** — [#43](https://github.com/nhorto/App-Atlas/issues/43), M6. There are now three tiers, not two extractors: `src/analyze/generic/` is one extractor over tree-sitter grammars, and a language costs a query file plus a dialect of about fifty lines. Go is the first, and deliberately the only one so far. Everything below is left as it was written, because a gap report edited after the gap is closed is a report nobody can check. What actually shipped, and what it measured on three Go repos it had never seen, is in [SPEC.md](../SPEC.md) section 13 under M6.
>
> Two things the entry below got right and one it did not. Right: the mechanism to copy was the generic extractor, and the honest trade had to be stated in the product — it is, in the `ATLAS.md` header and above the CLI's numbers. Wrong: it assumed the framework detectors would need per-language work. They did not. `boundaries/build.ts` needed no changes at all, so Go route prefixes compose through the machinery written for FastAPI's `include_router`.

**Where we are.** `src/analyze/` has exactly two extractors: `ts/` (ts-morph) and `py/`
(CPython's own `ast` via a subprocess). Point App Atlas at a Go, Ruby, Java, C#, PHP,
Rust, Kotlin or Swift repo and you get file counts, folders, and an empty boundary view.
Not a wrong answer — no answer.

**Who has it, and how.**

| Tool | Languages | Mechanism |
|---|---|---|
| OWASP Noir | 50+ frameworks | Hand-written per-framework parsers in Crystal. Fast (0.16s on the fixture) and shallow by design. |
| OpenVisio | 40+ | **tree-sitter** into a symbol + import graph, ranked with PageRank. One generic extractor, no per-language analyzer. |
| codegraph | 20+ | Rust kernel, tree-sitter, plus framework-aware route resolution across 17 frameworks. |
| repowise | 16 | tree-sitter. |
| CodeAtlas | 11 (+40 frameworks) | Not stated publicly; 11 languages with per-framework layers on top. |
| **App Atlas** | **2** | ts-morph (full type resolution) + Python `ast`. Deep, narrow, and expensive per language. |

**The thing to notice.** Nobody built forty language analyzers. They built **one generic
extractor over tree-sitter grammars** — symbols, imports, calls — and layered
framework-specific detectors on top of it. OpenVisio does 40+ languages with a 10-star
repo and one maintainer. The cost is not linear in languages; it is one integration plus
a grammar per language.

That maps onto the architecture already here. `src/analyze/boundaries/` is a
findings-emitting detector layer that `build.ts` merges project-wide, and that merge layer
is **already language-neutral** — proven when the Python auth rules transferred to
TypeScript unchanged. What is language-specific is the *extraction*, not the reasoning.

**The honest trade.** ts-morph gives real type resolution; tree-sitter gives a parse tree
and no types. So a tree-sitter tier would be a genuinely weaker tier, and saying so is
part of shipping it — a Go repo would get doors, imports and symbols but not the type view
that TypeScript gets. That is enormously better than the blank page it gets today, and it
must not be presented as equivalent.

**Shape.** A third extractor, `src/analyze/generic/`, over tree-sitter: symbols, imports,
call edges, docstrings. Deep tier (`ts/`, `py/`) claims a file first; generic takes what's
left. Start with Go — one stdlib parser, one dominant router idiom, and a clear signal in
`go.mod`. Prove the seam on one language before adding grammars.

---

## Gap 2. Frameworks, even inside the two languages we do read

**Where we are.** The detectors emit routes under thirteen framework labels — Next.js,
SvelteKit, Remix / React Router, NestJS, Fastify, tRPC, Expo Router, Cloudflare Workers,
Vercel Cron, Supabase Edge Function, Supabase PostgREST, Django, and bare Node — and
recognise Express, Hono, Koa, FastAPI, Flask, aiohttp, Sanic and Quart at the call level,
with data-layer signals for Prisma, Drizzle, Supabase, Mongoose, Knex and Kysely.

Missing, in rough order of how likely a weekend-built app is to use them: **Nuxt**,
**Astro**, **Litestar**, **Elysia**, **AdonisJS**, Bottle, Falcon, Pyramid, Tornado.

> *SvelteKit and Remix landed in [fileroutes.ts](../src/analyze/boundaries/fileroutes.ts)
> (issue #44). Two things they cannot see, so that nobody has to find out the hard way: a
> SvelteKit page whose route folder holds only a `+page.svelte` is missing from the map,
> because `.svelte` is not a file the TypeScript reader opens — and a check written in a
> `+layout.server.ts` is deliberately not reported, because the only pattern available to
> express its reach would also cover the endpoints that layout never runs for.*

> *An earlier draft of this document said Django was absent. It is not — routes come from
> `urlpatterns` ([py/boundaries.ts:195](../src/analyze/py/boundaries.ts)), guards from
> `login_required`, `staff_member_required` and `permission_required`, and tables from
> `Model.objects`. The claim came from grepping for a lowercase string that the code
> spells capitalised. Left visible here because filing an issue to build something that
> already exists is exactly the failure this project is supposed to be allergic to.*

**Who has it, and how.** Noir's 50+ is the number to beat and its method is unglamorous:
one small parser per framework, each knowing one framework's route-declaration idiom. This
is not research, it is a long tail of small, testable additions — which makes it good
issue material and bad architecture work.

**Shape.** One issue per framework family, each self-contained: a fixture, a detector, a
test asserting the doors and their guards. SvelteKit and Remix went first, being the two
most likely to turn up in an app someone built over a weekend with an agent; both cost one
new file and no change at all to the merge layer, which is the shape the rest should take.

---

# Tier 2 — capabilities we don't have at all

## Gap 3. No sense of what changed

**Where we are.** Every run is a fresh photograph. The incremental cache makes re-analysis
fast but the output is stateless — there is no "since yesterday," no baseline, no diff.

**Who has it, and how.** CodeAtlas paints a diff onto **every** diagram layer: added nodes
green, removed red dashed, modified amber, so a single PR shows its whole architectural
footprint. On top of that they check architecture rules — banned imports, forbidden
cross-layer calls, drift against a baseline topology.

**Why it matters here more than it does for them.** The user this tool is built for spent
a weekend letting an agent write code and has to explain it Monday. The question that
person actually asks is not "what is my architecture," it is **"what did it do to my
app?"** A boundary view that said *three new doors appeared this week, two of them have no
auth check* would be the single most useful screen in the product, and every fact needed
to compute it is already in `atlas.db`.

**Shape.** Persist the previous atlas alongside the current one; diff node sets by stable
id; badge added/removed/changed on the boundary view. The highest-value narrow version:
**new unguarded doors since the last run**, on the overview, above everything else.

---

## Gap 4. No MCP server, no IDE presence

> **Half closed, 31 July 2026** — [#42](https://github.com/nhorto/App-Atlas/issues/42). `app-atlas mcp` is a Model Context Protocol server over stdio, with the six tools named below, hand-rolled rather than taken from the SDK — the reasoning, and the 93 packages it saved, are in [SPEC.md](../SPEC.md) section 13. The IDE half of this gap is untouched: there is still no VS Code extension and nothing auto-wires an agent for you, so the install is one `claude mcp add` or one block of `.mcp.json`. Everything below is left as it was written, because a gap report edited after the gap is closed is a report nobody can check.

**Where we are.** `src/server/` serves the local web app. There is no MCP server. The
agent-facing surface is `ATLAS.md`, a static file you paste.

**Who has it, and how.** This is the crowded part of the market and everyone is already in
it. codegraph wires itself into Claude Code, Cursor and Codex with one command. CodeAtlas
ships a VSIX that auto-wires six agents plus an npm MCP server exposing ~51 tools.
OpenVisio's *entire pitch* is now the MCP server. LANDSCAPE.md called this table stakes in
July and nothing since has softened that.

**The honest read.** This is distribution, not analysis, and it is the cheapest large win
available — the graph, the queries and the export already exist. What's missing is a
protocol wrapper.

**Shape.** An MCP server over the existing `AtlasGraph`: `list_doors`, `unguarded_doors`,
`what_calls`, `where_is`, `data_stores`, `env_vars`. Ship it as a subcommand
(`app-atlas mcp`) so there is nothing new to install.

---

## Gap 5. Nothing reads infrastructure

**Where we are.** Exposure is read from application code only.

**Who has it, and how.** codemap.app parses **Terraform** — modules and resources as one
graph — and is the only tool in this research that does. Their framing is a change that
accidentally takes down the production database.

**Why it belongs here specifically.** For a small app, a large share of real exposure lives
in infrastructure, not code: a public S3 bucket, a security group open to `0.0.0.0/0`, a
database with a public endpoint. Those are *doors*, they are exactly what the boundary
view is for, and no amount of reading TypeScript will find them. A Terraform or
`docker-compose.yml` reader is a straight extension of the existing thesis rather than a
new one.

**Shape.** Start with `docker-compose.yml` — trivially parseable YAML, and published
`ports:` are doors by definition. Terraform second.

---

## Gap 6. No dead code, no history, and a weak "where to look first"

**Where we are.** "The most connected files, which is usually where the app actually
lives" — raw connection count.

**Who has it, and how.** repowise ranks with **PageRank over the import graph** rather than
degree, which is materially better at surfacing what a codebase is organised around; mines
**git history** for hotspots and ownership; and reports **dead code and unused exports**.
None of this needs a model.

**Shape.** Three separable issues. PageRank is the cheapest (the graph exists; it is a
scoring change). Unused exports is next and is a genuinely useful answer for the target
user — *nothing in your app calls these eleven files*. Git history is the largest and the
least aligned with someone who has no history to speak of.

---

## Gap 7. Data is inventoried, not classified

**Where we are.** Stores and services are found and named. Nothing says what *kind* of data
moves through them.

**Who has it, and how.** Privado does static data-flow with PII classification — "where
does my data go" — which is the other half of the boundary question and the half that
matters to anyone who has to answer a customer about GDPR.

**Shape.** Not near-term. Recorded because it is the most defensible *next* thesis after
the door verdict, and because a column name of `email`, `ssn` or `dob` on a table already
in the type view is an unusually cheap first signal.

---

# Tier 3 — packaging

## Gap 8. You cannot install it

**Where we are.** `npm view app-atlas` returns **404**. The name is still unclaimed. The
install is `git clone && npm install && npm run build`.

**Who has it, and how.** Everyone. `npm i -g @colbymchenry/codegraph`.
`uv tool install repowise`. CodeAtlas and OpenVisio are marketplace extensions. LANDSCAPE
notes a competitor whose whole pitch is "no install, no accounts — runs entirely in your
browser," and that bar is set *for the exact person this tool is for*.

**The blunt version.** Every gap in this document is theoretical until someone can run it.
A person who spent the weekend vibe-coding will not clone a repo and run a build.

**Shape.** Publish to npm so the command is `npx app-atlas .`. This is the highest
value-to-effort item in the document.

---

# Tier 4 — holes of our own, found by measuring

## Gap 9. One bad cell blanks an entire notebook

**Found 30 July**, checking the NBA repo. `ETL.ipynb` opens with `pip install pandas` —
no `!`, which IPython accepts and `ast.parse` does not. `strip_magic` in
[extract.py:660](../src/analyze/py/extract.py) blanks lines starting with `!`, `%` or `?`,
so this one survives, the flattened source fails on line 1, and **all 21 cells go dark**.
Three of that repo's ten notebooks hit it — 111 cells invisible.

**Shape.** When a notebook fails to parse whole, retry cell by cell and blank only the
cells that don't parse. Generalizes to any non-Python cell, and does not special-case
`pip`. A cell that isn't Python should cost you that cell, not the notebook.

## Gap 10. "Public by design" only recognises a page

**From the [bake-off re-run](BAKEOFF.md#re-run-30-july-2026--v060-on-the-same-two-subjects).**
The headline is honest now — `11 of 37 routes have no auth check App Atlas can see`,
`1 more are pages or the door people sign in through, open on purpose` — but on
nextjs-subscription-payments that class caught **one** door, while `signInWithEmail`,
`signInWithPassword`, `signUp`, `requestPasswordUpdate` and `SignOut` are all still counted
as findings. The rule knows a sign-in *page*; it does not know a sign-in *server action*.
The alarm is inflated by about five.

**Shape.** Extend the classification to handlers whose body calls a known sign-in,
sign-up or sign-out primitive — evidence from the call, not from the name.

## Gap 11. Taxonomy's prose puts the right doors on the wrong verbs

**Carried from the phase-4 re-runs.** The generated overview attributes saving to
`GET /api/posts` and `DELETE /api/posts/:postId`; the real save routes are POST and PATCH.
Every door named exists. Two verbs are wrong. Grounding problem, not detection.

**Shape.** The method is already in the prompt context — either constrain the model to
cite route+method as a pair, or validate generated route mentions against the endpoint
table and drop the sentence when the method disagrees.

---

# Summary

| # | Gap | Who has it | Effort | Value |
|---|---|---|---|---|
| 8 | Not installable (`npx`) | everyone | **XS** | **Highest** |
| 9 | Notebook dies on one cell | — (our bug) | **S** | High |
| 10 | Public-by-design misses actions | — (our bug) | **S** | High |
| 3 | No diff / "what changed" | CodeAtlas | M | **Highest** |
| 4 | No MCP server | codegraph, CodeAtlas, OpenVisio | M | High |
| 1 | Two languages | OpenVisio (40+), Noir (50+) | **L** | **Highest** |
| 2 | Missing frameworks (Django first) | Noir (50+) | M, divisible | High |
| 6 | PageRank / dead code / history | repowise | M, divisible | Medium |
| 5 | No infrastructure reading | codemap (Terraform) | M | Medium |
| 11 | Prose verb mismatch | — (our bug) | S | Medium |
| 7 | No data classification | Privado | L | Later |

**If only three things happen:** publish to npm, ship "what changed since last run," and
open the language seam with Go. The first makes the tool reachable, the second is the
question the target user actually asks, and the third is the only axis on which every
single neighbour currently beats us.
