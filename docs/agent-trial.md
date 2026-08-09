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

*Six runs, 9 August 2026. Raw output in [`runs/`](agent-trial/), one JSON per session,
including every answer quoted below.*

## The pre-registered test failed, and not for the reason it was written to catch

| | Q1 F1 | Q2 acc | Q3 P | Q3 R | Q3 F1 | invented | missed | secs | turns | cost |
|---|---|---|---|---|---|---|---|---|---|---|
| control-1 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 0 | 0 | 165 | 31 | $1.20 |
| control-2 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 0 | 0 | 298 | 16 | $2.13 |
| control-3 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 0 | 0 | 213 | 38 | $1.37 |
| atlas-1 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 0 | 0 | 97 | 19 | $0.75 |
| atlas-2 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 0 | 0 | 95 | 17 | $0.65 |
| atlas-3 | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 0 | 0 | 340 | 38 | $1.38 |

```
Q3 F1 lift  +0.00 — needs >= +0.15 : FAIL
Q3 precision  atlas 1.00 vs control 1.00 : PASS
```

**The map did not make the agent more accurate, because the agent was already perfect
without it.** Three control runs out of three enumerated all 23 endpoints across two
routers, labelled every one's authentication correctly, and found all 21 unauthenticated
endpoints among 529 — with nothing invented and nothing missed. There was no headroom for
the map to occupy, and the primary metric was therefore unmeasurable on this subject.

That is a failure of the experiment's design, and it is also the most useful thing it
produced. **On a conventionally-structured FastAPI repository, a competent agent with grep
does not need this tool to get the right answer.** Any pitch that says otherwise is
contradicted by six runs' worth of evidence in this repository.

The second condition passed: precision was 1.00 in both arms, so the map did not induce a
single false alarm. The third — Q4 false statements — is below, and it also passed.

## What did differ: cost, unreliably

| | mean | median | range |
|---|---|---|---|
| control | 225s, $1.56, 28 turns | 213s | 165–298s |
| **atlas** | **177s, $0.93, 25 turns** | **92s** | **95–340s** |

Atlas times include the cold `analyze` each run paid for: 5.78s, 5.68s, 5.82s.

Two atlas runs came in at 95s and 97s — under half the control median, at 40% of the cost.
The third took 340s and $1.38, slower and dearer than every control run. **At n=3 with that
spread, the cost difference is not a result.** Reporting the mean without the range would
be the more flattering and less true summary.

## The transcripts explain the spread, and this is the real finding

Tool calls, counted from each session's own transcript:

| run | App Atlas calls | other tool calls | secs | cost |
|---|---|---|---|---|
| atlas-1 | 2 — `list_doors`, `unguarded_doors` | 15 (7 grep, 3 read) | 97 | $0.75 |
| atlas-2 | 1 — `unguarded_doors` | 13 (5 read, no grep) | 95 | $0.65 |
| atlas-3 | 1 — `list_doors` | 34 (24 bash, 7 grep) | **340** | **$1.38** |

**The saving tracks how far the agent was willing to lean on the map.** atlas-2 asked
`unguarded_doors` one question, spot-read five files, and stopped — the cheapest run of the
six. atlas-3 called `list_doors` once, then re-derived the entire answer by hand: a control
run carrying the map's overhead, and the slowest of all six.

Two things follow, and the second matters more than the first.

**No run trusted the map on its own.** All three cross-checked it against source. That is
correct behaviour from the agent — it has no way to know the map is right — and it puts a
ceiling on the saving that no improvement to the map's *accuracy* can lift. What would lift
it is the agent having a reason to believe the map, which is a provenance and confidence
problem, not a coverage one.

**Every atlas run spent a `ToolSearch` call discovering the MCP tools' schemas before it
could call one.** Small, but it is friction on the first and most fragile step, and it is
paid once per session by every user.

## Q4 — the question the map has no answer for

Scored by hand, as pre-registered. **118 distinct `file:line` citations across the six runs.
Every one resolves to a real line. No false statement was found in either arm.**

