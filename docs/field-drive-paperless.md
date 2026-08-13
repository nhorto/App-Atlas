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

Three defects in shapes the healthchecks drive could not have produced. They are items
45–47 in [fix-list.md](fix-list.md); this records what the tool said before them.

Two of the three were found and fixed on `main` in the same week, independently, from
the same repo — the address composition below in full, and the first half of the
class-based-view work. That is recorded rather than quietly absorbed: the parts this
branch adds are marked, and the parts it only *verified* say so.

### 1. Every address was missing its prefix — 46 of 53 wrong *(fixed on `main`)*

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

### 2. Every class-based view was a door with no verdict *(half on `main`)*

healthchecks writes function views, so item 44's hop — `urls.py` → `views.py` → the
decorator — covered all of it. paperless routes 37 doors through `SomeView.as_view()`
and registers 20 DRF ViewSets, and `as_view()` is a *call*, so the URLconf reader saw no
view name at all. Every one came back `unlinked`, guard list empty, while the answer sat
one line under the class statement.

The five spellings this repo actually uses, all now read:

| how the class says it | example in paperless | added here |
|---|---|---|
| `permission_classes` | 19 of 20 registered ViewSets | on `main` |
| inherited from a base class in the same file | six document operations, via one mixin | on `main` |
| a mixin in the bases | — (healthchecks-shaped; fixture only) | on `main` |
| `@method_decorator(login_required, name="dispatch")` | — (fixture only) | **yes** |
| a `dispatch` that returns 403 | — (fixture only) | **yes** |

A base class in *another* file is deliberately not followed, and the fixture pins that
as an under-claim rather than a gap: resolving a bare class name across a whole repo
means trusting a name, and two apps each with a `Base` is ordinary. paperless keeps
every view mixin beside its views, which is the case the in-file walk was scoped to.

**43 of the 47 readable doors now carry the verdict the source says they should**, and
the four reported open — the auth-token endpoint, the favicon, the logo, and the public
share link — are open by design. Checked row by row against the source afterwards,
because a false *protected* costs more than a false *open*.

**And the way it reached them mattered.** Following the reference graph out of a class
that carries a check is how `main` was reaching some of these, and a reference edge
between two classes means *mentions*. Reproduced on `main`, before any change here: an
open login page that names a locked billing view, which inherits a base carrying
`LoginRequiredMixin`, was reported **locked** — three hops of "mentions", and the front
door of the product badged as protected. That is #147 for the third time and the one
error this screen cannot afford, because nobody re-checks a door they were told was
locked. A check on a class travels by inheritance and by nothing else now; the chain is
named where it is read, so `PermissionMixin → IsAuthenticated` survives the change.

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

Finding this needed the repo. paperless types every DRF base it inherits —
`GenericAPIView[Any]`, `ModelViewSet[ApplicationConfiguration]` — and with the subscript
left on the name none of them matched anything, so `RemoteVersionView` read as a plain
class with no check and was reported open. No fixture written from the documentation
would have had brackets in it.

---

### 4. Two of the four companies were named and missed

`paperless_mail/oauth.py` writes `from httpx_oauth.clients.google import GoogleOAuth2`
and `from httpx_oauth.clients.microsoft import MicrosoftGraphOAuth2` — the company named
as unambiguously as `import openai` names OpenAI, which the tool does report. These are
the *only* mention of either company in 748 files: the mail server comes from the user's
own account settings, so no hostname literal exists anywhere to read.

`serviceForPythonModule` keyed on the first segment of the module path, so
`httpx_oauth.clients.google` reduced to `httpx_oauth` — a library, not a company. The
Security page said two outside companies where the honest answer is four. Fixed with a
longest-match table of dotted prefixes consulted ahead of the first-segment lookup.

---

## What it got right, unprompted

- **The DRF registration table.** All 20 ViewSets found and read, which was item 42's
  work on a repo that did not exist when it was written.
- **Two of the four companies, with exact evidence.** GitHub from
  `httpx.get("https://api.github.com/repos/paperless-ngx/…")`, OpenAI from
  `from openai import APITimeoutError`. The IMAP and SMTP hosts stay blank and should:
  they come from the user's own mail-account configuration and there is no literal to
  read. The other two are defect 4 above.
- **The data stores**: Postgres/SQLite, Redis, the filesystem, and browser storage.
- **The four doors it calls open really are open** — the auth-token endpoint, the
  favicon, the logo, and the public share link. On a screen where a false *protected* is
  the expensive error, the four false-negative-shaped rows all check out.

## Still open

- **`IsAuthenticatedOrReadOnly` is reported as a guard.** It locks the writes and leaves
  every read open, and DRF's router declares no method for the door it generates — so
  "protected" is true of the POST and false of the GET. The name is shown in full, which
  is the argument for leaving it: a reader who sees `IsAuthenticatedOrReadOnly` can
  finish the sentence. Worth a decision rather than an assumption, and it is a decision
  taken on `main` rather than one this drive is entitled to reverse.

## Coverage note

Route counts come from an AST resolver that follows `include()` through module strings,
named lists, inline list literals and the two-tuple form; the permission verdicts from
reading `permission_classes` and bases off every class statement in non-test code; the
service list from hardcoded `https://` literals and from imports, both in non-test files
only. The atlas figures were read from `atlas.json`. The hand-written resolver missed one
real route the tool found — `/ws/status/`, a Channels consumer declared in a second list
— which is recorded here rather than quietly corrected, because a ground truth that is
wrong in the tool's favour is worth as much as one that is wrong against it.
