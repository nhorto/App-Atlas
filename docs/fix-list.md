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

- [x] **4. Compose router prefixes into route paths** — [#33](https://github.com/nhorto/App-Atlas/issues/33)
      FastAPI doors display as `GET /{id}` when the real address is
      `/api/v1/items/{id}`. `APIRouter(prefix=…)` + `include_router(prefix=…)` must be
      composed. Also affects Express `app.use(prefix, router)` and NestJS.
      **Done.** `boundaries/mounts.ts` assembles the address from the three files that
      each hold a third of it, before anything is merged. Six mount spellings across
      both languages: FastAPI `include_router`, Starlette `mount`, Flask
      `register_blueprint`, Express `use`, Hono `route`, NestJS `setGlobalPrefix`.
      FastAPI template: every one of 23 routes now reads `/api/v1/…`, resolved through
      `prefix=settings.API_V1_STR`. mealie 183 routes, 182 fully composed. dispatch 196
      of 200 at `/api/v1/…`. midday's Hono API 12 doors → **18**, all composed.
      *The undercount underneath it:* a door's identity is its address, so `GET /` in
      `items.py` and `GET /` in `users.py` were **one node**. Composing first split them
      — the FastAPI template went 21 doors → 23 with no new routes written.

- [x] **5. Stop inventing services from tests and variable names** — [#25](https://github.com/nhorto/App-Atlas/issues/25)
      `psf/requests` reports `s call` and `session call` as outside companies. Skip
      `zone === 'test'`; drop the `"<receiver> call"` fallback entirely.
      **Done** (`d8f93eb`). The fallback is gone: with no literal URL there is no
      destination to report, and a blank costs the reader less than a vendor that does
      not exist. Test files no longer contribute services, stores or exported surface.
      requests 4 services → 0; the FastAPI template's frontend surface 246 → 235;
      dub's 21 services and 4 stores unchanged, so nothing real was lost.
      *Doors stay exempt from the zone filter — dub ships a real webhook at
      `.../webhook/test/route.ts`, and losing a real door beats listing a fixture.*

- [x] **6. Make the auth headline honest** — [#24](https://github.com/nhorto/App-Atlas/issues/24)
      "12 routes have no auth check" where 8 are public marketing pages and 1 is the auth
      provider's own handler. True count: 0. Exclude PAGE routes and auth catch-alls, or
      split into "worth a look" / "public on purpose".
      **Done** (`328f24a`), folded together with **#36**. `model/exposure.ts` splits
      every unchecked door by *why* — `page`, `auth-mount`, `unreadable`,
      `worth-a-look` — and splits rather than hides: each door stays on screen carrying
      the fact that explains it, and only the unexplained ones reach the headline.
      taxonomy 10 → **1**; dub 373 → **193**; midday 151 → 60; cal.com 190 → 116.
      `authHeadline()` writes the sentence once for the CLI, the per-app line, the
      walkthrough and the brief, so no two screens can quote different totals.

- [x] **7. Fix the walkthrough card clipping** — [#27](https://github.com/nhorto/App-Atlas/issues/27)
      Body text is cut mid-sentence after two lines and hides behind the Back/Next row.
      Makes the flagship feature unusable on any step longer than two lines. Cheap fix,
      high visibility.
      **Done** (`5accb88`). `.wt-body` was a flex item with `min-height: auto`, so it
      grew past the drawer instead of scrolling inside it; the bar and buttons could be
      squeezed by the overflow. Cap raised from 52% to 68% — still a max, so a short
      step stays short. And the scrollbar is now always visible when there is more to
      read: macOS overlay scrollbars hid the only signal that a step continued.

## Tier 2 — the tool is silent where it should speak

- [x] **8. Give Python a data story** — [#26](https://github.com/nhorto/App-Atlas/issues/26)
      `pd.read_csv`/`to_csv`, `open()`, `sqlite3.connect`, SQLAlchemy `create_engine`.
      powerfab-dashboard has 124 real sites and detects zero; NBA and handson-ml3 show
      empty read/write columns.
      **Done.** Three readings, strongest first: a database call, then a library that
      names its format out loud, then a bare `open()`. A line already read by a stronger
      rule is not read again, so `pd.read_csv(open(p))` is one dataset rather than a
      dataset and a file. powerfab lands **134 `open()` sites** it detected none of;
      NBA gets *CSV files · 6 reads · 1 write*; handson-ml3 gets six boxes across CSV,
      Excel, JSON, NumPy and joblib, read out of its notebooks.
      *The format comes from the call, never from the path.* `open("report.json", "w")`
      and `open(out_path, "w")` are the same code written two ways, and splitting them
      would let an inlined string decide which box a reader sees.
      Databases gained the verb every DB-API client actually uses: `execute`, read as
      SQL. A literal `SELECT` needs no import to be believed — a repo of scripts reaches
      its connection through a helper module, so the statement is the evidence — and
      those unnamed queries fold into the one named client at merge time, because two
      boxes for one database reads as an app with two databases. powerfab's MySQL box
      went from 5 sites (all of them wrong, see 16) to **102, with 32 real tables**.
      SQLAlchemy 2.0's `session.execute(select(User))` is read through the builder,
      inline or bound to a name a line above.

- [x] **9. Add an `analysis` archetype for notebook projects** — [#28](https://github.com/nhorto/App-Atlas/issues/28)
      NBA and handson-ml3 both fall through to `library` and render as a "public API" of
      helper functions nobody imports. Columns should be *where the data comes from* →
      *the analysis* → *what it produces*. Depends on item 8 for the inputs.
      **Done.** Two signals, either enough: a notebook (nobody writes one to ship it),
      or a store the code *reads* whose client is pandas, polars, NumPy or joblib — item
      8's output, which is why this could not be built before it. The read is what
      matters; a library that writes a CSV is not doing analysis.
      And the columns turned out to be the bigger half. For an app the request comes
      first and the database is somewhere data is put; for an analysis the data comes
      first. A store with reads is now drawn on the **left** for `analysis` and
      `pipeline` — which also settles a promise the pipeline caption had been making
      since archetypes were built, since "What it reads" had until now been a column of
      environment variables. NBA reads *Where the data comes from: CSV files · 6 reads* →
      *The analysis* → *What it produces: CSV files · 1 write*.
      *A store that is read and written appears on both sides.* That is the shape of the
      work, not a duplicate — and it is the same node, so either card opens the same box.

- [x] **10. Rank exported surface above `__main__` CLI doors** — [#28](https://github.com/nhorto/App-Atlas/issues/28)
      `psf/requests` is classified `pipeline` ("Something you run") because two files
      have debug `__main__` blocks. A regression from our own `__main__` work.
      **Done**, but not by counting. Counting cannot separate those two files from the
      thirty-five around them — and `Summarization-2.0` has exactly two `__main__` files
      too, out of two, and *is* a thing you run. What separates them is the `setup.py`
      sitting beside one of them. A manifest that says "install me and import me" is a
      decision somebody wrote down, and it outranks an idiom; with no manifest, a folder
      of runnable scripts is exactly what this is.
      A designed command line — argparse, Click, Typer, a `bin` — still beats everything:
      someone wrote the flags down. `requests` is a library again, and its two runnable
      files are still named in the verdict.

- [x] **11. Ignore archived and parked paths when counting doors** — [#28](https://github.com/nhorto/App-Atlas/issues/28)
      powerfab-dashboard counts `scripts/_archive/` and `parked/` as ways in — 111 CLI
      doors.
      **Done.** A door somebody cannot use is not a way in, and a count that includes
      them is a count nobody can act on. The list is deliberately short and deliberately
      excludes bare `archive`, `old`, `legacy` and `backup`: a Next.js app ships
      `app/api/archive/route.ts`, and dropping a real door because a folder is called
      `archive` is a far worse error than counting a dead one. What is left is either
      explicitly parked or wears the underscore that means "not part of the build".

- [x] **12. Detect a Worker from a declared `main`, built or not** — [#29](https://github.com/nhorto/App-Atlas/issues/29)
      mirrorquiz's entry is `.open-next/worker.js`, a build artifact absent from a fresh
      clone, so Workers/D1/KV detection never fires. Never worked on the repo it was
      written for. Also surface D1/KV/R2 bindings as data stores.
      **Done** (`555e68b`). `declaredEntry` is what the config says; `entry` is what is
      on disk. The door is real either way and hangs off nothing when there is nothing
      to hang it off. D1/KV/R2/Durable Objects/Hyperdrive/Vectorize become stores with
      0 reads and 0 writes — a declaration, not a call site. Queue *producers* are
      deliberately not stores. mirrorquiz now names Cloudflare Workers among its
      frameworks and shows `perception-quiz-db (Cloudflare D1)`.
      *The ORM store is deliberately left as its own box rather than folded in:
      guessing the one Drizzle client points at the one D1 database is right most of
      the time, and wrong prints a false sentence about where data lives.*

- [x] **13. Land large repos on their main app, not `scopes[0]`** — [#34](https://github.com/nhorto/App-Atlas/issues/34)
      cal.com opens on `api-proxy` out of 113 scopes; `apps/web` is present and never
      shown. Default to the `app`-kind scope with the most files.
      **Done.** The order *was* the answer — the CLI, the server and the web app all
      take `scopes[0]` — so the biggest app now leads and everything after it stays
      alphabetical. Only one scope moves: a switcher sorted by size is unpredictable to
      scan, one that is alphabetical after its first entry is not. cal.com lands on
      `apps/web` (991 files) instead of `api-proxy` (12); dub on `apps/web` (3371);
      midday on `apps/dashboard` (724). Counting costs **245 ms** across cal.com's 113
      packages — one walk, each file charged to the longest directory containing it so
      a nested package is not counted twice. The count is deliberately not kept on the
      scope: it is rougher than the per-app number the CLI prints (no gitignore, no
      `--max-files`), and two numbers with one name that disagree is its own small lie.

- [x] **14. Show a group card's members** — [#30](https://github.com/nhorto/App-Atlas/issues/30)
      "Pages · 14 pages" opens one arbitrary page; `memberIds` holds the rest and is
      discarded at `BoundaryScreen.tsx:151`.
      **Done.** A group card opens the list and the reader picks. The card carries its
      members' names now, not only their ids, so the list can be drawn without a second
      request. Verified on taxonomy: Pages opens all 14, API routes all 8, and clicking
      `/dashboard/billing` opens `app/(dashboard)/dashboard/billing/page.tsx`.

- [x] **15. Widen and surface walkthroughs** — [#27](https://github.com/nhorto/App-Atlas/issues/27)
      Only 5 of 24 doors get one, nothing says which, and the button is absent when you
      arrive via Search → Map even for routes that *do* have a tour.
      **Done.** All three were one bug wearing three coats: five was the number we
      *offered*, and it had quietly become the number that existed. A walkthrough is now
      built for whatever the reader opens (`GET /api/tour?id=`), so taxonomy goes from
      **5 of 24 doors to 24 of 24** — the offered handful stays a handful, because
      twenty-four cards is a directory rather than a suggestion, and the overview says
      out loud that there are more. Arriving at a *handler* offers the walk of the door
      that leads to it, which is the question somebody who searched their way to
      `route.tsx` is actually asking; the button names that door, because "walk me
      through what happens" beside a helper function is a promise about the wrong thing.
      Exactly one door or nothing. The only doors still without a walk are the ones with
      nothing behind them — no code, no guard, one step — and a one-step tour is not a
      tour.

## Tier 3 — polish and trust papercuts

- [x] **16. Point a store's evidence at the real call site** — [#26](https://github.com/nhorto/App-Atlas/issues/26)
      powerfab-dashboard's MySQL store is a correct conclusion but its sites are
      `os.environ.get(…)` lines rather than the pymysql code.
      **Done**, with 8. The old rule read the method name and nothing else, so
      `os.environ.get("MYSQL_HOST")` was a `get` on something and became database
      evidence. A receiver now has to be a handle: bound from the client
      (`conn = pymysql.connect(...)`, `cur = conn.cursor()`), or named like one, matched
      a word at a time so `db_session` counts and `form_data` does not.
      *This removed more than it added, and that was the point.* Netflix/dispatch had
      **1,278 sites** on its database box; 633 of them were never database calls —
      `form_data.get`, `payload.get`, `scheduler.add`, and 57 `@router.get`/`@router.delete`
      decorators, the route declarations themselves. Its **entire PostgreSQL box** was
      five `.get(…)` calls in an AWS SQS plugin: a whole database that does not exist.

- [x] **17. Fix the Boundaries panel's instructions** — [#30](https://github.com/nhorto/App-Atlas/issues/30)
      Describes a `›` button and a breadcrumb that exist only on the Map.
      **Done.** The panel is told which screen it is beside and says something true of
      that screen. Instructions for a control that is not on the page are worse than no
      instructions: the reader hunts for it, does not find it, and now has a reason to
      doubt everything else the panel says.

- [x] **18. Ignore runtime-set env vars** — [#30](https://github.com/nhorto/App-Atlas/issues/30)
      `NODE_ENV` flagged as missing from `.env.example`; it is 100% of that section's
      signal on taxonomy. Also `PORT`, `CI`, `VERCEL*`, `NEXT_RUNTIME`.
      **Done** (`eb7220f`). Badged "set by the platform" — shown, not hidden, and
      excluded from a count whose whole meaning is "you forgot these". taxonomy's
      undocumented count 1 → **0**.
      *Writing the rule immediately produced a worse bug than the one it fixed:*
      `GITHUB_` looked like a safe family, because CI injects a dozen of them, and it
      swallowed `GITHUB_CLIENT_SECRET` and `GITHUB_ACCESS_TOKEN` — the app's own OAuth
      credentials, and the most important rows on the screen. A name that looks like a
      credential is never excused now, whatever prefix it wears.

- [x] **19. Don't list in-process libraries as companies** — [#30](https://github.com/nhorto/App-Atlas/issues/30)
      `next-auth` appears under "3 companies you send data to".
      **Done** (`eb7220f`). `next-auth`, `@auth/core`, `lucia` and `better-auth` run
      inside the app and keep their sessions in the app's own database. Clerk, Auth0 and
      WorkOS stay — your app really does call their servers. taxonomy 4 services → 3.
      *Removing the service box broke the "this is the sign-in door" verdict, which had
      been using it as a proxy for the fact it actually cares about — the auth package
      being imported in that file. That fact is now stamped on the file node by the
      layer that owns the catalog, so `src/model` reads a plain field instead of
      importing the analyzer.*

- [x] **20. Label boundary cards for screen readers** — [#30](https://github.com/nhorto/App-Atlas/issues/30)
      Bare `button` elements; text lives in nested spans.
      **Done.** Four nested spans concatenated into one breath — "API routes 12 routes
      3 open". Every card now carries an explicit label, read back from the live a11y
      tree as *"API routes. 8 routes. 1 with no auth check found. opens the list"*, and
      group cards expose `aria-expanded`.

- [x] **21. Fix the self-contradicting archetype reason** — [#28](https://github.com/nhorto/App-Atlas/issues/28)
      NBA's reason reads "no doors of any kind" while the headline above says "14 names
      in its public API".
      **Done.** It says "nothing answers a URL", which stays true after the exported
      names become doors a moment later. The second half of the same sentence was wrong
      too: "28 exported names" sat under a headline reading "118 names in its public
      API", because the reason counts *files* on purpose and called them names. It now
      says "28 files other code can import".

---

## Found while fixing

All of these surfaced by running the fixes against repos the tool had never seen, which
is the point of doing that rather than only re-checking the repos that produced the
list. Two of them are bugs the fix-list itself would never have found: nobody reports a
door that was never drawn.

- [x] **25. An unreadable file is counted as unprotected** — [#36](https://github.com/nhorto/App-Atlas/issues/36) — *Tier 1*
      `fastapi/full-stack-fastapi-template`'s `deps.py` does not parse (a Python 2
      `except` clause, upstream, verified against raw.githubusercontent). We record the
      warning **and** print "21 of 21 routes unprotected" — every one of which is
      guarded, by the alias declared in the file we could not read. The warning and the
      headline never meet. Auth coverage has to degrade to "I could not read N files",
      never to zero. Generalizes to any parse failure.
      **Done** (`328f24a`), with #24. Files that will not parse are marked on the node
      (`meta.unread`), so the caveat survives the cache and names the file. A route
      whose own file directly imports one reads `not examined`, never `unprotected` —
      one hop, deliberately, so a single unreadable utility deep in a large repo cannot
      excuse every door in it. The template now says *21 of 21 routes behind a file I
      could not read*, and names `app/api/deps.py`.

- [x] **26. Auth applied by ASGI middleware is invisible** — [#37](https://github.com/nhorto/App-Atlas/issues/37) — *Tier 2*
      `Netflix/dispatch` mounts its routers under a sub-application and checks callers
      in Starlette middleware. 163 of 198 routes read as open. This is the third
      mechanism for the same idea — we handle route dependencies and Next.js
      middleware, and this is how large Python services normally do it.
      **Done.** The diagnosis was half wrong, and the half that was wrong was the
      expensive part: dispatch has no auth middleware at all. Its API is locked by
      `api_router.include_router(rest, dependencies=[Depends(get_current_user)])` — a
      check handed to the **mount**. Both mechanisms are now read, because both are how
      a large service normally does it, and both are invisible from the files that
      declare the routes. A router is behind a check when every mount of it is behind
      one; a router that also answers at a second, open address stays open. Middleware
      counts only when the thing attached turns callers away — `add_middleware` is how
      gzip is attached too, so the evidence is a 401 in the class's `dispatch`, never
      the word `Auth` in its name. **165 of 200 open → 6**, and those six are the
      healthcheck, the login route, and four Slack webhooks that verify a signature
      instead. Underneath it was an extractor bug: `Depends(get_current_user)` reached
      the Node side as `Depends()`, so the one name that mattered had already been
      thrown away.

- [x] **34. A controller class inherits the check its handlers never mention** —
      *Tier 2, found while fixing #37.* `mealie` read **130 of 189 routes** as having no
      visible check. Its routers are plain, and its handlers are methods of
      `AdminBackupController(BaseAdminController)`; two classes up the hierarchy,
      `BaseUserController` declares `user: PrivateUser = Depends(get_current_user)` as a
      class attribute. That is the class-based-view idiom (`@controller(router)`), and it
      is a fifth spelling of "the lock is in the wiring".
      **Done. mealie: 130 of 189 → 25 of 189**, and the 25 are its deliberately public
      surface — the login and password-reset routes, `/api/explore/…`, `/api/media/…`,
      the signup validators and the token-shared recipe links. A class is recorded with
      its own `Depends(...)` targets *and* its bases, even when it carries nothing
      itself: a class that only inherits is a link in the chain, and a chain missing one
      link loses every route below it. The chain is followed by name, repo-wide, one
      declaration or nothing. The negative case is what keeps it honest — mealie's
      `BasePublicController` inherits the same `_BaseController`, whose dependencies
      fetch a session and a locale and refuse nobody, so its routes stay open and say so.

- [x] **27. A door's identity was its address, and its address was wrong** — *Tier 1,
      fixed by #33.* `makeEndpointId` keys on `method + route`, so two files each
      declaring `@router.get("/")` produced one node. Not a display bug: the count on
      the Boundaries screen, the auth denominator and the brief were all short by the
      number of collisions, and nothing anywhere said so. The FastAPI template was
      quietly reporting 21 doors where the app serves 23. Fixed by composing the
      prefixes *before* the merge rather than after.

- [x] **29. A workspace list describes the packages, not the repo** — *Tier 1.*
      Sentry declares three workspace packages — `api-docs` and two eslint plugins,
      sixty files between them — and its application, several thousand Python files at
      the root, is in none of them. The switcher offered those three and nothing else,
      so the whole tool reported on sixty files of tooling and called it Sentry, in six
      tenths of a second, with no warning that anything had been left out.
      **Done.** The repo is a scope of its own when the code no package claims outweighs
      every package — a root smaller than its smallest package is a build script, and a
      scope for that would be one more wrong entry rather than one less. cal.com, dub
      and midday are untouched. Sentry now reads 5,000 files and shows *Django ORM ·
      2,901 reads · 588 writes · 289 tables*.

- [x] **30. The tool went quiet on exactly the repos that need it** — *Tier 1.*
      `nodes.push(...result.nodes)` passes every element as a separate argument, so past
      a few tens of thousands it overflows the stack. Sentry hit it. Because the CLI
      catches a failing scope so one bad package cannot cost you the other five, the
      only sign was the words *could not be read* beside the repo's own name.
      **Done.** `appendAll` on every project-wide list. The size at which the spread
      breaks is the engine's, not ours, and it is exactly the size at which somebody
      most needs a map.

- [x] **31. A warning that contradicted the screen it was printed on** — *Tier 3.*
      Every monorepo run began with "M1 analyzes the whole tree as one atlas; per-app
      scopes arrive in M5" — printed directly above the list of per-app scopes. A
      warning the reader can see is false teaches them to skip the warnings, which is
      where the real ones live. **Done.** Removed.

- [x] **28. A webhook is recognised by a path we now know better** — *Tier 3, and it
      turned out to be Tier 1.* `isWebhookPath` ran in the Python detector, on the route
      as its own file spells it, so re-checking the kind once the address is composed
      looked like a small unification.
      **Done, in the other direction.** Composing the address first would have made the
      hole *bigger*, because a route promoted to `webhook` leaves the auth denominator
      entirely — and the merge layer promotes on the word in the address alone, pushing
      no guard when it does. `/api/webhooks/anything` with nothing verifying anything
      was a door a stranger could post to, and it was leaving the security count without
      ever being reported once. So the promotion stays (the author's own word for the
      door is worth showing, and it groups the boundary screen correctly), and the
      question the auth count asks changed: **not what the door is called, but whether
      anything is checking the caller.** A signature check is the lock; a path is not.
      One rule now, in `model/exposure.ts`, for the headline, the security screen and
      the brief — the Python-side copy is gone, which is the unification the item wanted.
      mealie's six `/webhooks/…` routes are actually CRUD over webhook *subscriptions*
      and were silently exempt: 124 of 183 → **130 of 189**. taxonomy and dispatch are
      unchanged to the number, because their webhooks verify signatures and have earned
      the exemption.

- [x] **32. A single-page app was filed as a library** — *Tier 1.* Found while doing 9.
      `full-stack-fastapi-template`'s React frontend routes in the browser, so no door
      detector fires and nothing catches it — it landed under "Code other code imports",
      with 235 of its own components listed as the public API nobody imports.
      **Done.** A UI framework plus interface files plus *no manifest saying where to
      import this from* is an app. The manifest is what keeps a component library out:
      `cal.com/packages/ui` and `dub/packages/ui` both declare `exports` and both stay
      libraries. `private: true` is deliberately not consulted — it means "do not publish
      to the registry", which every internal package in a monorepo says.

- [x] **33. "Files on disk" was a door and a store at the same time** — *Tier 3.* Found
      while doing 9. `jobs.ts` emitted a `file-read` door called "Files on disk" and
      `data.ts` emitted a filesystem store called "Files on disk". Two columns hid it
      until a pipeline's read stores moved to the left, where they sat side by side.
      **Done.** The filesystem is a store; reading is one of the two things you do to
      one. The TypeScript detector now counts `readFile` and `readdirSync` as store
      reads, matching what Python already did, and the door is gone. powerfab reads one
      *Files on disk · 113 reads · 60 writes* instead of two boxes with one name. The
      `file-read` kind stays in the type — older atlases still carry it — and nothing
      emits it.

## How these fixes avoid being fitted to the test repos

Worth writing down, because the failure mode is easy and invisible:

- **#23 names nothing.** It walks the compiler's own reference graph, which is why
  dub's `withWorkspace` was found without that string appearing anywhere in this repo.
- **#32 decides by shape.** "Is this dependency a check?" is answered by whether the
  function turns strangers away with a 401 or 403 — a fact about the code. The fixture
  in `test/fixtures/pyauth` is deliberately hostile to vocabulary matching: its checker
  is called `who_is_asking`, and a decoy dependency called `fetch_tenant` is correctly
  *not* treated as a lock.
- **#24 splits, it never hides.** Every unchecked door stays on the screen; what
  changes is that the ones with a structural explanation carry it and stop inflating
  the headline. "auth-mount" needs two independent facts to agree — a catch-all route
  *and* the auth provider's package in that file — because either alone would excuse
  an ordinary route that merely asks who is calling. `test/fixtures/exposure` proves
  it: a route importing `next-auth` and checking nothing is still `worth-a-look`.
- **#25 removes rather than renames.** The rule is not "which variable names are not
  companies" but "with no destination in the code, say nothing".
- **#33 follows a link only when exactly one file answers to it**, the same rule the
  Python import resolver already used. Two candidates means we do not know which, and a
  prefix we cannot read becomes a visible `…` rather than a shorter address that looks
  finished. Across all sixteen clones exactly **one** door carries that marker, and it
  earns it: mealie builds a prefix out of an f-string.
- **#28 asks a manifest, not a repo.** "Is this a library?" is answered by a `setup.py`
  or an `exports` field — a sentence somebody wrote about their own code — never by
  counting how many files happen to have a `__main__`. The same lever decides whether a
  React package is an app or a component library, and it gives the right answer for
  `cal.com/packages/ui` and `full-stack-fastapi-template/frontend` without either being
  named anywhere.

- **#26 believes the call, not the name.** A format is only claimed when the library
  spells it (`read_parquet`), never when a path happens to end in `.parquet`; a database
  read is only claimed when the SQL says so or the receiver was built by a client we can
  see. Both rules are about the *shape of the code*, which is why they carried straight
  from a FastAPI app to a folder of Jupyter notebooks with nothing added for either.

- **#16 removed 633 findings from the repo it was tested against.** The measure of that
  fix is not what it found — it is what it stopped claiming, and none of what it stopped
  claiming was specific to Netflix/dispatch. `form_data.get` and `@router.get` are how
  everybody writes FastAPI.

- **#29 decides by weight, not by name.** "Is the root a scope?" is answered by whether
  the code outside the declared packages outweighs every package — no list of repos, no
  guess about what Sentry looks like. cal.com, dub and midday all answer no.

- **#33 also models where the frameworks disagree.** Flask's
  `register_blueprint(bp, url_prefix=…)` *replaces* the blueprint's own prefix where
  FastAPI's `include_router` concatenates. Treating them alike would print
  `/api/orders/orders/<id>` — a wrong address given with total confidence, which is
  exactly the failure this whole list exists to stop.
- **Every fix is checked on a repo that did not produce the finding.** mealie,
  dispatch and a fresh FastAPI template were cloned for exactly this, and two of the
  three surfaced new bugs rather than confirming the old ones. The #24/#25/#29 work
  was measured across all thirteen clones, not only the ones named in the item.

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

- [x] **22. Stop the two layers contradicting each other on screen** — [#35](https://github.com/nhorto/App-Atlas/issues/35) — *Tier 1*
      With AI on, the boxes say "3 services out" while the paragraph below says data goes
      to Stripe; the badge says "no check found" while the file summary says "checking the
      signed-in user first". **The AI is right and the compiler-derived box is wrong**,
      which inverts what the UI tells the reader to trust. Anchor the prose to structural
      facts, and treat prose that names something the structure lacks as a signal the
      detector missed it.
      **Done, both halves.** The overview prompt now says the lists it was given are
      everything we found, and that the paragraph sits directly under a diagram drawn
      from the same lists — so a company in the sentence and not in the diagram makes the
      reader distrust both.
      And when it happens anyway, the run says so: a company from the catalog that the
      prose names and no detector found is printed as a lead — *"The description names
      SendGrid, which no detector found. Either the write-up over-reached or something
      real is missing from the map."* Deliberately a line in the report and **not** a box
      on a screen: a generated sentence is not evidence, and letting prose promote itself
      into a fact is the one thing this layering exists to prevent. Only catalog names
      count; a word the tool has never heard of is not evidence of a gap.
      **Driven against a live model.** `mirrorquiz` re-run with `--ai-backend claude`,
      148 explanations written: every company the paragraph names — Stripe, Anthropic,
      Resend, PostHog — is in the diagram beside it, and no contradiction line fired,
      because none was warranted.

- [x] **23. Give the AI "not visible in the code" as an option** — [#35](https://github.com/nhorto/App-Atlas/issues/35) — *Tier 1*
      mirrorquiz runs on Cloudflare D1; because #29 never fires, the atlas offered a
      generic "Database" and the AI confidently wrote "your own **Postgres** database".
      A structural gap is not a blank — it is an invitation to guess.
      **Done.** Two rules, because the failure had two halves. *Never add detail the
      facts do not have* — if they say "Database", write "the database", not Postgres;
      being more specific than the facts is the one way to be confidently wrong. And *a
      blank means nobody could see it, not that it is absent*: "No data store found" no
      longer appears as a flat assertion, it reads "No data store was detected. That may
      mean there is none, or that we could not see it. Do not name one." Same wording for
      ways in and for outside services.
      **The sentence that raised this item is gone.** Live re-run of `mirrorquiz`: the
      write-up now says data lives in *"your `perception-quiz-db` database"* — the name
      out of the Cloudflare config, not a database engine nobody mentioned. The two
      fixes met in the middle: #29 gave the facts a real name to carry, and the prompt
      change stopped the model reaching past them when they have none.

- [x] **24. Fix filenames broken by a stray space** — *Tier 3*
      powerfab-dashboard's summary renders "`01_list_tables. py`", "`02_describe_tables. py`"
      — four times in one paragraph. Looks like sentence-splitting applied to text
      containing filenames.
      **Done**, and it was not the splitter — that already knows `next.config.js` is one
      token. A model hard-wraps its own output, the wrap lands mid-filename, and
      collapsing whitespace turns the newline into a space. Repaired after the collapse,
      which is safe because there is no English sentence in which a word, a full stop and
      a space are followed by a bare file extension. `None. pymysql` is left alone: a
      word that starts with an extension is not one, and welding it would invent the file
      `None.pymysql` — the same failure in reverse.

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
