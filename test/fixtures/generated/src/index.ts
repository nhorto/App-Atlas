/**
 * @fileoverview The hand-written surface — the part semver actually binds.
 */
export interface Options {
  retries: number;
}

/** The one thing consumers call. */
export function connect(options: Options): string {
  return `connected with ${options.retries}`;
}
