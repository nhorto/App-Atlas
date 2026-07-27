# Bake-off — App Atlas against four neighbours, same repos, same day

*Run 27 July 2026. Companion to [LANDSCAPE.md](LANDSCAPE.md), which is desk research;
this is what happened when the tools were actually installed and pointed at the same
code.*

Everything below was executed. Timings are wall-clock from the same container. Where a
tool lost, it lost on output I can quote; where App Atlas lost, that is recorded in the
same detail, and it lost three times.

---

## Method

**Subjects**

| | What | Why |
|---|---|---|
| **A — fixture** | `test/fixtures/boundary` from this repo (15 files) | Ground truth is known exactly. It is a deliberately-insecure Next.js app: 2 pages, `GET`+`POST /api/users`, a Stripe webhook, a Vercel cron, one server action, a Supabase edge function, Prisma + Supabase tables, Clerk middleware, 7 env vars. |
| **B — real app** | `vercel/nextjs-subscription-payments`, shallow clone (58 files) | A real, widely-copied Next.js + Supabase + Stripe starter. Nobody wrote it to be found by any of these tools. |

**Contestants**

| Tool | Version | Install |
|---|---|---|
| App Atlas | 0.5.0, `--no-ai` | this repo, `npm run build` |
| codegraph | 1.5.0 | `npm i -g @colbymchenry/codegraph` |
| repowise | 0.36.0 | `uv tool install repowise` |
| OWASP Noir | `main`, built from source | Crystal 1.19.1 + `shards build` (needed `libxml2-dev`) |
| CodeBoarding | `main` | `uv sync --frozen` |

App Atlas ran with `--no-ai` throughout, so this compares facts to facts. No tool was
given an API key, a config file, or a hint.

**Not run, and why:** repowise's and Noir's published Docker images could not be pulled —
this container's proxy 403s container-registry blob CDNs (both ghcr.io and Docker Hub).
Both were installed another way instead, so nothing was lost. Nothing was excluded for
convenience.

---

## Result 1 — the doors

The question App Atlas exists to answer, asked of every tool.

### Subject A — the fixture (ground truth: 6 doors + 1 cron + 1 webhook)

| Tool | Doors found | What it actually returned |
|---|---|---|
| **App Atlas** | **9 ways in** | 2 pages, `GET`+`POST /api/users`, the server action, the Supabase edge function, each **badged with its guard**; cron and webhook broken out separately, cron carrying its schedule `0 8 * * *` |
| **OWASP Noir** | 5 app + 9 synthesized | `POST /createOrder`, `GET /api/cron/digest`, `GET`+`POST /api/users`, `POST /api/webhooks/stripe` — plus 9 Supabase REST endpoints (see below). No auth, no page routes, no edge function; cron and webhook indistinguishable from ordinary routes |
| **codegraph** | **2** | `/` and `/(app)/dashboard` — the two `page.tsx` files only. Missed both API methods, the webhook, the cron, the action, the edge function |
| **repowise** | "1 entry point" | Root page: *"Execution starts at `supabase/functions/greet/index.ts`."* The API layer page separately lists 3 files as entry points |
| **CodeBoarding** | — | Refused to run (see Result 4) |

### Subject B — the real app

| Tool | Doors found | What it actually returned |
|---|---|---|
| **App Atlas** | **19 ways in** | 9 server actions, 2 auth route handlers, 4 pages, 2 Stripe actions, the webhook — with `12 of 17 doors reachable from the internet have no auth check App Atlas can see` on the first line |
| **OWASP Noir** | 3 app + 32 synthesized | `POST /api/webhooks`, `GET /auth/callback`, `GET /auth/reset_password`. Missed all 9 server actions and all 4 pages |
| **codegraph** | **4** | `/`, `/account`, `/signin`, `/signin/:id` — every one a page. Missed the webhook, both auth handlers, all 9 server actions |
| **repowise** | 10 "entry points" | `components/ui/Button/index.ts`, `Card/index.ts`, `Footer/index.ts`, `Input/index.ts`, `LoadingDots/index.ts`, `LogoCloud/index.ts`, `Navbar/index.ts`, `utils/auth-helpers/server.ts`, `utils/stripe/server.ts`, `utils/supabase/server.ts` |

