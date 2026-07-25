/**
 * @fileoverview Path helpers.
 *
 * Everything stored in the atlas uses repo-relative POSIX paths, regardless of the
 * host OS, so an atlas produced on Windows reads identically on macOS or Linux.
 */
import path from 'node:path';

/** Converts any OS path to forward slashes. */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Repo-relative POSIX path for an absolute path. */
export function relPosix(root: string, absolute: string): string {
  return toPosix(path.relative(root, absolute));
}

/** Parent directory of a POSIX path; '' for a top-level entry. */
export function dirOfPosix(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

/** Final segment of a POSIX path. */
export function baseNameOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

/** Every ancestor directory of a POSIX file path, shallowest first, excluding ''. */
export function ancestorDirs(filePath: string): string[] {
  const dir = dirOfPosix(filePath);
  if (dir === '') return [];
  const segments = dir.split('/');
  const out: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    out.push(segments.slice(0, i + 1).join('/'));
  }
  return out;
}

/** Lowercased file extension including the dot, e.g. '.tsx'. */
export function extOf(p: string): string {
  const base = baseNameOf(p);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i).toLowerCase();
}
