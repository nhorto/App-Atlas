# Field drive, phase 1: what a first-time reader actually gets

*Run 2026-07-29 against merged `main` (7c163f7), `--no-ai` throughout, driven by hand in
a real browser. Phase 2 (AI on) has not run yet. Protocol: [field-drive-plan.md](field-drive-plan.md).*

Seven repos analyzed, one driven click-by-click end to end (shadcn-ui/taxonomy), two more
driven in the UI (NBA, powerfab-dashboard), the rest probed against the finding classes
the first drive surfaced.

## The verdict

**The structure is real and the framing is genuinely good. The facts on top of it are
not yet trustworthy enough to brief anyone with.**

The three-column Boundaries idea — what gets in, your app, where data goes — is the best
one-glance summary of an unfamiliar codebase I have seen from any tool, and the Overview
and Security screens are written in plain, honest language that the target reader can
follow without learning our vocabulary. When it is right, it is *very* good: the
walkthrough of `DELETE /api/posts/:postId` names the door, the convention that found it,
the file and line, what it calls, and where it lands, in five steps.

But on the one repo I drove exhaustively, the tool **told the reader three false things
about their own app**, and one of them was delivered by the flagship walkthrough feature
in the plainest possible words. For the Monday-morning persona — who cannot check our
work, which is the entire reason they opened the tool — a confident falsehood is worse
than a blank screen.

Everything below is ranked by that standard.

---

## 1. One hop of indirection makes the detectors blind

This single defect produced most of the serious findings, in both directions.

**False alarm.** In taxonomy, `DELETE /api/posts/:postId` and `PATCH
/api/posts/:postId` open with

```ts
if (!(await verifyCurrentUserHasAccessToPost(params.postId))) return new Response(null, { status: 403 })
```

and that helper does `getServerSession(authOptions)` **plus** an ownership-scoped
`db.post.count({ where: { id, authorId: session?.user.id } })`. These are the *best*
protected routes in the repo — ownership, not merely session. App Atlas ranks them #2
and #3 in the danger list as "writes data · no check found", and the guided tour's final
step is headed **"Nobody is checking who called."**

Cause: `auth.ts:118` emits the guard with `nodeId: ctx.enclosing(node)` — the function
the `getServerSession` call textually sits in, which is the helper, not the exported
handler.

**False absence.** taxonomy makes six real Stripe calls; "Where data goes" says
"3 services out" and omits Stripe entirely, while the panel two inches away lists
"Stripe" among the frameworks. Cause: `lib/stripe.ts` constructs the client and exports
it, consumers `import { stripe } from "@/lib/stripe"`, and `outbound.ts` only follows
imports where `imported?.external` is true.

This recurs everywhere the pattern does, which is everywhere:

| repo | wrapper | what goes missing |
| --- | --- | --- |
| taxonomy | `lib/stripe.ts` | Stripe (payments) |
| daily-briefing | `lib/kv.ts` (`@vercel/kv`) | Redis / Vercel KV — the entire storage layer |
| mirrorquiz | — | Anthropic and Resend, both in the framework list, neither in services |

**The fix already exists in the atlas.** taxonomy resolved 482 references; the `uses`
edges are right there. A bounded walk (depth 2–3, same-repo functions only) closes both
halves. Guards found through a hop should be badged `likely` rather than `certain` —
that vocabulary is already built and already rendering elsewhere.

## 2. The red headline cries wolf

Boundaries leads with "**12 routes have no auth check**" in alarm-red. Of those twelve,
**eight are PAGE routes** — `/`, `/blog`, `/docs/*`, `/pricing` and friends: a marketing
site and a docs site, public on purpose. A ninth is `/api/auth/*`, NextAuth's own
handler, which must be reachable unauthenticated. Of the remaining three, two are the
false alarms above.

The honest count of things that should worry this reader is **zero**. The headline says
twelve.

The Security screen itself gets this right and says so out loud — *"A public marketing
page belongs in this list; a server action that writes to your database does not"* — but
that sentence is one screen away from the number, and the number is on the home page.

## 3. "Where data goes" is unreliable in both directions

For `psf/requests`, the screen a stakeholder would screenshot for a privacy question
reports four outside services: `example.com`, `requests call`, `s call`, `session call`.

Every one comes from a **test file**. Three are not services at all — `s` and `session`
are local variable names (`s = requests.Session()`), and `requests call` is the library
reporting *itself* as an outside company it sends data to.

Two distinct defects: outbound detection runs over test code, where fake hosts and
throwaway variables live; and when no host is known the fallback name is
`"<receiver> call"`, which turns any local variable into a company.

## 4. Python file and dataframe I/O is invisible