The claims checked directly against source: the receiving endpoint (`POST /api/v1/files/`,
`routers/files.py:271`), its guard (`user=Depends(get_verified_user)`, `files.py:279`), the
`process: bool = Query(True)` default (`files.py:277`), the storage name
(`id = str(uuid.uuid4())` then `filename = f'{id}_{filename}'`, `files.py:356-358`), the
destination (`UPLOAD_DIR = DATA_DIR / 'uploads'`, `config.py:168`), and the event
(`FILE_UPLOADED`, `name='file.uploaded'`, `events.py:287-288`). All correct in every run
that cited them.

This is a sample of the spine plus every point where two runs disagreed, not an exhaustive
audit of all 118 citations. On that basis the map neither helped nor misled on work outside
its coverage, which is the answer the question was asked for.

One thing that could have gone wrong and did not: the map showed every address in this repo
with a leading `…` (see [#199](https://github.com/nhorto/App-Atlas/issues/199)). **No arm
reported a path containing an ellipsis.** The agents dropped it silently rather than
propagating it.

## Measured on the side: how accurate the map itself is

The oracle grades App Atlas as readily as it grades an agent, so it was pointed at the map.
0.25.0 from the registry, `--no-ai`, on the same commit:

| | oracle | App Atlas | |
|---|---|---|---|
| endpoints | 529 | **528** | 0 invented |
| reachable with no auth | 25 | **24** | 0 false alarms, 0 missed |
| auth verdict per endpoint | — | **528 / 528 agree** | |

The single miss is `/api/v1/retrieval/ef/{text}`, registered under `if ENV == 'dev'` — one
of the cases the protocol excused in advance for both sides.

Seventeen repositories have been dogfooded and every one of them produced a defect. This is
the first whose *facts* were clean. It still produced a defect, in the addresses rather than
the verdicts: [#199](https://github.com/nhorto/App-Atlas/issues/199) — FastAPI's
`app.mount()` read as mounting the app's own routers, which puts a leading `…` on all 518
addresses here, and on an app with exactly one static mount fabricates the prefix outright.
That one was found by preparing this trial, not by running it.

## What this changes

1. **Stop claiming the map makes an agent more correct on ordinary repos.** It does not, on
   the evidence here, because the agent was already correct. The claim that survives is
   narrower: *the same answer, sometimes for under half the cost.*
2. **The cost claim is real but conditional, and the condition is trust.** The map pays off
   exactly when the agent stops re-deriving what it just read. The lever is provenance —
   giving the agent grounds to believe a line — not more coverage.
3. **Fix the ToolSearch friction**, or at least measure it. Every session pays it.
4. **The accuracy question is still open and needs a harder subject.** open-webui is
   conventional: one decorator per route, one dependency per guard, greppable. The repos
   this tool was built for are the ones where that fails — a custom auth wrapper one hop
   away, a route path computed from a constant, a guard on a router rather than a handler.
   The next trial should use one, and be pre-registered the same way.

   That is a follow-up, not a moved goalpost. **This trial failed its own primary test and
   that stands recorded above**; a second trial on a harder subject does not retract it,
   and if the harder subject also comes out tied, the honest conclusion is the one
   [LAUNCH.md](LAUNCH.md) already anticipated.
5. **Ship [#199](https://github.com/nhorto/App-Atlas/issues/199).** An invented address is
   the failure mode this project treats as worst, and one static-file mount is enough to
   produce it.

## Limitations, plainly

- **One subject, one language, one framework.** Nothing here generalises to TypeScript, Go
  or C#.
- **n=3 per arm.** Enough to kill the single-sample problem, not enough to make the cost
  difference a measurement.
- **One model** (`sonnet`). A weaker agent would plausibly benefit more from a map; a
  stronger one, less. This trial says nothing about that slope.
- **The atlas arm was told the server existed.** Whether an agent finds and uses it unaided
  is a separate question and was deliberately not asked.
- **Q4 grading is mine**, on a sample, and I am not a neutral judge of my own tool. The runs
  are committed so the count can be disputed.
