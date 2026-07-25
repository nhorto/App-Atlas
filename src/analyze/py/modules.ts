/**
 * @fileoverview Turning `from app.db import get_session` into a file on disk.
 *
 * Python has no project file that says where the import root is. The same repo can be
 * imported as `app.db` from its own root, as `backend.app.db` from one level up, and
 * as `db` from inside the package — all three are correct, and which one appears in the
 * source depends on how the app is started.
 *
 * So rather than guessing a source root, every file is indexed under *every* dotted
 * name it could legitimately answer to, and a lookup only counts when exactly one file
 * answers. Two candidates means we do not know, and an invented edge is worse than a
 * missing one.
 */

export interface ModuleIndex {
  /** Dotted name → the repo-relative files that could be it. */
  candidates: Map<string, string[]>;
}

/** Strips the file extension and the `__init__` that stands for a package itself. */
function moduleParts(relPath: string): string[] {
  const withoutExt = relPath.replace(/\.pyi?$/, '');
  const parts = withoutExt.split('/');
  if (parts[parts.length - 1] === '__init__') parts.pop();
  return parts;
}

export function buildModuleIndex(relPaths: string[]): ModuleIndex {
  const candidates = new Map<string, string[]>();
  const add = (key: string, relPath: string) => {
    if (!key) return;
    const list = candidates.get(key);
    if (list) {
      if (!list.includes(relPath)) list.push(relPath);
    } else {
      candidates.set(key, [relPath]);
    }
  };

  for (const relPath of relPaths) {
    const parts = moduleParts(relPath);
    // Every suffix: `backend/app/db.py` answers to backend.app.db, app.db and db.
    for (let start = 0; start < parts.length; start++) {
      add(parts.slice(start).join('.'), relPath);
    }
  }
  return { candidates };
}

/**
 * Resolves one import to a repo-relative path, or null.
 *
 * `level` is the number of leading dots: `from .db import x` in `app/api.py` is
 * `app.db`, and `from ..models import y` is one package further out. Relative imports
 * are unambiguous, so they are resolved by construction rather than by lookup.
 */
export function resolveModule(index: ModuleIndex, fromRelPath: string, module: string, level: number): string | null {
  if (level > 0) {
    const here = moduleParts(fromRelPath);
    // A `from . import x` inside `app/api.py` means the `app` package: one dot climbs
    // to the file's own package, each extra dot climbs one more.
    const base = here.slice(0, Math.max(0, here.length - level));
    const dotted = [...base, ...(module ? module.split('.') : [])].join('.');
    return exact(index, dotted);
  }
  return exact(index, module);
}

function exact(index: ModuleIndex, dotted: string): string | null {
  const found = index.candidates.get(dotted);
  return found && found.length === 1 ? found[0] : null;
}
