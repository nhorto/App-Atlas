# Field drive: does App Atlas actually inform anyone?

*Written 2026-07-29. Status: planned, not yet run.*

Everything merged so far has been verified against fixtures and probes — counts, doors,
archetypes. None of it has been verified against the only question that matters: **does a
person looking at the screen come away understanding their app?** This experiment answers
that by driving the real UI, by hand, across a dozen real repos, in character.

## The person we are testing for

Not a senior engineer. A person who spent the weekend building something with AI, and on
Monday morning needs to understand what they have — well enough to brief a customer, a
boss, or a stakeholder. They know what an API is; they do not know what their own
project's folder structure means, because they didn't write it.

Their Monday-morning questions, in their words:

1. "What is this app, and what are its pieces?"
2. "What are all the ways in and out of it — who can reach it, what does it talk to?"
3. "Where does my data live, and what does it look like?"
4. "Is anything unlocked that shouldn't be?"
5. "When a user does X, what actually happens, step by step?"

Every screen gets judged against those five questions and nothing else. "Technically
accurate" is table stakes; the test is **informative, comprehensible, and trustworthy to
this person**.

## Method: the drive protocol

The same ritual for every repo, so results compare across repos. All driving happens in
the real browser against the real local server (`node dist/cli.js <dir> --no-ai
--no-open -p <port>`, built from merged `main`), with screenshots taken along the way.

### 1. Blind first-look (60 seconds)

Land on the Boundaries view. Before clicking anything, write down what the app appears
to be and do — using only what the screen says. Then compare against the repo's own
README. The gap between the two is the single most important measurement in this whole
experiment: it is exactly the first minute of the Monday-morning user's experience.

(For famous repos where prior knowledge is unavoidable: write down what is *shown*, not
what is *known*, and judge only the shown.)

### 2. Screen-by-screen pass

For each view — Boundaries, Overview, Map, Data model, Security — answer three fixed
questions and log freely beyond them:

- **Informative:** did this screen tell me something true and useful that the file tree
  would not have?
- **Comprehensible:** could the Monday-morning persona parse it without knowing our
  vocabulary (door, guard, zone, archetype)?
- **Trustworthy:** is anything shown *wrong*? (A single wrong fact costs more than ten
  missing ones — log these as severity 1 always.)

Specific probes per screen:

- **Boundaries:** click *every* door. Judge the right-side panel each time — is there
  enough to act on (where is this in code, who can call it, what protects it)? Is
  provenance (`certain` vs `likely`) legible or jargon?
- **Overview:** read it as the stakeholder brief it wants to be. What sentence is
  missing? What sentence is filler?
- **Map:** drill three levels down. Do the rolled-up arrows at each level *mean*
  something, or are they spaghetti? Pick one file known to be important from the README
  — how many clicks to find it, and does its panel explain it?
- **Data model:** pick two types/tables. Would the persona learn what their data looks
  like, or just see a schema dump?
- **Security:** spot-check one guard badge against the actual code. Does the screen
  distinguish "locked", "unlocked", and "we can't tell" honestly?

### 3. The trace test

Pick one concrete user action (from the repo's own docs — "user signs up", "a cron fires",
"CSV gets ingested") and follow it through the UI only: in at a door → through the code
→ out to a database/service. Log every point where the thread is lost — where the next
click is not obvious, where the UI has no affordance to continue, where I had to *guess*.
The user flagged this flow as the part they already believe needs UI/UX work; this test
produces the evidence for what specifically fails.

### 4. The briefing test (the exit exam)

Close the loop: write a five-sentence stakeholder brief of the repo **using only what
the UI showed**. Then grade it against the repo's own documentation. Each repo's verdict
is the letter grade of that brief. If the tool works, the brief writes itself; if the
brief can't be written, we know exactly which sentence the tool failed to supply.

### What gets recorded

Per repo, one findings file in the scratchpad with: analyzer stdout (archetype, door
count, warnings, runtime), the blind first-look text, the screen scores, the trace log,
the brief and its grade, and screenshots keyed by finding. Findings tagged by severity:

- **S1 — wrong fact.** The screen asserts something false. Trust-killers; fix first.
- **S2 — missing answer.** A Monday-morning question the screen should answer and doesn't.
- **S3 — confusing.** True and present, but the persona wouldn't get it (jargon, layout,
  lost-thread moments in traces).
- **S4 — papercut.** Friction that doesn't block understanding.

## The roster

Chosen to span archetype × stack × size × maintenance quality. Small first (fast
feedback on the protocol itself), giants last.

### Nick's repos (the real customer's actual portfolio)

