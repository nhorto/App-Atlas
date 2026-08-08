# Launch — publishing v0.19.0, and what to do the day after

*Written 8 August 2026 against v0.19.0. This is the operational half of
[DIRECTION.md](DIRECTION.md): every decision deferred there waits on signals that cannot
exist until somebody other than the author runs this tool.*

---

## Where things stand

Everything mechanical is done and verified:

| Check | State |
|---|---|
| The name `app-atlas` on npm | **Free** — registry returns 404 |
| Repo visibility | **Public** (`--provenance` requires it) |
| `package.json` version | 0.19.0, `bin` → `dist/node/cli.js` |
| Release workflow | `.github/workflows/release.yml`, fires on `v*` tags |
| Tag/version agreement | Enforced by the workflow — a mismatched tag fails the job |
| Test suite in the release path | `npm test` runs before publish, and again as `prepublishOnly` |
| `npm pack` | Clean, ~1.6 MB |
| CI | Green on Ubuntu + Windows × Node 22 + 24 |

**The one missing thing is a credential.** Issue
[#38](https://github.com/nhorto/App-Atlas/issues/38) is blocked on a person, not on code.

---

## Publishing

**Steps 1–3 require the maintainer's npm account and cannot be done by an agent.**

1. **An npm account with 2FA**, if there isn't one already.
2. **A granular access token** — npmjs.com → *Access Tokens* → *Generate New Token* →
   Granular Access Token. *Packages and scopes*: **Read and write**. Because `app-atlas`
   does not exist yet, scope it to all packages for the first publish, then narrow it to
   the single package afterwards. Short expiry; it is only needed at release time.
3. **Give it to the repo:**
   ```
   gh secret set NPM_TOKEN --repo nhorto/App-Atlas
   ```
   Paste the token at the prompt. It goes to GitHub and nowhere else.
4. **Tag and push** — `v0.19.0`, matching `package.json`. The workflow checks out, runs the
   suite, and publishes with `--provenance`, which records on the package page which commit
   and which workflow produced the tarball. That matters more than usual here: App Atlas
   asks people to run it over source they have not published, so "this is the code that was
   audited" is worth the extra file.

### Then verify the published artifact, not the workflow

Non-negotiable, and the reason is in [SPEC.md](../SPEC.md) M11: six real defects
(issues #111–#116) were found by cold-installing a tarball while 612 tests were green, and
that tarball was byte-identical to the one CI had blessed. One of those defects spent money
without asking.

So after the workflow goes green:

- `npm install -g @nick5757/app-atlas` (or `npx @nick5757/app-atlas`) into a clean
  environment — **from the registry**, not from the working tree.
- Run every command end to end.
- Run it on a real repository, not a fixture.
- Only then tell anyone it exists.

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

> Run `npx @nick5757/app-atlas` on one of your repos and tell me one place where the map
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
