# Field drive — healthchecks (Django), 2026-08-13

One repo nobody here had opened before: [healthchecks/healthchecks](https://github.com/healthchecks/healthchecks),
a real self-hosted cron-monitoring SaaS. 653 Python files, 130 Django templates, 30
notification integrations. Chosen because Django is one of the most-used web frameworks
in the world and the driven set was FastAPI/Flask/Next.js — Sentry was read as Django,
but only ever for scope and store behaviour (items 29, 30).

Run: `app-atlas analyze . --no-ai --fresh`, 4.9s, on `main` at `6de1024`.

Ground truth for every number below was derived from the repo with Python's own `ast`
module, not from the atlas — the URLconf was resolved by following `include()` the way
Django does, and the table list came from the migrations.

---

## The headline

```
  143 ways in         1 service
    3 data stores    47 env variables
  all 141 routes are declared in a routing table App Atlas has not followed
  to its handler — no auth verdict was reached for any of them
```

What it got right, and should not be lost:

- **The Django ORM store is exactly right.** 13 tables — the 12 in the migrations plus
  Django's built-in `User`, which is a real table. No invented names, and
  `information_schema.columns` was correctly held back as a catalog query.
- **The unlinked-handler message is the honest-blank rule working.** It declines to
  reach an auth verdict rather than reporting 141 open doors. Compare the FastAPI
  template's original "21 of 21 unprotected".
- Frameworks (`Django · Pydantic`), the 47 env variables, and the folder tree are all
  sound. The Boundaries screen is legible at a glance.

Five defects follow. Ordered falsehoods-before-omissions, per the house rule.

---

## 1. Django's `include()` prefix is dropped — 43 addresses shown that do not exist

*Tier 1.* Item 4 composed router prefixes for six mount spellings — FastAPI
`include_router`, Starlette `mount`, Flask `register_blueprint`, Express `use`, Hono
`route`, NestJS `setGlobalPrefix`. **Django's `include()` was not among them**, and it
is the single most common way a Django app assembles its URL space.

| | |
|---|---|
| Real leaf routes (resolved through `include()`) | **179** |
| Addresses App Atlas displays | 140 |
| Displayed addresses that are correct | **97** |
| Displayed addresses that do not exist | **43** |

`hc/api/urls.py` mounts one list three times:

```python
api_urls = [ path("checks/", views.checks), … ]          # 15 routes

urlpatterns = [
    path("api/v1/", include(api_urls)),
    path("api/v2/", include(api_urls)),
    path("api/v3/", include(api_urls)),
]
```

The public REST API of this product is `/api/v1/checks/`. **App Atlas displays
`/checks/`.** All 45 real API addresses (15 × 3) are absent, and the fact that the API
is versioned three ways — a genuine architectural fact a stakeholder would ask about —
is invisible.

The same drop hits every `include()` of a local list in `hc/front/urls.py`:
`channel_urls` (real prefix `integrations/`) shows as `/<uuid:code>/edit/`;
`project_urls` (real prefix `projects/<uuid:code>/`) shows as `/badges/`, `/checks/`;
`check_urls` (real prefix `checks/<uuid:code>/`) shows as `/name/`, `/pause/`, `/log/`.

**It also merges two unrelated doors.** With the prefixes gone, `path("", views.index)`
in `hc/front/urls.py:52` and `path("", views.ping)` in `hc/api/urls.py:34` both become
`""`, so the Security page shows one row called `/` carrying both sites. The app's
homepage and its unauthenticated ping-receiving endpoint — the most security-relevant
public door in the product — are presented as one thing.

`include("hc.front.urls")` by *module string* works correctly; the failure is specific
to `include(<local list variable>)` and to composing the segment on the `path()` that
holds the `include`.

## 2. Every Django model is drawn twice in the Data model tab

*Tier 1 for the location, Tier 2 for the duplication.* The tab reads
**"60 shapes · 14 database tables · showing the 60 most used of 632"**. Thirteen of
those fourteen tables are duplicates of a model class already on the canvas.

`Profile`, for instance, appears as two cards with **byte-identical field lists**:

| | `typeKind: table` | `typeKind: class` |
|---|---|---|
| path | `hc/accounts/migrations/0018_auto_20190112_1426.py:15` | `hc/accounts/models.py:77` |
| provider | Django ORM | — |
| usage | 13 | 62 |
| fields | the same 12 | the same 12 |

The table card's location is **wrong** — it is wherever the analyzer first saw an ORM
query, which is a migration for `Profile`, `hc/accounts/admin.py` for `Check`,
`hc/api/management/commands/prunetokenbucket.py` for `TokenBucket`, and
`hc/logs/__init__.py` for `Record`. A reader clicking a table to find where it is
defined is sent to a cron command instead of `models.py`.

`typeview.ts:178` already spots the twin —

> A table and a type that share a name are usually the same idea wearing two hats.
> Saying so is useful; pretending the compiler said so is not, hence a separate basis.

— and responds by drawing a dashed *"same name only"* link between the two cards. That
is the right call for Prisma, where the schema file and a TypeScript `User` interface
are genuinely two artifacts. It is the wrong call for an ORM **whose class declaration
is the schema**: in Django there is no second artifact to link to. The same applies to
SQLAlchemy declarative, Mongoose, TypeORM entities and EF Core.

Cost beyond the confusion: 13 of the 60 card slots are spent on duplicates, so 13 real
shapes are pushed off a canvas that is already showing only 60 of 632.

## 3. One outside service found; eleven more are provable from hardcoded hosts

*Tier 1 — the Security page states "1 company, none of which receive data from you".*
This product exists to fan out notifications to third parties. It ships 30 integrations
with 29 `transport.py` files.

App Atlas finds exactly one service: Email (SMTP), via a direct `import smtplib`.

The cause is that all 282 outbound calls go through a first-party wrapper —
`hc/lib/curl.py`, whose docstring is *"requests-like interface for PycURL"* — so the
call sites read `curl.post(...)`, `curl.request(...)`. Two things block it:

- `HTTP_CLIENTS` in `src/analyze/py/boundaries.ts:52` is
  `{requests, httpx, aiohttp, urllib}`. `pycurl` is absent — but adding it would not
  help, because nothing outside `hc/lib/curl.py` imports pycurl either. What is needed
  is the Python equivalent of item 1's hop: a local module that imports a known HTTP
  client and exposes `get`/`post`/`request` is an HTTP client.
- The URLs are **class attributes**, and `detectOutbound`'s `constants` map only reads
  module-level constants: `URL = "https://api.pushover.net/1/messages.json"` sits inside
  `class PushoverTransport`, and the call is `self.post(self.URL, …)`.

Eleven real companies are named by hardcoded hostname in production (non-test) code and
are all missed: **Twilio, Discord, GitHub, ntfy, Opsgenie, PagerDuty, Pushover,
Pushbullet, Slack, Telegram, Trello**.

That eleven is the honest ceiling, not thirty. The remaining integrations post to
user-supplied webhook URLs stored in `Channel.value`, which have no literal to read and
should stay blank.

## 4. A web app with 130 templates is called "a service other things call"

*Tier 1 — the Overview page states "no interface files" as a fact.* healthchecks has a
full dashboard: 130 HTML templates, 81 JS/CSS files, 27 `render()` calls in
`hc/front/views.py` alone.

The archetype verdict reads:

> **A service other things call** — 141 ways in over the network · Django, Pydantic ·
> no interface files

`archetype.ts:85` decides this with
`hasUiFiles = project.files.some(f => f.zone === 'ui')`. The atlas for this repo
contains **653 `.py` and 35 `.js` files and nothing else** — no template is ever
ingested, so `hasUiFiles` cannot be true. `UI_FRAMEWORKS` lists React, Vue, Svelte,
Angular, Next.js, Expo, Streamlit and Electron; every server-rendered framework is
outside it by construction, so Django, Flask+Jinja and Rails-shaped apps all fall
through to `service`.

This is the frame for the whole tool — it picks the landing view and the language of
every summary — so it is worth more than its one line of text.

## 5. Django auth is a total blank: 141 of 141 routes "not examined"

*Tier 2 — honest, but no value delivered.* The Security page is a full-width bar reading
**"141 not examined"**, each row explaining *"declared in a routing table — App Atlas
has not followed it to the code that answers it"*.

That message is correct and it is the right behaviour given the tool cannot see the
handler. But the repo is not obscure about its protection: **81 `@login_required`**,
8 `@authorize`, 6 `@authorize_read`, 7 `@require_sudo_mode`. Nothing about these is hard
to read — the difficulty is only the hop from `path("checks/", views.checks)` to
`views.checks`, where `views` came from `from hc.front import views`.

Items 1–3 of the original list bought the auth screen back on FastAPI, Express and
NestJS. Django is the last dominant web framework where it delivers nothing, and #1
above is a prerequisite: without the composed address there is nothing to hang a verdict
on.

---

## After the fixes

All five are done, as items 40–44 in [fix-list.md](fix-list.md). The same command on the
same commit of the same repo:

```
  181 ways in        11 services
    3 data stores    47 env variables
  53 of 178 routes have no auth check App Atlas can see
  1 more is declared in a routing table App Atlas has not followed to its handler
```

| | before | after |
|---|---|---|
| Addresses displayed that do not exist | 43 | **0** |
| Real addresses displayed correctly | 97 of 179 | **178 of 179** |
| Outside companies | 1 | **11** |
| Duplicate cards in the Data model tab | 13 | **0** |
| Tables pointing at their declaration | 0 of 13 | **13 of 13** |
| Routes with an auth verdict | 0 of 141 | **178 of 179** |
| Archetype | *A service other things call · no interface files* | *An app with a front end · 154 pages it renders* |

Two numbers in this document were wrong and are corrected above. The repo has **198**
templates, not 130 — the first count missed the per-app `hc/integrations/*/templates`
directories — of which 154 are pages and 43 are email bodies. And **ten** companies are
provable from hardcoded hosts, not eleven: ntfy's address comes from the channel's own
configuration, and the line that named it was a comparison rather than a request.

The Security page was checked row by row against the source afterwards, because a false
*protected* costs more than a false *open*. Every route that is open by design —
the eleven ping endpoints, login, signup, logout, the signed badge URLs, the docs, the
OAuth callbacks — is still reported open.

## Coverage note

Everything above was verified against the repository source. The route counts come from
an AST resolver that follows `include()` through module strings and local lists; the
table list from `migrations.CreateModel`; the auth counts from decorator occurrences in
non-test files; the service list from hardcoded `https://` literals in non-test files.
The atlas figures were read from `/api/types`, `/api/insights` and `atlas.json`, and the
screens were driven in the browser.
