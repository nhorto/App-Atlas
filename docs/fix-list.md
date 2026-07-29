# Fix list

Everything the field drive turned up, ranked, with a checkbox each. Phase 1 (13 repos,
no AI) is complete; phase 2 (AI on) appends to the bottom section when it runs.

Evidence for every item is in [field-drive-findings.md](field-drive-findings.md).

**Rule of thumb for the order:** anything that makes a screen state a *falsehood* comes
before anything that makes a screen *incomplete*, because these pages claim to be
compiler-derived and cannot be wrong.

---

## Tier 1 — the tool says false things

- [x] **1. Follow one hop from the handler** — [#23](https://github.com/nhorto/App-Atlas/issues/23)
      Guards and outbound calls reached through a local helper or wrapper module are
      invisible. Causes false "no auth check" *and* missing services. Walk the `uses`
      edges the atlas already resolves (depth 2–3, same repo); badge hop-found guards
      `likely`, not `certain`.
      *Repos: taxonomy, daily-briefing, mirrorquiz.*
      **Done** (`dd9fa2a`). taxonomy's two ownership-checked routes are guarded and
      Stripe appears with all 6 call sites; daily-briefing's Vercel KV storage layer
      appears (it needed a Redis reader that never existed); mirrorquiz gains Anthropic
      and Resend. Guard labels name the helper: `requireOwner → auth`.

- [x] **2. Detect FastAPI `Annotated[..., Depends(...)]` auth** — [#32](https://github.com/nhorto/App-Atlas/issues/32)
      `CurrentUser = Annotated[User, Depends(get_current_user)]` used as a parameter
      type. FastAPI's own template reports **21 of 21 routes unprotected**. Needs
      type-alias resolution, so it is separate work from #23.
      **Done** (`a39a44a`). Decided by shape, not vocabulary: a dependency is a check
      when it raises or returns a 401/403, so `verify_api_key` reads as well as
      `get_current_user`. Also covers custom router subclasses
      (`class UserAPIRouter(APIRouter)` with baked-in dependencies), matched by router
      *variable* so an open router beside a locked one is not falsely claimed.
      Validated on three Python repos the tool had never seen: mealie 2% → 36%,
      Netflix/dispatch found its aliased `CurrentUser` on 35 routes.
      *The FastAPI template itself is still 0% — but for a different reason, now
      [#36](https://github.com/nhorto/App-Atlas/issues/36): its `deps.py` does not
      parse upstream, and we count an unreadable file as unprotected.*

- [x] **3. Detect higher-order auth wrappers** — [#32](https://github.com/nhorto/App-Atlas/issues/32)
      `export const GET = withWorkspace(async ({ session }) => …)`. dub reports **746 of
      760 unprotected**. The dominant pattern in production Next.js and tRPC.
      **Done by item 1, with no code of its own** — walking the reference graph finds
      `withWorkspace → getSession → getServerSession` without anyone writing the name
      `withWorkspace` down. dub: 746 unguarded of 760 → **373**, of which 179 are
      pages (item 6's territory). Sampled the rest by hand: password reset and
      signature-verified callbacks, i.e. genuinely public.

- [ ] **4. Compose router prefixes into route paths** — [#33](https://github.com/nhorto/App-Atlas/issues/33)
      FastAPI doors display as `GET /{id}` when the real address is
      `/api/v1/items/{id}`. `APIRouter(prefix=…)` + `include_router(prefix=…)` must be
      composed. Also affects Express `app.use(prefix, router)` and NestJS.

- [ ] **5. Stop inventing services from tests and variable names** — [#25](https://github.com/nhorto/App-Atlas/issues/25)
      `psf/requests` reports `s call` and `session call` as outside companies. Skip
      `zone === 'test'`; drop the `"<receiver> call"` fallback entirely.

- [ ] **6. Make the auth headline honest** — [#24](https://github.com/nhorto/App-Atlas/issues/24)
      "12 routes have no auth check" where 8 are public marketing pages and 1 is the auth
      provider's own handler. True count: 0. Exclude PAGE routes and auth catch-alls, or
      split into "worth a look" / "public on purpose".

- [ ] **7. Fix the walkthrough card clipping** — [#27](https://github.com/nhorto/App-Atlas/issues/27)
      Body text is cut mid-sentence after two lines and hides behind the Back/Next row.
      Makes the flagship feature unusable on any step longer than two lines. Cheap fix,
      high visibility.

## Tier 2 — the tool is silent where it should speak

- [ ] **8. Give Python a data story** — [#26](https://github.com/nhorto/App-Atlas/issues/26)
      `pd.read_csv`/`to_csv`, `open()`, `sqlite3.connect`, SQLAlchemy `create_engine`.
      powerfab-dashboard has 124 real sites and detects zero; NBA and handson-ml3 show
      empty read/write columns.

- [ ] **9. Add an `analysis` archetype for notebook projects** — [#28](https://github.com/nhorto/App-Atlas/issues/28)
      NBA and handson-ml3 both fall through to `library` and render as a "public API" of
      helper functions nobody imports. Columns should be *where the data comes from* →
      *the analysis* → *what it produces*. Depends on item 8 for the inputs.

- [ ] **10. Rank exported surface above `__main__` CLI doors** — [#28](https://github.com/nhorto/App-Atlas/issues/28)
      `psf/requests` is classified `pipeline` ("Something you run") because two files
      have debug `__main__` blocks. A regression from our own `__main__` work.

- [ ] **11. Ignore archived and parked paths when counting doors** — [#28](https://github.com/nhorto/App-Atlas/issues/28)
      powerfab-dashboard counts `scripts/_archive/` and `parked/` as ways in — 111 CLI
      doors.

- [ ] **12. Detect a Worker from a declared `main`, built or not** — [#29](https://github.com/nhorto/App-Atlas/issues/29)
      mirrorquiz's entry is `.open-next/worker.js`, a build artifact absent from a fresh
      clone, so Workers/D1/KV detection never fires. Never worked on the repo it was
      written for. Also surface D1/KV/R2 bindings as data stores.

- [ ] **13. Land large repos on their main app, not `scopes[0]`** — [#34](https://github.com/nhorto/App-Atlas/issues/34)
      cal.com opens on `api-proxy` out of 113 scopes; `apps/web` is present and never
      shown. Default to the `app`-kind scope with the most files.

- [ ] **14. Show a group card's members** — [#30](https://github.com/nhorto/App-Atlas/issues/30)
      "Pages · 14 pages" opens one arbitrary page; `memberIds` holds the rest and is
      discarded at `BoundaryScreen.tsx:151`.

- [ ] **15. Widen and surface walkthroughs** — [#27](https://github.com/nhorto/App-Atlas/issues/27)
      Only 5 of 24 doors get one, nothing says which, and the button is absent when you
      arrive via Search → Map even for routes that *do* have a tour.

## Tier 3 — polish and trust papercuts

- [ ] **16. Point a store's evidence at the real call site** — [#26](https://github.com/nhorto/App-Atlas/issues/26)
      powerfab-dashboard's MySQL store is a correct conclusion but its sites are
      `os.environ.get(…)` lines rather than the pymysql code.

- [ ] **17. Fix the Boundaries panel's instructions** — [#30](https://github.com/nhorto/App-Atlas/issues/30)
      Describes a `›` button and a breadcrumb that exist only on the Map.

- [ ] **18. Ignore runtime-set env vars** — [#30](https://github.com/nhorto/App-Atlas/issues/30)
      `NODE_ENV` flagged as missing from `.env.example`; it is 100% of that section's
      signal on taxonomy. Also `PORT`, `CI`, `VERCEL*`, `NEXT_RUNTIME`.

- [ ] **19. Don't list in-process libraries as companies** — [#30](https://github.com/nhorto/App-Atlas/issues/30)
      `next-auth` appears under "3 companies you send data to".

- [ ] **20. Label boundary cards for screen readers** — [#30](https://github.com/nhorto/App-Atlas/issues/30)
      Bare `button` elements; text lives in nested spans.

- [ ] **21. Fix the self-contradicting archetype reason** — [#28](https://github.com/nhorto/App-Atlas/issues/28)
      NBA's reason reads "no doors of any kind" while the headline above says "14 names
      in its public API".

---

## Found while fixing

Both surfaced by running the fixes against repos the tool had never seen, which is the
point of doing that rather than only re-checking the repos that produced the list.

- [ ] **25. An unreadable file is counted as unprotected** — [#36](https://github.com/nhorto/App-Atlas/issues/36) — *Tier 1*
      `fastapi/full-stack-fastapi-template`'s `deps.py` does not parse (a Python 2
      `except` clause, upstream, verified against raw.githubusercontent). We record the
      warning **and** print "21 of 21 routes unprotected" — every one of which is
      guarded, by the alias declared in the file we could not read. The warning and the
      headline never meet. Auth coverage has to degrade to "I could not read N files",
      never to zero. Generalizes to any parse failure.

- [ ] **26. Auth applied by ASGI middleware is invisible** — [#37](https://github.com/nhorto/App-Atlas/issues/37) — *Tier 2*
      `Netflix/dispatch` mounts its routers under a sub-application and checks callers
      in Starlette middleware. 163 of 198 routes read as open. This is the third
      mechanism for the same idea — we handle route dependencies and Next.js
      middleware, and this is how large Python services normally do it.

## How these fixes avoid being fitted to the test repos

Worth writing down, because the failure mode is easy and invisible:

- **#23 names nothing.** It walks the compiler's own reference graph, which is why
  dub's `withWorkspace` was found without that string appearing anywhere in this repo.
- **#32 decides by shape.** "Is this dependency a check?" is answered by whether the
  function turns strangers away with a 401 or 403 — a fact about the code. The fixture
  in `test/fixtures/pyauth` is deliberately hostile to vocabulary matching: its checker
  is called `who_is_asking`, and a decoy dependency called `fetch_tenant` is correctly
  *not* treated as a lock.
- **Every fix is checked on a repo that did not produce the finding.** mealie,
  dispatch and a fresh FastAPI template were cloned for exactly this, and two of the
  three surfaced new bugs rather than confirming the old ones.

---

## Confirmed working — do not regress

- Notebook reading (`.ipynb`) holds up in the wild: `game_predictions.ipynb` → 498 lines
  across 20 cells, flattened Python not JSON envelope; handson-ml3 76% documented.
- Monorepo scoping: midday's 38 scopes complete, apps vs libraries correctly typed.
- Scale: cal.com 346 MB / 113 scopes / 41 s, no crash, no cap hit.
- Archetype correct on 10 of 13 repos; the service and pipeline frames are genuinely good.
- Search, and the Map's file-level view with outbound arrows.
- The provenance discipline and the Security screen's "nothing found ≠ exploitable"
  disclaimer.

---

## Phase 2 additions

Ran taxonomy, mirrorquiz, NBA and powerfab-dashboard with the `claude` backend —
$2.78 and ~3 minutes for all four. Nothing came off the list; two things moved up.

- [ ] **22. Stop the two layers contradicting each other on screen** — [#35](https://github.com/nhorto/App-Atlas/issues/35) — *Tier 1*
      With AI on, the boxes say "3 services out" while the paragraph below says data goes
      to Stripe; the badge says "no check found" while the file summary says "checking the
      signed-in user first". **The AI is right and the compiler-derived box is wrong**,
      which inverts what the UI tells the reader to trust. Anchor the prose to structural
      facts, and treat prose that names something the structure lacks as a signal the
      detector missed it.

- [ ] **23. Give the AI "not visible in the code" as an option** — [#35](https://github.com/nhorto/App-Atlas/issues/35) — *Tier 1*
      mirrorquiz runs on Cloudflare D1; because #29 never fires, the atlas offered a
      generic "Database" and the AI confidently wrote "your own **Postgres** database".
      A structural gap is not a blank — it is an invitation to guess.

- [ ] **24. Fix filenames broken by a stray space** — *Tier 3*
      powerfab-dashboard's summary renders "`01_list_tables. py`", "`02_describe_tables. py`"
      — four times in one paragraph. Looks like sentence-splitting applied to text
      containing filenames.

### Re-ranking after phase 2

- **Item 12 (#29, Cloudflare detection) moves from Tier 2 to Tier 1.** Its gap no longer
  produces a blank; it produces the false sentence "Postgres".
- **Items 1–3 (#23, #32) get more urgent.** With AI on, the false auth claim is now
  contradicted on screen by our own product, so the inconsistency is visible to the user.
- **Item 9 (analysis archetype) stays at full weight.** Prose does not fix framing: NBA's
  file summaries are good, but the screen still reads "225 names in its public API" with
  an empty "what it reaches for", because archetype and columns are structural.

### What phase 2 settled

Every phase-1 "the screen says too little" finding **is** resolved by prose — taxonomy's
AI paragraph is a genuine stakeholder brief and answers all five persona questions. The
words layer works and is cheap. What it cannot do is correct a false structural fact; it
can only expose it, or inherit the gap and guess.
