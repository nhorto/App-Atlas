# Direction — two ideas, and what we decided to do about them

*Written 8 August 2026, immediately after v0.19.0 and the release-readiness work in
[SPEC.md](../SPEC.md) M11. This is a record of a conversation, not a plan of record. It
exists because both ideas below are the kind that get re-litigated every few months by
people who no longer remember why they were deferred — including the people who deferred
them.*

*Nothing here is scheduled. Both ideas end with a **trigger**: an observable event that
says "now build it." Until a trigger fires, the answer is no, and the reason is written
down so the no can be re-examined honestly rather than re-argued from scratch.*

---

## The short version

| Idea | Verdict | Trigger |
|---|---|---|
| **Packs** — extensibility, "make it yours" | **Mechanism yes, ecosystem no.** A repo-local conventions config is worth building for a single user. Distribution, discovery and a pack registry are infrastructure for a community that does not exist. | Someone hits an `unknown` guard on their own auth wrapper and it annoys them in practice. |
| **Skeleton-first** — author the structure, then fill it in | **Yes in principle, unbuilt in practice.** The data model can carry it; the entire workflow around it is missing. Correctly sized as a byproduct of the atlas, not a pivot. | The user runs the workflow *manually* on one project and misses having a real diff. |
| **A GUI for defining types** | **Later, and only as a view.** The format is the source of truth; the GUI edits it. | The blueprint format exists and has been used. |

The single fact underneath all three rows: **App Atlas has no users yet.** It is not on
npm. Every design decision that depends on how strangers behave is currently a guess, and
guesses are cheaper to defer than to unwind.

---

## Where this came from

The ideas arrived together, from an observation about open source: some projects are
valued less for what they do than for being *small enough to take apart* — you use a
piece, you extend it, your agent adds to it, it becomes yours. The question was whether
App Atlas should work that way, and whether that same modularity should extend to how
people build applications with it.

They are two ideas. It took a round of back-and-forth to notice they are two sides of one
reframe:

> Today the atlas is something App Atlas **derives**. Both ideas make it something people
> **author**. Packs let you author how the map gets made. Skeleton-first lets you author
> the map before the code exists.

That is why they are in one document.

---

# Idea 1 — Packs

## What it is

Extensibility: a user teaches App Atlas about a framework, a convention, or a house style
it does not already know, and that teaching is a small artifact — a file you can read in a
minute — rather than a fork of the analyzer.

## Why it fits

It is not a bolt-on. `src/analyze/boundaries/` emits findings and `build.ts` merges them
project-wide; detectors never create atlas nodes, and the merge layer is language-neutral.
That seam is exactly where a plugin surface belongs, and it already exists for internal
reasons.

The motivating problem is documented and real. The framework long tail in
[GAPS.md](GAPS.md) — Nuxt, Astro, Litestar, Elysia, AdonisJS, Rust's axum and actix — is a
list we will never finish ourselves. Packs turn our backlog into somebody else's Tuesday
afternoon.

## The split that decided it

"Packs" bundles two things that have very different risk profiles.

**The mechanism is valuable to one user.** The problem "App Atlas doesn't know that
`withAuth` in *my* codebase is a guard, so my routes read as `unknown`" exists on day one
for a solo developer. `unknown` is our least useful answer, and a repo-local config that
teaches the tool a project's own conventions fixes it for the person who wrote the config.
No community required.

**The ecosystem is a bet on strangers.** Distribution, discovery, versioning, a registry,
the marketing push — all of it is designed for behaviour we have never observed. An empty
pack registry is worse than no pack registry: it makes the project look aspirational
instead of useful. Ecosystems grow out of demand or they are ghost towns.

The load-bearing detail is that **deferring the second costs nothing**, because a pack is
just the config file with a name on it. Build the mechanism when someone needs it, and the
distribution seam is already there if it is ever wanted.

## The marketing constraint is a design constraint

The projects this idea admires market *legibility*, not features. "Make it yours" is
credible when the thing is small enough to read. Our equivalent claim would be:

> A pack is one small file you can read in a minute, and your agent can write one for your
> codebase.

If a pack ever requires tree-sitter knowledge, that sentence becomes false and no amount
of copy rescues it. **Pack format simplicity is the pitch**, which means it is a
constraint on the format, not a task for later.

## What would be built, when the trigger fires

A repo-local declarative config — the smallest thing that turns `unknown` into a graded
answer for one project. Specifically: name a wrapper or decorator and say it is a guard
and at what confidence; name a routing helper and say it makes a door. Nothing more until
something else hurts.

---

# Idea 2 — Skeleton-first building

## What it is, and what it is not

You lay out the skeleton of an application first: the file structure, the types, and — if
you want to go further — a note in each file saying what functions or classes belong
there. An agent builds the code around that skeleton. You can write the skeleton yourself,
or have the agent draft one and approve or change it.

