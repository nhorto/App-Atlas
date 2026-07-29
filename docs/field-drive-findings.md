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

## 4. On Python, data access is invisible

This is the archetype the original complaint was about, and it is the weakest.

`NBA` reads CSVs (`pd.read_csv` across three files) and imports
`nba_api.stats.endpoints`, an HTTP client to stats.nba.com. Its Boundaries screen shows
**"what it reaches for" empty** and zero data stores.

`powerfab-dashboard` *does* show three stores — and all three are wrong or accidental.
"Files on disk" and "Browser storage" come from stray JavaScript (`rmSync`, `mkdirSync`,
`localStorage`), not from its 238 Python files. "MySQL" is inferred from an
`os.environ.get(...)` variable *name*, not from any database call.

So for Python: no `pd.read_csv`, no `open()`, no `sqlite3`, no SQLAlchemy engine. The
question "where does my data live" — persona question #3 — currently has no answer in
Python repos, and in one case a confidently wrong one.

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

## Caveats

Phase 1 only: no AI descriptions anywhere, so every "the screen says too little" judgment
is provisional and gets retested in phase 2. Findings about screens saying **wrong**
things are unaffected — prose cannot fix a false auth claim.

`dub` and the giant repos (cal.com, midday) were cloned but not yet driven; scale
behavior is still unmeasured.