This is the archetype the original complaint was about.

`NBA` reads CSVs (`pd.read_csv` across three files) and imports
`nba_api.stats.endpoints`, an HTTP client to stats.nba.com. Its Boundaries screen shows
**"what it reaches for" empty** and zero data stores.

`powerfab-dashboard` contains **124 `open()` / `read_csv` / `to_csv` sites across its
Python files, and detects none of them**. Its single "file-read" door comes entirely
from one *TypeScript* file (`readdirSync`, `readFileSync` in
`app/scripts/validate-client-configs.ts`), displayed on the Boundaries screen as
"Files on disk · 27 places" — a count of sites within that one TS file. Likewise
"Browser storage" is `localStorage` in the React frontend, not the Python.

> **Correction.** An earlier revision of this document said powerfab-dashboard's MySQL
> store was "inferred from an `os.environ.get(...)` variable name, not from any database
> call," and called all three of its stores "wrong or accidental." That was too strong
> and I got it wrong: `scripts/db.py` genuinely imports pymysql and subclasses
> `pymysql.connections.Connection`, so **MySQL is a correct conclusion.** What is
> actually wrong is narrower: the store's recorded evidence sites are the `os.environ.get(…)`
> lines, so clicking "MySQL" shows you environment reads rather than the pymysql code.
> Right answer, wrong "where in the code" — worth fixing, but not a fabrication.

So the real gap is specific: no `pd.read_csv`/`to_csv`, no `open()`, no `sqlite3`, no
SQLAlchemy engine. Persona question #3 ("where does my data live") goes unanswered in
Python repos, and the pipeline screen's read/write columns are populated by whatever
stray JavaScript the repo happens to contain.

**What works, and should be said plainly:** the pipeline archetype view itself is good.
powerfab-dashboard renders as "113 inputs · 3 data stores" with reads (command line,
environment, files) on the left and writes (browser storage, files, MySQL) on the right.
That is the right frame for a flat repo. It is starved of Python facts, not misconceived.

## 5. Archetype misfires on two of seven repos

- **`psf/requests` → `pipeline`, "Something you run"**, because of "2 command-line entry
  points". Those two are `certs.py` and `help.py`, whose `if __name__ == "__main__":`
  blocks are debug helpers. The most-downloaded Python **library** in the world is
  labelled as a script. This is a regression introduced by our own `__main__`→CLI-door
  change last session, interacting with `archetype.ts` checking `doors.cli > 0` *before*
  `exported > 0`.
- **`powerfab-dashboard` → 111 CLI doors**, including files under `parked/` and
  `scripts/_archive/`. Archived scripts are counted as ways into the application.
- **`NBA` → `library`, "Code other code imports"**, with the reason string "**no doors of
  any kind**" while the same atlas holds 14 export doors and the UI headline says "14
  names in its public API". Nobody imports this repo; it is an analysis. There is no
  archetype that fits a notebook project, so it falls through to the worst-fitting one,
  and the resulting screen is three boxes with an empty column.

## 6. Interaction problems in the walkthrough — the flow you suspected

Confirmed, with specifics:

- **The tour card clips its own body text.** On steps 1 and 5 the text is cut
  mid-sentence after two lines and the remainder sits behind the Back/Next row. Step 5
  ends at "…Anyone who knows the address can reach". The card neither scrolls nor
  expands, so every step longer than two lines is unreadable — and the important steps
  are the long ones.
- **Only 5 of 24 doors get a walkthrough** (`MAX_FLOW_TOURS = 5`), and nothing says
  which or why. `POST /api/posts`, taxonomy's main write path, has none.
- **The walkthrough is unreachable from where you'd start.** The button renders only
  when `tours.find(id === 'tour:' + node.id)` hits. Arriving at `DELETE
  /api/posts/:postId` via Search → Map — the obvious path when you have a route in mind
  — shows a panel with no walkthrough button, even though that route *does* have a tour.
  Tours are discoverable only by scrolling the Overview.

## 7. Smaller things that still cost trust

- **A group card answers with one arbitrary member.** "Pages · 14 pages" opens exactly
  one page; "API routes · 8 routes" opens one route. `BoundaryScreen.tsx:151` does
  `onSelect(card.nodeId ?? card.memberIds[0])` — the full list is in `memberIds` and is
  discarded. (The enumeration the reader wanted exists in the Map's "Ways in" container,
  but nothing links there.)
