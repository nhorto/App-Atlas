# Field drive — paperless-ngx (Django + DRF), 2026-08-13

A second Django repo, driven to check items 40–44 against a codebase that had no say in
them: [paperless-ngx/paperless-ngx](https://github.com/paperless-ngx/paperless-ngx), a
self-hosted document manager. 748 files, Django + Django REST Framework + Celery, on
`2a8579f`.

Chosen because it writes Django *differently* from healthchecks in every way that
matters here — class-based views instead of function views, a DRF registration table
instead of `path()` calls, and a URL tree of nested list literals instead of named
lists. All five of the previous items were validated on one repo plus fixtures, which is
one repo too few.

Run: `app-atlas analyze . --no-ai --fresh`, 7.0s.

Ground truth was derived from the repository with Python's own `ast` module before the
tool was run: the URLconf resolved by following `include()` the way Django does, the
model list from `migrations.CreateModel`, and every view class's `permission_classes`
and bases read straight off the class statement.

---

## What it found, and what that cost

Two Tier-1 defects and one Tier-2, all in shapes the healthchecks drive could not have
produced. They are items 45 and 46 in [fix-list.md](fix-list.md); this records what the
tool said before them.

### 1. Every address was missing its prefix — 46 of 53 wrong

paperless writes its entire URL tree as list literals nested inside the `include()`
calls themselves:

```python
urlpatterns = [
    re_path(r"^api/", include([
        re_path("^documents/", include([
            re_path("^bulk_edit/", BulkEditView.as_view()),
```

Item 40 taught the reader two spellings of `include()`: a module string, and a named
local list. This is a third, it is the one Django's own documentation reaches for when
the routes are short, and with no list to mount every leaf fell through to the flat scan
and lost its prefix. The application's bulk-edit endpoint answers at
`/api/documents/bulk_edit/` and the map said `/bulk_edit/`.

Two smaller cuts of the same wound sat underneath it. `re_path(r"^api/", include(...))`
carried its `^` into the middle of every address below it, because a mount prefix is a
segment rather than a whole pattern. And Django's two-tuple form —
`include((patterns, "app_name"))` — looked like a list with no routes in it, which is
where `/api/auth/login/` and `/api/auth/logout/` went.

| | before | after |
|---|---|---|
| Real leaf routes | **53** | 53 |
| Displayed addresses that are correct | 7 | **53** |
| Displayed addresses that do not exist | **46** | **0** |

The 20 DRF registrations keep the `…/documents (UnifiedSearchViewSet)` form on purpose:
the router's urls are spliced in as `*api_router.urls`, and the prefix that lands in
front of them is not readable from the registration.

### 2. Every class-based view was a door with no verdict

healthchecks writes function views, so item 44's hop — `urls.py` → `views.py` → the
decorator — covered all of it. paperless routes 37 doors through `SomeView.as_view()`
and registers 20 DRF ViewSets, and `as_view()` is a *call*, so the URLconf reader saw no
view name at all. Every one came back `unlinked`, guard list empty, while the answer sat
one line under the class statement.

The five spellings this repo actually uses, all now read:

| how the class says it | example in paperless | confidence |
|---|---|---|
| `permission_classes` | 19 of 20 registered ViewSets | certain |
| inherited from a base class | six document operations, via one mixin | likely |
| a mixin in the bases | — (healthchecks-shaped; fixture only) | certain |
| `@method_decorator(login_required, name="dispatch")` | — (fixture only) | certain |
| a `dispatch` that returns 403 | — (fixture only) | likely |

**43 of the 47 readable doors now carry the verdict the source says they should**, and
the four reported open — the auth-token endpoint, the favicon, the logo, and the public
share link — are open by design. Checked row by row against the source afterwards,
because a false *protected* costs more than a false *open*.

### 3. Silence on a DRF class is not an open door

The part worth more than the verdicts. DRF has a project-wide
`DEFAULT_PERMISSION_CLASSES`, so a ViewSet that declares no `permission_classes` has not
said it is open — it has said nothing, and the answer is in a settings file this reader
has not opened. Following the link and then reporting "no auth check App Atlas can see"
would turn a blind spot into a claim about the application.

So those doors keep the blank, and say which file holds the answer rather than the stock
"App Atlas has not followed it to the code that answers it" — because it *was* followed:

> `RemoteVersionView` declares no permission_classes — a DRF view without one answers to
> DEFAULT_PERMISSION_CLASSES in your settings, which App Atlas has not read

`IsAuthenticatedOrReadOnly` gets the same treatment for a different reason. It locks the
writes and leaves the reads open, and DRF's router declares no method for the door it
generates; guarded claims a lock the GET has not got, unguarded claims none on the POST
that has one, and both are false.

Finding this needed the repo. paperless types every DRF base it inherits —
`GenericAPIView[Any]`, `ModelViewSet[ApplicationConfiguration]` — and with the subscript
left on the name none of them matched anything, so `RemoteVersionView` read as a plain
class with no check and was reported open. No fixture written from the documentation
would have had brackets in it.

---

## What it got right, unprompted

- **The DRF registration table.** All 20 ViewSets found and read, which was item 42's
  work on a repo that did not exist when it was written.
- **Both outside companies, with exact evidence.** GitHub from
  `httpx.get("https://api.github.com/repos/paperless-ngx/…")`, OpenAI from
  `from openai import APITimeoutError`. The IMAP and SMTP hosts stay blank and should:
  they come from the user's own mail-account configuration and there is no literal to
  read.
- **The data stores**: Postgres/SQLite, Redis, the filesystem, and browser storage.
- **The `#147` trap held.** A page that merely *mentions* a locked view stays open. This
  is the third time that bug has been found in a new disguise and the first time the
  fixture was written before the repo confirmed it.

## Still open

- **Google and Microsoft are named and missed.** `paperless_mail/oauth.py` writes
  `from httpx_oauth.clients.google import GoogleOAuth2` and
  `from httpx_oauth.clients.microsoft import MicrosoftGraphOAuth2` — the company named
  as unambiguously as `import openai` names OpenAI, which the tool does report.
  `serviceForPythonModule` keys on the first segment of the module path only, so
  `httpx_oauth.clients.google` reduces to `httpx_oauth` and nothing matches. Needs a
  dotted-prefix lookup ahead of the first-segment one.

## Coverage note

Route counts come from an AST resolver that follows `include()` through module strings,
named lists, inline list literals and the two-tuple form; the permission verdicts from
reading `permission_classes` and bases off every class statement in non-test code; the
service list from hardcoded `https://` literals and from imports, both in non-test files
only. The atlas figures were read from `atlas.json`. The hand-written resolver missed one
real route the tool found — `/ws/status/`, a Channels consumer declared in a second list
— which is recorded here rather than quietly corrected, because a ground truth that is
wrong in the tool's favour is worth as much as one that is wrong against it.
