/**
 * @fileoverview Adding one list to another without a limit on how long it is.
 *
 * `target.push(...source)` passes every element as a separate argument, so past a few
 * tens of thousands it overflows the stack. Sentry — 5,000 Python files and the whole
 * of its frontend — produced enough nodes to hit that, and because the CLI catches a
 * failing scope so one bad package cannot cost you the other five, the only sign was
 * the words "could not be read" beside the repo's own name.
 *
 * The size at which it breaks is the engine's, not ours, and it is exactly the size at
 * which somebody most needs a map. So the spread never appears on a project-wide list.
 */
export function appendAll<T>(target: T[], source: readonly T[]): void {
  for (const item of source) target.push(item);
}
