# Agent trial: does a coding agent answer better with the map than without it?

*Pre-registered 2026-08-09, before any run. Everything above the results line was written
and committed first; the results were pasted in underneath whichever way they came out.*

This is the product's central claim and it is the least-tested thing in the repository.
[LAUNCH.md](LAUNCH.md) puts it plainly — *"does an agent do noticeably better with the map
than without it? If the honest answer is 'hard to tell,' that is the most important finding
available"* — and the only previous attempt was a single run per arm, graded afterwards, on
a repo whose atlas contained five false alarms from a bug since fixed. It came out roughly
twice as fast with the map, which is exactly the kind of number one sample produces and
cannot support.

Three things are different here.

**The answer key is not ours.** [`oracle.py`](../test/oracle/openwebui-endpoints.py) reads
the subject with CPython's own `ast` and prints every endpoint and its auth dependency. It
is a different implementation, in a different language, from the analyzer under test, and
it was written and spot-checked against the source before either arm ran. Neither arm is
graded against anything App Atlas said.

**The grading is mechanical and fixed in advance.** Three of the four questions are scored
by set comparison against the oracle. No judgment is exercised at scoring time, because I
am not a neutral judge of my own tool and should not be asked to be one.

**Three runs per arm, not one.** Agent runs vary enormously. One sample per arm is a story,
not a measurement.

---

## Subject

`open-webui/open-webui` at `01f4282`, shallow clone, `backend/` only — 254 Python files,
31 FastAPI routers, **529 endpoints** by the oracle's count.

Chosen for one property above all: **its doors are not visible in the file tree.** Routes
are `@router.get('/pinned')` inside a router module, mounted under a prefix by
`app.include_router` in `main.py`, and protected — or not — by a `Depends(get_verified_user)`
in the handler's signature. Nothing about the folder layout tells you the URL or who may
call it. A file-system-routed Next.js app would have made the control arm's job trivial and
the trial meaningless.

Not previously dogfooded, and not in the corpus under `/tmp/atlas-dogfood`.

## The oracle

```
total endpoints: 529
  user  333    any signed-in caller (Depends(get_verified_user | get_current_user))
  admin 159    Depends(get_admin_user)
  open   25    no auth dependency in the signature
  other  12    SCIM's own bearer scheme (Depends(get_scim_auth))
```

Two known nuances, decided now rather than after seeing an answer:

- `/api/v1/retrieval/ef/{text}` is registered only under `if ENV == 'dev'`, and the
  `analytics` and `scim` routers are mounted only under config flags. Including or omitting
  any of these in Q3 is scored as **neither right nor wrong** — both readings are defensible
  and neither should decide the trial.
- `open` means *no authentication dependency in the signature*. Several of those handlers
  do check something in the body. The question asked is about the signature, and it is
  worded to both arms that way.

## The task

Both arms receive this prompt, byte-identical but for one sentence noted below.

> You are onboarding to the repository at `<DIR>`. Answer four questions about its Python
> backend.
>
> Definitions, so we agree on what counts. An **endpoint** is an HTTP route declared with a
> FastAPI route decorator (`@router.get(...)`, `@app.post(...)`, and the other verbs) in
> `backend/open_webui/routers/*.py` or `backend/open_webui/main.py`. Its **path** is the
> decorator's path with whatever prefix `app.include_router(...)` mounts it under in
> `main.py`. Ignore websockets, socket.io, static mounts, and anything outside `backend/`.
>
> **Q1.** List every endpoint under `/api/v1/notes` and every endpoint under
> `/api/v1/folders`.
>
> **Q2.** For each endpoint in Q1, say who may call it: `admin` (administrators only),
> `user` (any signed-in user), or `open` (reachable with no authentication at all). Judge
> this by the handler's signature — which authentication dependency it declares, if any.
>
> **Q3.** Across the whole backend, list every endpoint that is `open` — reachable by a
> caller who is not signed in.
>
> **Q4.** In two short paragraphs, describe what happens when a signed-in user uploads a
> file: which endpoint receives it, where the bytes end up, and what else the upload
> triggers. Give `file:line` for every claim.
>
> Answer with one fenced `json` block in exactly this shape, and then your Q4 prose
> underneath it:
>
> ```json
> {"q1": [{"method": "GET", "path": "/api/v1/notes/"}],
>  "q2": [{"method": "GET", "path": "/api/v1/notes/", "auth": "user"}],
>  "q3": [{"method": "POST", "path": "/api/v1/auths/signin"}]}
> ```
>
> Be complete and be accurate. Both matter. Do not pad the lists to look thorough.

The atlas arm gets one extra sentence, and nothing else:

> An App Atlas MCP server is attached, offering `list_doors`, `unguarded_doors`, `where_is`,
> `what_calls`, `data_stores`, `env_vars` and `unimported_files` over a precomputed map of
> this repo. Use it if it helps.

**Why tell it.** An agent that never calls the server would measure discoverability, which
is a real question and not this one. This trial asks whether the map helps when it is used.
That the atlas arm has to be *told* is recorded here as a limitation, not hidden.

## The arms

| | Control | Atlas |
|---|---|---|
| Clone | `subject-control/`, no `.app-atlas` | `subject-atlas/`, analyzed first |
| Tools | Read, Grep, Glob, Bash — the default kit | the same, plus the MCP server |
| App Atlas | none | **`npx @app-atlas/cli@0.25.0`**, from the registry, not the working tree |
| Model | `sonnet`, pinned | `sonnet`, pinned |
| Runs | 3, independent headless sessions | 3, independent headless sessions |

Each session is a separate `claude -p` process with no shared context, so neither arm can
inherit the other's reading.

**The atlas arm pays for its map.** The wall clock of `analyze` on a cold cache is added to
every atlas run's time before the arms are compared. If the map costs more to build than it
saves, that shows up in the number.

## What is measured

| Metric | How |
|---|---|
| **Q1 F1** | precision and recall over the set of `(method, path)` pairs, against the oracle |
| **Q2 accuracy** | share of correct auth labels, over the endpoints the arm listed correctly |
| **Q3 precision / recall / F1** | same set comparison, over the 25 open endpoints |
| Wall clock | seconds per run; atlas runs carry the analyze cost |
| Tokens | from `--output-format json` |
| **Q4 false statements** | claims contradicted by the cited `file:line`, counted by hand |

Path comparison normalises a trailing slash and the name of a path parameter, so
`/api/v1/notes/{note_id}` and `/api/v1/notes/{id}` are the same endpoint. Method must match
exactly.

**Q3 precision is the metric that matters most.** Under-claiming is this project's whole
posture — #116, and every "set aside, never hide" decision since — so an arm that invents
an unprotected door is failing at the thing the tool exists to do, and a lower F1 bought
with a higher precision is the better result.

Q4 is the only question scored by judgment, and the only one the map has no precomputed
answer for. It is there to check that the map does not *mislead* on work it cannot do.
Its scoring is a hand count of false claims, published in full below so it can be argued
with.

## What would falsify the claim

Set now, so it cannot be moved later:

- If the atlas arm's mean **Q3 F1 is not at least 0.15 above** the control's, the map did
  not help on the question it was built for.
- If the atlas arm's **Q3 precision is lower** than the control's, the map actively hurt,
  regardless of anything else in the table.
- If the atlas arm produces **more Q4 false statements** than the control, the map misleads
  on work outside its coverage.

Any of those three is the finding, and it goes in this document at the same size as a win
would.

---

# Results

*(pending — this section is written after the six runs complete)*
