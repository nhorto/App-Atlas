/**
 * @fileoverview Which commit a directory's working tree is sitting on.
 *
 * An atlas is a set of claims about code as it was at one moment. The moment is already
 * recorded — `meta.generatedAt` — but a timestamp is the wrong unit for the question an
 * agent actually has, which is *"has the code moved since?"*. Ten minutes is nothing on a
 * repo nobody touched and three features on one an agent has been working in. The commit
 * is the unit that answers it, so the analyzer writes down which one it read and every
 * MCP answer can compare that against the working tree in front of it.
 *
 * This reads `.git` rather than running `git`, and the reason is the feature itself. The
 * whole point is comparing two commits that were resolved at different times by different
 * processes; if the analyzer asked `git rev-parse` and the server read files, any
 * disagreement between the two would surface as a staleness warning about a repo that
 * never moved. One implementation used by both sides cannot disagree with itself. It also
 * means the MCP server needs no subprocess per answer, and that a machine without git
 * installed behaves the same as one with it.
 *
 * Every failure returns null, which the callers state as "nobody could tell" rather than
 * as "up to date". A false alarm here costs a re-analysis; a false all-clear costs an
 * agent acting on a map of code that no longer exists.
 */
import fs from 'node:fs';
import path from 'node:path';

/** A full object name, as git writes them. */
const SHA = /^[0-9a-f]{40}$/;

/**
 * Symbolic refs point at other refs, and in principle at further ones. Nothing in normal
 * use nests beyond `HEAD` → `refs/heads/<branch>`, so this only has to be a bound that
 * stops a corrupt repository from spinning rather than a depth anyone will reach.
 */
const MAX_SYMREF_HOPS = 5;

/** Where git keeps its own files for a directory, and where shared refs live. */
interface GitDirs {
  /** This tree's own git directory — per-worktree HEAD lives here. */
  git: string;
  /** The main repository's git directory, which holds `refs/heads` and `packed-refs`. */
  common: string;
}

/**
 * The commit the working tree at `dir` is on, or null when that cannot be established.
 *
 * Null is returned for every failure and they are deliberately not distinguished: not a
 * repository, an unreadable `.git`, a branch with no commits on it yet, a shape this does
 * not understand. The callers have one thing to say in all of those cases — that they do
 * not know — and a caller that cannot tell the difference cannot accidentally report one
 * of them as the other.
 *
 * Directories above `dir` are searched, the way git itself resolves a repository from a
 * subdirectory. Analyzing one app of a monorepo is the ordinary case, and that app's code
 * is at the enclosing repository's commit even though there is no `.git` beside it.
 */
export function headCommit(dir: string): string | null {
  try {
    const dirs = findGitDirs(path.resolve(dir));
    if (!dirs) return null;

    let ref = readFirstLine(path.join(dirs.git, 'HEAD'));
    for (let hop = 0; ref && hop < MAX_SYMREF_HOPS; hop++) {
      if (SHA.test(ref)) return ref;
      if (!ref.startsWith('ref:')) return null;

      const name = ref.slice(4).trim();
      if (!name || name.includes('..') || path.isAbsolute(name)) return null;
      ref = resolveRef(dirs, name);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The first seven characters, which is how a commit is written when a person will read it.
 *
 * Short enough to scan in a sentence and long enough to be the commit somebody means. The
 * atlas always stores the whole object name; this is only ever for prose.
 */
export function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

/**
 * Walks up from `dir` looking for a repository, and works out where its refs are kept.
 *
 * `.git` is a directory in an ordinary clone and a file holding `gitdir: <path>` in a
 * linked worktree or a submodule. In the linked-worktree case the git directory found
 * that way holds this tree's own HEAD, while `refs/heads` and `packed-refs` stay in the
 * main repository — which the `commondir` file beside it points at. Both are needed:
 * asking the wrong one gives the wrong branch's commit, or none at all.
 */
function findGitDirs(from: string): GitDirs | null {
  let dir = from;
  for (;;) {
    const candidate = path.join(dir, '.git');
    const stat = statOrNull(candidate);

    if (stat?.isDirectory()) return { git: candidate, common: candidate };
    if (stat?.isFile()) {
      const line = readFirstLine(candidate);
      const pointer = line?.startsWith('gitdir:') ? line.slice(7).trim() : null;
      if (!pointer) return null;

      const git = path.resolve(dir, pointer);
      if (!statOrNull(git)?.isDirectory()) return null;
      return { git, common: commonDirOf(git) };
    }

    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The main repository's git directory for a linked worktree, or the same directory. */
function commonDirOf(git: string): string {
  const pointer = readFirstLine(path.join(git, 'commondir'));
  return pointer ? path.resolve(git, pointer) : git;
}

/**
 * The object name a ref holds, read the way git reads one: loose file first, then the
 * packed table.
 *
 * The order is the part that matters. A packed `refs/heads/main` left behind by a `git
 * gc` and a loose one written by the commit made since it both exist, and only the loose
 * one is current — reading the packed table first would report the commit before last.
 *
 * This tree's own git directory is tried before the shared one so that a linked
 * worktree's per-worktree refs win, and the shared one then answers for `refs/heads`,
 * which is where a branch actually lives however many worktrees are checked out of it.
 */
function resolveRef(dirs: GitDirs, name: string): string | null {
  for (const base of dirs.git === dirs.common ? [dirs.git] : [dirs.git, dirs.common]) {
    const loose = readFirstLine(path.join(base, name));
    if (loose) return loose;
  }
  return packedRef(dirs.common, name);
}

/** The object name for `name` in `packed-refs`, or null if it is not listed there. */
function packedRef(common: string, name: string): string | null {
  const packed = readText(path.join(common, 'packed-refs'));
  if (!packed) return null;

  for (const raw of packed.split('\n')) {
    const line = raw.trim();
    // `#` opens the header, and `^` opens the commit a tag points at — never a ref's
    // own value, and reading one as such would answer with the wrong object.
    if (!line || line.startsWith('#') || line.startsWith('^')) continue;

    const space = line.indexOf(' ');
    if (space === -1) continue;
    if (line.slice(space + 1).trim() === name) {
      const sha = line.slice(0, space);
      return SHA.test(sha) ? sha : null;
    }
  }
  return null;
}

function statOrNull(target: string): fs.Stats | null {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** The first line of a file, trimmed, or null when it is missing, empty or unreadable. */
function readFirstLine(file: string): string | null {
  const text = readText(file);
  if (text === null) return null;
  const line = text.split('\n', 1)[0].trim();
  return line.length > 0 ? line : null;
}
