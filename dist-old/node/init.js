/**
 * @fileoverview `app-atlas init` — teaching the user's own agent to document as it builds.
 *
 * This is the smallest file in the project and probably the highest-leverage one.
 *
 * The audience steers a coding agent all day. If that agent writes a `@fileoverview`
 * in every file it creates, App Atlas reads those verbatim: free, instant, accurate,
 * versioned with the code, and better than anything a summarising model would produce
 * from the outside, because the docstring was written by the thing that knew the
 * intent. Enrichment cost then trends toward zero on exactly the repos that get worked
 * on most, and the user's codebase ends up documented as a side effect of being mapped.
 *
 * The block is fenced with markers so running this twice updates in place instead of
 * stacking copies — people will run it again after every release.
 */
import fs from 'node:fs';
import path from 'node:path';
const START = '<!-- app-atlas:conventions -->';
const END = '<!-- /app-atlas:conventions -->';
/** Instruction files agents actually read, in the order we would rather create one. */
const CANDIDATES = ['AGENTS.md', 'CLAUDE.md', '.cursorrules', '.github/copilot-instructions.md'];
const BLOCK = `${START}
## Documentation conventions

This repository is mapped with [App Atlas](https://github.com/nhorto/App-Atlas), which
reads docstrings straight out of the code and shows them to people who do not read code.
Write them as you go:

- **Every file** opens with a \`/** @fileoverview … */\` block saying what the file is
  for in one or two plain sentences — not what it contains, what it is *for*.
- **Every exported function and type** gets a docstring saying what it does, when it
  runs, and anything surprising about it.
- Write for someone who cannot read the code. "Checks a password against the database"
  beats "async wrapper around the users query". Avoid words the reader would only meet
  inside a codebase.
- If you change what something does, update its docstring in the same edit. App Atlas
  hashes bodies and docstrings separately and flags the ones that have drifted apart.

Docstrings are used verbatim and cost nothing. Anything left undocumented gets an
AI-generated description instead, so this is the cheapest documentation there is.
${END}`;
/**
 * Adds the convention block to every agent instruction file in the project, creating
 * one if there are none. Returns what happened to each, so the CLI can report it.
 */
export function initConventions(root, only) {
    const targets = only ? [only] : CANDIDATES.filter((name) => fs.existsSync(path.join(root, name)));
    // A repo with no agent instructions yet gets the file with the broadest support
    // rather than one vendor's — this convention is worth as much to Codex as to Claude.
    if (targets.length === 0)
        targets.push(CANDIDATES[0]);
    return targets.map((name) => write(path.join(root, name)));
}
function write(filePath) {
    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
    if (existing === null) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `${BLOCK}\n`, 'utf8');
        return { path: filePath, action: 'created' };
    }
    const start = existing.indexOf(START);
    const end = existing.indexOf(END);
    if (start !== -1 && end > start) {
        const current = existing.slice(start, end + END.length);
        if (current === BLOCK)
            return { path: filePath, action: 'unchanged' };
        const updated = existing.slice(0, start) + BLOCK + existing.slice(end + END.length);
        fs.writeFileSync(filePath, updated, 'utf8');
        return { path: filePath, action: 'updated' };
    }
    // Appended rather than prepended: whatever the user put at the top of their own
    // instructions is more important than ours.
    const separator = existing.endsWith('\n') ? '\n' : '\n\n';
    fs.writeFileSync(filePath, `${existing}${separator}${BLOCK}\n`, 'utf8');
    return { path: filePath, action: 'updated' };
}
//# sourceMappingURL=init.js.map