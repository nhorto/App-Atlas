/**
 * @fileoverview The one place the web app spells out an open-door verdict.
 *
 * Two components used to carry their own switches over `OpenKind`, each with a default
 * branch, and both defaults were written for a world of four kinds. When `generated`,
 * `unlinked` and `declared-public` arrived, the Insights badge fell through to the
 * label meant for guarded routes — the word "checked", on a door with no check — and
 * the map card fell through the other way, to a red "no auth check" on doors that are
 * unchecked *with a reason* (#161). Opposite errors, same cause: a switch that cannot
 * notice a kind it has never heard of.
 *
 * `Record<OpenKind, …>` is the fix that stays fixed. The next verdict kind added to
 * the model fails the typecheck here instead of silently wearing whichever fallback
 * lies in its direction.
 */
import type { OpenKind } from './types';

/** What the badge says. Short, because it sits on a card; the tooltip carries the why. */
export const OPEN_LABELS: Record<OpenKind, string> = {
  'worth-a-look': 'no auth check',
  unreadable: 'not examined',
  page: 'public page',
  'auth-mount': 'the sign-in door',
  generated: 'a build wrote it',
  unlinked: 'not followed',
  'declared-public': 'open on purpose',
};

/**
 * Which colour it wears: `open` is the red worth interrupting for, `unknown` is
 * ignorance owned honestly, `public` is unchecked with a reason. `unlinked` sits with
 * `unreadable` because "we have not followed it" is a fact about this reader, not
 * about the door.
 */
export const OPEN_TONES: Record<OpenKind, 'open' | 'unknown' | 'public'> = {
  'worth-a-look': 'open',
  unreadable: 'unknown',
  unlinked: 'unknown',
  page: 'public',
  'auth-mount': 'public',
  generated: 'public',
  'declared-public': 'public',
};