**The clearest single line in this whole exercise:** asked where to start reading a
payments app, repowise says `components/ui/Button/index.ts`. It is not malfunctioning —
it defines an entry point graph-theoretically, as a file nothing else imports, which for
a component library means barrel files. App Atlas defines a door as a place the outside
world can knock. Same repo, same static facts, completely different question answered.

codegraph is the same story in a different key: it resolves routes from framework
conventions across 17 frameworks, but "route" to codegraph means a Next.js page file. The
webhook, the cron and nine publicly-invokable server actions are not routes to it, and
those are the ones that matter.

One accuracy detail worth keeping: codegraph reported the dashboard's URL as
`/(app)/dashboard`. `(app)` is a Next.js route group — it structures folders without
appearing in the URL. The real path is `/dashboard`, which is what App Atlas printed.

---

## Result 2 — everything the boundary view claims beyond doors

Fixture, `--no-ai`, no keys, nothing configured:

| | App Atlas | codegraph | repowise | Noir |
|---|---|---|---|---|
| Auth per door, with confidence | **yes** (`Clerk`, `Clerk?`, `Supabase`, `none found`) | no | no | no |
| Webhook told apart from a route | **yes** | no | no | no |
| Cron with its schedule | **yes** (`0 8 * * *`) | no | no | no |
| Outbound services named | **yes** — Clerk, PostHog, Resend, Stripe, each with the package or hostname that proves it | no | no | no |
| Env vars, checked against the example file | **yes** — 7 found | no | no | no |
| DB tables | **yes** — Prisma *and* Supabase, from `schema.prisma` and the migrations | no | no | as REST endpoints |
| Runs with no API key | **yes** | yes | yes (structure tier) | yes |
| Visual, clickable map | **yes** | no | dashboard | no |
| Languages | 2 | 20+ | 16 | 50+ frameworks |

The row that matters is the last but one. Nobody else in this table draws a picture a
non-programmer can open, and the two tools with the widest language coverage
deliberately never render anything.

---

## Result 3 — speed

| | Fixture | Real app |
|---|---|---|
| **Noir** | 0.16s | 0.18s |
| **App Atlas** | 1.4s | 1.9s |
| **codegraph** | 1.6s (375ms indexing) | 2.1s (1.1s indexing) |
| **repowise** | 20.7s | 16.6s |
| **CodeBoarding** | failed in 5.7s | not attempted |

Noir is an order of magnitude faster than everything else and it is not close. App Atlas
is comfortably in the interactive band, which is what matters for `--watch`.

---

## Result 4 — CodeBoarding needs a key to say anything

CodeBoarding is the closest competitor by *positioning* — "See what your AI is building
before it breaks." Installed clean, pointed at the fixture, it ran for 5.7 seconds and
produced this:

```
ERROR  LLM provider not configured: No LLM provider selected. Set one of:
ANTHROPIC_API_KEY, AWS_BEARER_TOKEN_BEDROCK, CEREBRAS_API_KEY, DEEPSEEK_API_KEY, …
```

It wrote a `.codeboarding/logs/` directory and nothing else. Zero diagrams, zero
documentation, no partial static output.

That is a design difference, not a bug: CodeBoarding's diagrams are composed by an LLM
from static input, so with no model there is nothing to compose. App Atlas's entire
structural product — boundary view, security badges, data view, tours, `ATLAS.md` — is
what `--no-ai` produces, and every number in this document came out of that mode.

**This is the sharpest differentiator found in the whole exercise, and the README
currently buries it.** "Works offline, with no account and no API key, and still tells
you which routes are unprotected" is a claim the nearest competitor cannot make at all.

---

## Where App Atlas lost

### 1. Noir knows a Supabase table is a door. App Atlas thinks it is only a destination.