- **Cloudflare Workers detection silently fails on real repos.** `mirrorquiz` ships
  `wrangler.jsonc` with `main: ".open-next/worker.js"`, a D1 database and a KV
  namespace. None of it is detected, because `resolveEntry()` returns null unless the
  entry file exists on disk and `.open-next/` is a build artifact absent from a fresh
  clone. Written last session; it never worked on the repo it was written for. Declaring
  `main` in the config should be enough — "declared" and "built" are different questions.
- **The Boundaries panel describes controls it doesn't have** — "Press its › button to
  look inside, and the breadcrumb above to come back out" is the Map's interaction model.
  There is no › and no breadcrumb on Boundaries.
- **`NODE_ENV` reported as missing from `.env.example`.** Node sets it; it never belongs
  there. It is the only entry in that section, so it is 100% of that section's signal.
- **NextAuth listed under "3 companies" you send data to.** It is an in-process library.
  Meanwhile the actual third-party processor (Stripe) is absent — the screen is wrong in
  both directions at once.
- **Boundary cards are unlabelled buttons** in the accessibility tree; the text lives in
  nested spans. Screen readers hear "button, button, button".

## 8. Auth detection fails on all three dominant real-world idioms

Completing the roster turned §1 from "a taxonomy problem" into an ecosystem-wide one.
Three different frameworks, three different ways of attaching auth, none detected:

| repo | idiom | reported |
| --- | --- | --- |
| taxonomy | guard inside a local helper the handler calls | 2 of 22 wrong |
| `fastapi/full-stack-fastapi-template` | `CurrentUser = Annotated[User, Depends(get_current_user)]`, used as a parameter type | **21 of 21** "nothing found" |
| `dubinc/dub` | `export const GET = withWorkspace(async ({ workspace, session }) => …)` | **746 of 760** unprotected |

