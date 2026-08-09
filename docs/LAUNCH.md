# Launch — publishing v0.19.0, and what to do the day after

*Written 8 August 2026 against v0.19.0. This is the operational half of
[DIRECTION.md](DIRECTION.md): every decision deferred there waits on signals that cannot
exist until somebody other than the author runs this tool.*

---

## Where things stand

**Published, 8 August 2026.** `@app-atlas/cli` is on npm with a SLSA provenance
attestation, and issue [#38](https://github.com/nhorto/App-Atlas/issues/38) — the last one
open — is closed. The install is `npx @app-atlas/cli`; the command is still `app-atlas`.

Everything below the line is now dogfooding, which is the part that cannot be rushed and
the part that decides what gets built next.

---

## Publishing — what it actually took

Kept because the failure modes are not obvious and the next release will meet some of
them again.

The tag/version guard, the test run and `--provenance` all worked first time. **Four
attempts were needed, and none of the first three reached the registry:**

1. **Token scoped to a user scope, not all packages.** A granular token limited to
   `@nick5757` cannot create an unscoped package. npm's message is the generic *"You may
   not perform that action with these credentials,"* which reads like a bad token rather
   than a bad scope.
2. **"Bypass two-factor authentication" unchecked.** A CI runner cannot answer a 2FA
   prompt. npm names this one clearly once the scope is right.
3. **The name was refused.** *"Package name too similar to existing package `appatlas`;
   try renaming your package to '@nick5757/app-atlas'."* npm compares names with
   punctuation stripped, and [`appatlas`](https://github.com/zharmedia386/app-atlas) is an
   unrelated project that happens to share this one's name.
4. **Published under a scope.** First as `@nick5757/app-atlas`, then moved to the
   organization scope `@app-atlas/cli`, which reads as a project rather than a person.

Three lessons worth carrying:

- **Editing a token preserves its value; creating one does not.** Every fresh token means
  updating the `NPM_TOKEN` repo secret too, which turned one fix into two round trips.
- **Check your own name on the registry before writing positioning copy.** Four rounds of
  competitive research searched by capability and never searched by name, so a project
  with this exact name went unnoticed until npm refused the publish.
- **Narrow the token now.** "All packages" was only needed to create the package.

### Verify the published artifact, not the workflow

Non-negotiable, and the reason is in [SPEC.md](../SPEC.md) M11: six real defects
(issues #111–#116) were found by cold-installing a tarball while 612 tests were green, and
that tarball was byte-identical to the one CI had blessed. One of those defects spent money
without asking.

So after the workflow goes green:

- `npm install -g @app-atlas/cli` (or `npx @app-atlas/cli`) into a clean
  environment — **from the registry**, not from the working tree.
- Run every command end to end.
- Run it on a real repository, not a fixture.
- Only then tell anyone it exists.

**Done for 0.19.0**, and it earned its keep immediately: `--version`, `analyze` on a real
96-file project, `export --stdout`, the `mcp` server over stdio and the `npx` path from
the README all behaved — and reading the live tool list against the README caught that the
README advertised six MCP tools when the server serves seven.

---

## Dogfooding

The goal is not adoption. It is **signals** — specifically the ones
[DIRECTION.md](DIRECTION.md) is waiting on.

### Phase 1 — the author, for real, a week or two

Add the MCP server to daily agent sessions and use App Atlas on actual projects. The
question under test is the product's central claim: *does an agent do noticeably better
with the map than without it?* If the honest answer is "hard to tell," that is the most
important finding available and it arrives before anyone else is watching.

This phase also surfaces the rough edges first, which is cheaper than a stranger surfacing
them.

### Phase 2 — three to five developers you know

Make the ask small and specific. Not *"check out my project"* but:

> Run `npx @app-atlas/cli` on one of your repos and tell me one place where the map
> is wrong.

The framing is the point. "It's cool" teaches nothing. **A wrong-map report is the entire
game** — it is simultaneously a bug report, a coverage gap, and the exact trigger
[DIRECTION.md](DIRECTION.md) names for building the conventions config (someone's custom
auth wrapper reading as `unknown`).

Ask a second question of anyone who uses coding agents: *did you keep it?* A week later is
the only honest usage metric at this scale.

### Phase 3 — strangers, once phase 2's findings are fixed

Ordered by fit, not by size of audience:

1. **MCP directories** — awesome-mcp-servers, the MCP registry, Smithery, PulseMCP. App
   Atlas ships an MCP server, so this is targeted, free, and where people go looking for
   exactly this. Per [the August landscape](LANDSCAPE-2026-08.md), PulseMCP traffic is a
   meaningful discovery channel in this category.
2. **Show HN.** One shot; spend it after the small circle's worst findings are fixed.
3. **AI-coding communities** — r/ClaudeAI, r/ChatGPTCoding, developer social.

Hold this phase until phase 2 is answered. A public launch is a one-time impression, and
phase 2 exists to spend the embarrassing bugs on people who like you.

---

## Positioning notes

From [LANDSCAPE-2026-08.md](LANDSCAPE-2026-08.md), the things a launch post has to get
right:

**Do not pitch the plumbing.** Local-first, tree-sitter, SQLite, MCP and a markdown export
are commodity — four projects between 25k and 47k stars give all of it away. A pitch
resting on those is a pitch about a solved problem.

**Pitch the layer above.** The graph engines tell an agent where a function is. App Atlas
tells it what the application is: the doors, who guards them, what data they touch, who
they call.

**Lead with the stance.** The confidence grading is the one thing nothing else in the
category does. "It tells you when it isn't sure" is unusual enough to be the sentence
people repeat — and after M11 the headline itself hedges ("all matched, none proven"),
so the product backs the claim up rather than the README doing it alone.

**The contrast that writes itself.** DeepWiki generates prose about your repo in the cloud;
this reads your repo on your machine and reports what it can prove. Both halves of that
sentence are differentiators, and neither is an insult.

**Know who arrives confused.** Some readers will assume this is a Repomix-style flattener.
The first sentence has to make the difference obvious.

---

## What to measure

Not stars, not downloads.

> **How many people told you where the map was wrong.**

Each one is a real user, on a real codebase, describing a real gap — and it is the input
that converts everything in [DIRECTION.md](DIRECTION.md) from speculation into a backlog.

---

## Appendix — the phase 2 kit (written 9 Aug 2026, against 0.24.0)

### The message, ready to personalize

> I shipped a thing: **App Atlas** — run one command in a repo and get an interactive
> map of the app: every way in, where the data goes, which routes have no auth check.
> All local; nothing leaves your machine.
>
> ```
> npx @app-atlas/cli .
> ```
>
> (Needs Node 22.5+. Python repos also want python3 on the PATH.)
>
> The favor I'm asking is specific: run it on one of your repos and tell me **one place
> where the map is wrong**. A wrong-map report is worth ten compliments to me.
>
> If you drive coding agents: it also ships an MCP server — add
> `npx @app-atlas/cli mcp` to your agent config and tell me whether the agent does
> noticeably better with the map. That question is the whole product.

### What to write down from every reply

One wrong-map report = one GitHub issue, before any fix — the standing rule. Capture:
the repo's language and framework, the wrong claim **verbatim** (screenshot or paste),
and what the truth is. "It felt off" is a conversation; "route X shows likely-guarded
and has no auth" is a finding. A week later, ask the second question: *did you keep it?*

### Honest limits, for when they ask

- **Read deeply:** TypeScript/JavaScript, Python. **Read by grammar** (links likely, not
  certain — and the map says so): Go, C#, Rust. **Counted and hedged, not read:** Ruby,
  PHP, Java, Kotlin, Swift, Elixir and friends — as of 0.24.0 the map says this out
  loud instead of presenting the sliver as the app.
- `.vue` / `.svelte` / `.astro` components are counted, not parsed — import links
  through them are missing and the unimported-file view hedges accordingly.
- Auth verdicts carry confidence: `certain` is a check proven on the handler, `likely`
  is matched rather than proven — the tool will tell you to read those doors yourself.
- Descriptions come from the repo's own docstrings first; AI fills gaps only if a
  backend is configured, never silently spends money, and `--no-ai` turns it off.

### Why now is the right moment to send it

Eleven unfamiliar repositories have been dogfooded and all eleven produced defects —
the fixture suite was green the whole time. The findings that class of testing can
reach are thinning; other people's repos are the next distribution of shapes, and
their wrong-map reports are the triggers DIRECTION.md waits on.