**The purpose is comprehension, not construction.** You will not have written every line,
but you will know how your app is structured, because you structured it. You know where to
go when an error appears. You know how it works. That is the whole point, and it is the
reason this belongs in App Atlas rather than in the enormous pile of tools that generate
applications from a description.

This document records that the first reading of this idea, in conversation, was wrong: it
was heard as "build your app here," and answered with a warning about mappers that become
builders and die. That warning was aimed at something nobody proposed. The correction is
worth keeping, because the same misreading is the obvious one and will happen again.

## Why it belongs here

App Atlas exists because understanding gets lost. Code is written — increasingly by
agents — and the structure ends up in nobody's head, so we recover it after the fact.

Skeleton-first attacks the same problem from the other end. If you authored the skeleton,
the map is not a *recovery* of your app's structure. It is a *confirmation* of it.
Map-after and skeleton-before are two directions on the same artifact.

## Why the map is what makes it work

The value claimed above — "you know where to go when something breaks" — is accurate on
day one and decays every day an agent commits code. Skeleton-first *without* verification
gives you a confident mental model of an application that no longer exists. That is worse
than no model.

So the durable half is the conformance check: build the real atlas, diff it against the
blueprint, report the drift. *You planned a guard on `/admin`; the code that got written
doesn't have one.* The skeleton is fairly hollow without it, which is another way of
saying this feature is downstream of the atlas rather than parallel to it — exactly the
sizing this idea arrived with.

Independent evidence that the drift half is the valuable half: vFunction sells
"architectural observability" — baseline the architecture, detect drift — into enterprise
modernization budgets. ArchUnit (Java) and ts-arch make the same bet at the OSS end, and
ArchUnit is widely adopted. See [the August landscape](LANDSCAPE-2026-08.md).

## What exists already, honestly

**What helps:** the data model can represent it. Nodes, doors, guards, stores and types
are all expressible without a schema change, and there is precedent for nodes that do not
correspond to parsed code — `synthesizeRouteHandlers()` in `src/analyze/generic/index.ts`
creates function nodes marked `synthesized: 'route-handler'` for minimal-API handlers.
The MCP server and `ATLAS.md` mean an agent could consume a blueprint the day one exists.

**What is missing:** everything else. There is no way to *author* an atlas — the entire
system flows one direction, code → atlas. A blueprint needs an authoring format meant for
humans and agents to write, validation of that format, optional scaffolding of files from
it, and the diff-and-report pass that gives it its point.

That is a milestone on the scale of the .NET work (M10), not a backend adjustment. Saying
so plainly here because "we already have everything in place" is a half-truth that would
lead to badly wrong scheduling.

## Why the trigger is cheap

Unlike packs, this idea has one known prospective user: the person who would use it, who
builds with agents constantly. That is a real signal, and it can be tested without writing
any code:

> On the next new project, do it manually. Write the file structure and types as a plain
> blueprint file by hand. Have the agent build against it. Run App Atlas on the result and
> compare by eye.

If the workflow feels valuable and the missing diff is annoying, build it — and the design
will be informed by having lived it. If it feels like ceremony, a milestone was saved. A
one-project experiment is a very cheap way to buy that answer.

---

# Idea 3 — The GUI

The reference point is Framer: a graphical interface for building the thing, rather than
writing it by hand. Applied here: define your types in an interface instead of typing
them, and have it follow the rules of the language.

Two objections, neither fatal, both worth writing down.

**The type system does not fit in a form.** Records, enums, optionals and relations
between types are genuinely nicer in a GUI. Generics, unions of shapes, and conditional
types are where a GUI becomes a worse text editor. The good version covers the simple 80%,
provides an escape hatch to text, and never pretends to cover the rest.

**Your agent cannot click.** This is the structural one. If the skeleton lives only as GUI
state, agents are cut out of a loop that the rest of App Atlas — MCP, `ATLAS.md` — is
built to include. So the format must be the source of truth: something a person and an
agent can both author. The GUI is an editor *view* of that format, and it belongs in the
web app that already renders atlases.

That ordering is the difference between a good week of work and a bad quarter.

---

# Sequencing

**Packs before skeletons**, if both ever happen, for one non-obvious reason: designing the
pack config forces us to define a stable declarative vocabulary for *"here is what a door,
a guard, or a store looks like in my world."* A blueprint wants almost exactly that
vocabulary. Get the pack format right and the blueprint format inherits it. Do it in the
other order and the vocabulary gets designed twice, differently.

**Everything is behind publishing.** Both triggers require someone to be using App Atlas.
Issue [#38](https://github.com/nhorto/App-Atlas/issues/38) — publish to npm — is the only
thing that unblocks the signals every decision here is waiting on. See
[LAUNCH.md](LAUNCH.md).

---

## What this document is not

It is not a commitment to build any of the above, and it is not a roadmap. If a trigger
never fires, the correct outcome is that none of this gets built and the reasoning above
explains why that was fine.

The principle it is trying to preserve, stated once, plainly:

> Don't build things to fill a hole you don't know is there.