The FastAPI case is the most damning: that is **FastAPI's own official template**, using
the idiom from FastAPI's own documentation, and the Security screen reads "0 checked ·
0 probably checked · 21 nothing found." The dub case is the dominant pattern in
production Next.js (`withAuth`, `withWorkspace`, tRPC's `protectedProcedure`).

Each needs a different mechanism — call-graph walk (#23), type-alias resolution to find
`Depends(...)` inside `Annotated[...]`, and recognising a handler wrapped in a
higher-order function — but they share one symptom: a route the author protected is
displayed as open. At these rates the Security screen is not merely imprecise, it is
inverted.

## 9. FastAPI route addresses omit their router prefixes

The Security screen lists doors as `POST /`, `GET /{id}`, `DELETE /{user_id}`, `GET /me`.
The real addresses are `/api/v1/items/`, `/api/v1/items/{id}`, `/api/v1/users/{user_id}`,
`/api/v1/users/me`: `items.py` declares `APIRouter(prefix="/items")` and `main.py` mounts
the whole thing with `prefix=settings.API_V1_STR`.

So the list of "doors a stranger could knock on" contains addresses that do not exist,
and two different routers both surface as bare `/{id}`-shaped rows the reader cannot tell
apart. Next.js escapes this because its paths come from the file tree; anything with
programmatic mounting (FastAPI, Express `app.use(prefix, router)`, NestJS) needs the
prefixes composed.

## 10. Notebook repos get the library frame, and it gets worse with scale

`ageron/handson-ml3` — 29 notebooks, 37,066 lines, a published ML textbook — renders as
"**225 names in its public API**", with "what consumers can call: 181 functions, 43
types", "what it reaches for" **empty**, and **0 services & stores** for code whose whole
purpose is fetching and transforming datasets.

Nobody imports handson-ml3. The 181 "public API" functions are helpers defined inside
notebook cells. This is the NBA finding (§5) at 10× the size, and it confirms the shape:
a notebook project has no fitting archetype, falls through to `library`, and the library
frame then produces a screen that is confidently and comprehensively about the wrong
thing.

Notebook *reading* is fine — 76% of files carry docstrings App Atlas can read. It is the
framing that fails.

## 11. Scale is fine; the landing scope is not

The giants held up better than expected. No crashes, no cap warnings, no degradation:

| repo | size | scopes | time |
| --- | --- | --- | --- |
| `midday-ai/midday` | 119 MB | 38 (all `apps/*` and `packages/*`, apps vs libraries correctly labelled) | 14.4 s |
| `dubinc/dub` | 32 MB | 10 | 17.5 s |
| `calcom/cal.com` | 346 MB | 113 | 41.3 s |

Monorepo scoping is a genuine strength — the scope switcher works, and midday's 38
scopes are complete and correctly typed.

But **the UI opens on `scopes[0]`** (`web/src/App.tsx`; `scopes.json` carries no
`default` key). For cal.com that is `api-proxy` (`apps/api`), because the list is sorted
by name and "api-proxy" sorts first. `apps/web` — the actual product — is present in the
list and never shown. The largest repos, where orientation matters most, open on their
least representative package, and the reader has 113 dropdown entries to guess among.

A default worth having: the `app`-kind scope with the most files.

## What went right, and should not be lost

- **Notebook support works in the wild.** `game_predictions.ipynb` reports 498 lines
  across 20 cells — the flattened Python, not the JSON envelope. Issue #19 validated on
  a real repo.
- **Search is fast and well-labelled**, and jumping from a search hit into the Map's
  "Ways in" container is the single best navigation moment in the product.
- **The Map's file-level view is excellent**: the POST handler highlighted, dashed arrows
  out to MySQL and NextAuth, breadcrumb `taxonomy › app › api › posts › route.ts`, types
  used, line range.
- **The provenance discipline holds.** "Everything on this page is derived from your code
  by the compiler" and the docs/AI counts are exactly the right instinct — which is
  precisely why the false facts above are so expensive. The page claims it cannot be
  wrong.

## Ranked: what to build next

1. **Follow one hop.** Walk `uses` edges (depth 2–3, same repo) in the auth and outbound
   detectors; badge anything found through a hop as `likely`. Fixes §1 entirely, which is
   most of the trustworthiness problem.
2. **Make the headline honest.** Count only network doors that write or read data;
   exclude PAGE routes and the auth provider's own handler, or split the number into
   "worth a look" and "public on purpose".
3. **Teach the outbound detector to shut up.** Skip test files; never name a service
   after a local variable — no host and no package means no service.
4. **Give Python a data story.** `pd.read_csv`/`to_csv`, `open()`, `sqlite3`,
   SQLAlchemy engines. Without it the flat-repo archetype has no answer to "where does my
   data live".
5. **Fix the tour card clipping**, then widen tour coverage and surface the walkthrough
   button wherever a node has a tour.
6. **Archetype repairs:** rank `exported` above `__main__`-derived CLI doors; ignore
   `_archive/`, `parked/`, and vendored paths when counting doors; add a notebook/analysis
   archetype; and fix the "no doors of any kind" string that contradicts the door count
   on the same screen.
7. **Detect a Worker from a declared `main`**, built or not; surface D1/KV/R2 bindings as
   data stores.
8. **Show group members** instead of `memberIds[0]`.

## Coverage

All 13 planned repos analyzed. Driven in the browser: taxonomy (full protocol),
full-stack-fastapi-template, handson-ml3, powerfab-dashboard, NBA, cal.com. Probed from
the atlas JSON and verified against source: mirrorquiz, daily-briefing, Summarization-2.0,
requests, dub, midday, NASCAR-Analytics.

| repo | archetype | verdict |
| --- | --- | --- |
| taxonomy | web-app ✓ | good frame, 3 false facts (§1, §2) |
| full-stack-fastapi-template | service ✓ | 21/21 false alarms (§8), wrong addresses (§9) |
| dub | web-app ✓ | 746/760 false alarms (§8); monorepo scoping good |
| midday | web-app ✓ | 38 scopes complete and correctly typed |
| cal.com | web-app ✓ | survives 346 MB; lands on the wrong scope (§11) |
| mirrorquiz | web-app ✓ | Workers/D1/KV all missed (§7) |
| daily-briefing | web-app ✓ | Vercel KV missed (§1) |
| powerfab-dashboard | pipeline ✓ | good frame, no Python I/O (§4) |
| Summarization-2.0 | pipeline ✓ | correct |
| NASCAR-Analytics | web-app | 64 files, 4 doors, 0 services |
| requests | pipeline ✗ | should be library (§5); garbage services (§3) |
| NBA | library ✗ | should be analysis (§5) |
| handson-ml3 | library ✗ | should be analysis (§10) |

Archetype is right on 10 of 13. All three misses are the same gap: no archetype fits a
notebook/analysis project, and `__main__` outranks exported surface.

---

# Phase 2 — with the AI backend on

Re-ran taxonomy, mirrorquiz, NBA and powerfab-dashboard through the `claude` backend.
Cost and time were unremarkable: **$2.78 and about 3 minutes for all four** (taxonomy 203
explanations / 96¢ / 54 s; mirrorquiz 148 / 76¢ / 41 s; powerfab-dashboard 157 / 92¢ /
61 s; NBA 4 / 14¢ / 24 s).

The question was narrow: **which phase-1 gaps does prose actually close?**

## P1. Prose closes the briefing gap completely

Phase 1's briefing test failed on every repo — you could not write a stakeholder summary
from the screen. With AI on, taxonomy's Boundaries screen carries this, and it *is* the
brief:

> Your app is a blogging and documentation site where people sign in with GitHub or an
> emailed sign-in link sent through Postmark… a person writes posts in the editor at
> /editor/:postId, which saves to the Post table in your MySQL database… /dashboard/billing
> connects to Stripe through /api/users/stripe to start a paid subscription or open the
> billing portal. Stripe keeps the card details and charges; your database keeps the
> customer and subscription identifiers on the User record… nothing here is sent anywhere
> beyond GitHub, Postmark and Stripe.

That answers all five persona questions in one paragraph, in the reader's own terms, with
real routes and real table names. It is the single highest-value thing in the product.
**Every "the screen says too little" finding from phase 1 is resolved by prose.**

## P2. The AI finds what the detectors miss — on all four repos

| repo | structure says | AI says |
| --- | --- | --- |
| taxonomy | 3 services, no Stripe | "card details go to Stripe", "nothing beyond GitHub, Postmark and Stripe" |
| mirrorquiz | Better Auth, PostHog, Stripe | also names **Anthropic** and **Resend** |
| NBA | 0 services, "what it reaches for" empty | "Pulls NBA stats from the **official NBA API**" |
| powerfab-dashboard | no Python file I/O (§4) | "pull records and **write them to files on disk**", naming the scripts |

This is strong independent confirmation of §1 and §4: the information is plainly present
in the source — an LLM reading the same files finds it immediately. The detectors' one-hop
blindness is the only reason the boxes are empty.

## P3. But this inverts the provenance hierarchy, and the screen now contradicts itself

The product teaches the reader that structure is compiler-derived and "cannot be wrong",
while prose "varies". Phase 2 makes that guidance backwards in the exact cases that
matter:

- On one screen, the boxes say "**3 services out**" (no Stripe) and the paragraph below
  says data goes to "GitHub, Postmark and **Stripe**".
- On `app/api/posts/[postId]/route.ts` the AI file summary reads "*Handles editing and
  deleting a single post, **checking the signed-in user first**, and saving to your
  database*" — while the endpoint badge on the same route says "**no check found**" and
  the walkthrough's final step is still headed "**Nobody is checking who called**".

A reader following our own stated hierarchy believes the compiler and gets the wrong
answer. **Prose does not fix §1 — it exposes it**, and turns a silent error into a visible
contradiction.

## P4. Structural gaps don't stay blank — they become confident wrong prose

The most important phase-2 result. `mirrorquiz` runs on **Cloudflare D1**:
`drizzle.config.ts` declares `dialect: "sqlite"` and `src/db/index.ts` is
`export function getDb(d1: D1Database) { return drizzle(d1, { schema }) }`.

Because Worker/D1 detection never fires (§7 / #29), the atlas offered the AI a generic
"Database" with no engine. The AI filled the blank with the statistically likely answer:

> "quiz and account data sits in your own **Postgres** database (managed through Drizzle)"

That is false, and it is stated in the same confident register as everything true around
it. The AI never mentions Cloudflare, Workers, D1 or KV at all.

This changes how the Tier-2 "silent" items should be weighted: a missing structural fact
is not a blank the reader notices, it is an **invitation for the words layer to guess**.
Every detector gap is a potential false sentence once AI is on.

## P5. Prose does not fix framing

NBA's per-file summaries are good ("Notebook that builds and scores NBA game prediction
models"), but the screen still reads "**225 names in its public API**" with an empty
"what it reaches for", because the archetype and the columns are structural. AI coverage
was also thinnest here — 4 explanations, 14¢ — precisely where phase 1 said the screen was
emptiest.

So §5/§10 (the `analysis` archetype) is **not** rescued by prose and stays on the list at
full weight.

## P6. Papercut: filenames broken by a stray space

powerfab-dashboard's summary renders "`01_list_tables. py`", "`02_describe_tables. py`",
"`03_sample_data. py`" — a space inserted before the extension, four times in one
paragraph. Looks like sentence-splitting applied to prose containing filenames.

## What phase 2 changes about the plan

- **Nothing moves off the list.** No phase-1 finding was invalidated.
- **#23/#32 get more urgent, not less.** With AI on, the false auth claim is now
  contradicted on screen by our own product.
- **#29 gets promoted from Tier 2 to Tier 1**, because its gap now produces a false
  sentence ("Postgres") rather than a blank.
- **New work:** reconcile the two layers — either feed structural facts to the AI as
  constraints, or flag disagreement rather than rendering both silently.

## Caveats

Phase 2 covered 4 of 13 repos, chosen as one per archetype. Cost scales with file count,
and the 400-file AI cap means the giants (cal.com, midday, dub) would only be partly
described; that was not measured.