Noir's endpoint count is inflated by something clever rather than sloppy: it reads the
SQL migrations and synthesizes the PostgREST surface Supabase automatically exposes for
each table. On the real app that is 32 endpoints — `GET`/`POST`/`PATCH`/`DELETE`
`/rest/v1/users`, `/rest/v1/customers`, `/rest/v1/subscriptions`, and so on, plus
`POST /rest/v1/rpc/handle_new_user`.

Those are real, internet-reachable doors. Creating a table in Supabase creates a public
REST API for it, and whether that door is locked depends on RLS, not on any code in the
repo.

App Atlas draws Supabase exclusively on the right-hand side of the boundary view, as a
place data goes. For an app built on Supabase — which is the primary audience — the
boundary view is therefore missing a whole wall of doors, and they are precisely the ones
that have been leaking user data in the incidents that make this tool worth building.
This is the most valuable thing the bake-off found.

### 2. A false alarm about env vars — an over-claim, which is the forbidden direction

On the real app, App Atlas printed:

> `* not in .env.example — 10 of 10 are read by the code but written down nowhere.`

The repo documents 7 of those 10, in `.env.local.example` — the file the Next.js
documentation tells you to use, and the one this very repo ships.

Two causes, both in [`src/analyze/signals.ts:398`](../src/analyze/signals.ts):

```ts
for (const candidate of ['.env.example', '.env.sample', '.env.template', '.env.defaults'])
```

`.env.local.example` is not in the list, and the loop `return`s on the first file it
finds rather than reading every example file present. This repo has both `.env.example`
(3 Supabase-auth variables) and `.env.local.example` (the 7 real ones); App Atlas read
the first, found no matches, and reported the maximum possible alarm.

CONTRIBUTING.md's rule is under-claim. This is the mirror-image failure — inventing a
problem rather than missing one — and it will fire on a large share of Next.js projects.

### 3. Every sign-in endpoint is reported as an unprotected door

The real app's headline is `12 of 17 doors reachable from the internet have no auth
check`. Nine of those twelve are the auth helpers: `signInWithEmail`,
`signInWithPassword`, `signUp`, `requestPasswordUpdate`, `SignOut`.

Each is literally correct — they are public server actions with no guard — but a sign-in
endpoint *must* be reachable by strangers, and counting them as findings inflates the
alarm. A reader who checks the first three and finds them all fine learns to discount the
number, which costs App Atlas the thing it is trying hardest to buy: being believed.
Worth considering a "public by design" classification for auth entry points. This one is
a judgment call, not a defect.

### Also, plainly

codegraph indexed the fixture in 375ms across 20+ languages with a Rust kernel, and wires
itself into Claude Code, Cursor and Codex with one command. repowise ranks files by
PageRank over the import graph rather than raw connection count, mines git history for
hotspots and ownership, and finds dead code and unused exports — none of which App Atlas
does. Both are further along than App Atlas on everything that is not the boundary view.

---

## What this changes

1. **Lead with "no API key, no account, still tells you what's unguarded."** The nearest
   competitor by positioning produced nothing at all under those conditions. This is
   demonstrable in one screenshot and it is currently a footnote.
2. **Fix the `.env.local.example` bug.** Small, and it is an over-claim.
3. **Put Supabase tables on the left-hand side of the boundary view too.** Noir shows the
   technique works from migrations alone. For the target audience this is the highest-value
   missing feature found anywhere in this research.
4. **Consider "public by design" for auth endpoints**, so the unprotected count means
   something.
5. **Use the repowise line in the README.** "Another tool told me to start reading a
   payments app at `Button/index.ts`" makes the argument for the boundary view faster than
   any paragraph.

## Reproducing

```bash
npm run build
node dist/node/cli.js analyze <subject> --no-ai -q
node dist/node/cli.js export <subject> --stdout

npm i -g @colbymchenry/codegraph && codegraph init <subject> && codegraph query "" --kind route --json
uv tool install repowise && repowise init <subject> && repowise export <subject> --format markdown
# Noir: Crystal 1.19+, apt install libxml2-dev, shards build
noir -b <subject> -f json
```
