/**
 * @fileoverview Where the reader had got to in a walkthrough, kept across a reload (#212).
 *
 * A tour drives the map — it drills into folders, focuses nodes, hides branches. Reload
 * four steps in and the tour vanished while all of that navigation stayed, which left
 * somebody inside `components/` on a map they did not open, with nothing on screen
 * saying how they got there or how to get back to the step they were reading.
 *
 * Two decisions worth writing down, because both could reasonably have gone the other way:
 *
 *   - **Offered, not resumed.** A walkthrough that reopens itself and starts moving the
 *     map is its own version of the same problem — the reader did not ask for it this
 *     time either. So what survives a reload is an offer, and taking it is a click.
 *   - **The step is stored by id, not by index.** The atlas is re-analyzed between
 *     visits and tours are computed from it, so step 4 of a traced tour is not
 *     necessarily the same step it was this morning. An id that no longer exists fails
 *     closed to no offer, which is the one outcome that cannot mislead: the alternative
 *     is resuming somebody into a step they were never on.
 *
 * Namespaced by the atlas rather than by the origin. One server can serve several apps
 * in a workspace, and the same port serves a different project tomorrow.
 */

/** Where somebody was in a walkthrough when the page went away. */
export interface ResumePoint {
  tourId: string;
  /** Stable across a re-analysis in a way the index is not — see the note above. */
  stepId: string;
}

const PREFIX = 'app-atlas:resume:';

/** One atlas, in one app of it. Both parts matter in a workspace. */
export function atlasKey(root: string, scopeId: string): string {
  return `${PREFIX}${root}::${scopeId}`;
}

/**
 * Everything here is wrapped, and every failure is silent.
 *
 * Storage throws rather than returns — disabled cookies, private windows, a full quota —
 * and none of that is worth a word on screen. The feature is a convenience; the cost of
 * losing it is one click, and an error about it would be louder than the thing itself.
 */
export function rememberTour(key: string, at: ResumePoint): void {
  try {
    localStorage.setItem(key, JSON.stringify(at));
  } catch {
    // Nothing to do and nothing worth saying.
  }
}

export function forgetTour(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // As above.
  }
}

/**
 * What was stored, if it is still shaped like a resume point.
 *
 * Anything else is treated as absent, including a value written by an older version of
 * this that stored something different. A stored id that no longer names a tour is not
 * checked here — that is the caller's job, because only the caller knows which tours
 * this atlas has.
 */
export function recallTour(key: string): ResumePoint | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const found = JSON.parse(raw) as Partial<ResumePoint>;
    if (typeof found?.tourId !== 'string' || typeof found?.stepId !== 'string') return null;
    return { tourId: found.tourId, stepId: found.stepId };
  } catch {
    return null;
  }
}