| Repo | Why it's in |
| --- | --- |
| `mirrorquiz` | Next.js + **Cloudflare Workers** + Stripe — exercises the brand-new Workers detection on the real repo it was built for, plus payments as a boundary |
| `daily-briefing` | Next.js + OpenAI + Redis — the archetypal vibe-coded AI app; exactly the persona's kind of project |
| `powerfab-dashboard` | The flat-Python repo that started the whole framework-aware effort; probed by script before, never driven in the UI |
| `NBA` | Real Jupyter-notebook repo — first real-world test of `.ipynb` support (ELO models, feature engineering) |
| `Summarization-2.0` | Python pipeline archetype on a real pipeline (SRT → GPT → Word) |
| `NASCAR-Analytics` | TS analytics platform — a second data-heavy TS repo, different shape from Next.js apps |

(`cork-and-note` and the Expo app were driven in earlier sessions — regression only if
time allows. `takeoff-agent-app` (Electron, 16 MB) is a stretch goal.)

### Open source (professionally maintained, the "how does it scale" half)

| Repo | Why it's in |
| --- | --- |
| `shadcn-ui/taxonomy` | The canonical small Next.js 13 + Prisma + NextAuth app — the exact scale a weekend project reaches (~150 files) |
| `fastapi/full-stack-fastapi-template` | FastAPI + SQLModel + React — professionally maintained Python *service* with a TS frontend in one repo; two ecosystems in one atlas |
| `midday-ai/midday` | Next.js + **Supabase** monorepo — real-world test of the new PostgREST doors and RLS badges at production scale |
| `dubinc/dub` | Next.js + Prisma + Redis, very popular — a link-shortener has crisp, explainable data flow, ideal for the trace test |
| `psf/requests` | World-class Python **library** — does the library archetype story hold on the most-imported library on earth? |
| `ageron/handson-ml3` | Professional notebook repo — `.ipynb` support at real scale (big notebooks, many cells) |
| `calcom/cal.com` | The stress test: giant Next.js monorepo. Expect the 5000-file cap, the monorepo warning, long analysis — measuring graceful degradation, not polish |

Order of execution: taxonomy → mirrorquiz → daily-briefing → Summarization-2.0 →
powerfab-dashboard → NBA → full-stack-fastapi-template → requests → NASCAR-Analytics →
dub → midday → handson-ml3 → cal.com.

## Logistics

- Clone shallow (`git clone --depth 1`) into the session scratchpad; delete all clones
  when done. For private repos, remove any `.app-atlas/` artifacts afterward (they are
  not gitignored there — learned this the hard way with powerfab-dashboard).
- Build once from merged `main`; every repo drives the same binary.
- One repo at a time, one port at a time; kill the server before the next.

### The AI question: two phases, not two full runs

The product's own bargain is *facts from the compiler, words from AI* — so the structure
has to stand on its own for anyone running `--no-ai`, and the words have to earn their
place on top. That gives the experiment its shape:

- **Phase 1 — the floor (all 13 repos, `--no-ai`).** The full protocol as written.
  This is the guarantee every user gets regardless of backend, and it is where wrong
  facts and lost threads live. Order matters here: the enricher caches descriptions per
  repo, and `--no-ai` *keeps* previously written ones — so the honest no-AI experience
  can only be measured before an AI pass ever touches the clone.
- **Phase 2 — the delta (4 repos, AI on).** After the user re-authenticates the
  `claude` CLI, re-run a representative subset — `taxonomy` (web-app),
  `powerfab-dashboard` (flat Python), `NBA` (notebooks), `mirrorquiz` (Workers) — and
  repeat only the parts words can change: the blind first-look, any screen scored thin
  in Phase 1, and the briefing test. The question is precise: **which Phase-1 "missing
  answer" findings does prose actually fix?** Whatever prose fixes is acceptable AI
  territory; whatever still fails needs a structural fix. Giant repos are excluded —
  the 400-file AI cap would cover a fraction of cal.com anyway.

Phase 2 also finally unblocks the stale-`ATLAS.md` chore: regenerate it on this repo
while the backend works.

## Deliverables

1. **A synthesis report** (committed to `docs/`): the cross-repo verdict on the core
   question — is this informative enough to help the vibe coder brief stakeholders? —
   plus the per-repo scorecard table and every brief with its grade.
2. **GitHub issues**, one per S1/S2 finding and one per recurring S3 theme (not one per
   sighting), each with the screenshot and the repo that surfaced it, ranked by how many
   repos exhibited it.
3. **A ranked "what to build next" shortlist** derived from the issues — with the trace
   flow UX expected (per the user's own hypothesis) to be near the top, either confirmed
   with evidence or refuted with evidence.

## What this experiment is not

Not a bug hunt (bugs get logged, but fixture tests already cover correctness), not a
performance benchmark (runtimes get recorded only as user-felt wait), and not a redesign
session — no fixing anything mid-drive. Drive first, synthesize once, then fix with the
full picture in hand.
