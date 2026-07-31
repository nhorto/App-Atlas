/**
 * @fileoverview What changed since the last run (issue #41).
 *
 * Every other view in this tool answers "what is my app". This one answers the question
 * somebody who spent a weekend letting an agent write code is actually asking on Monday:
 * *what did it do to my app?* One sentence — "3 new doors appeared since Tuesday, 2 of
 * them with nothing checking them" — is worth more to that reader than the rest of the
 * map, and every fact it needs is already in the atlas.
 *
 * **Where the baseline lives.** There is no second copy of it. `.app-atlas/atlas.db`
 * holds the last successful run's nodes and edges right up until the current run
 * finishes and overwrites them, which is the same window `staleness.ts` already reads
 * through. A `previous.db` beside it would be a second copy of a fact we already have,
 * with its own way of going quietly stale, and it would need its own answer to "was this
 * written by the run I think it was". Because the baseline is only ever replaced by a
 * completed run, a crashed run cannot poison it, and `--fresh` — which clears the
 * per-file cache and nothing else — cannot destroy it either.
 *
 * **What "changed" was decided to mean.** Node ids here are *addressed*, not
 * content-addressed: a file is `file:src/db.ts`, a function is `func:src/db.ts#connect`,
 * a door is `endpoint:http-route:POST /api/users`. The content lives in the separate
 * `hash` field. So the diff is by id, and:
 *
 *   - **added** — an id this run has and the last one did not.
 *   - **removed** — an id the last run had and this one does not.
 *   - **changed** — the same id, a different `hash`.
 *
 * Renaming a function is therefore one removal and one addition rather than a change,
 * and that is the honest reading: `connect` and `openPool` are not the same name, and
 * anything importing the old one is now broken. The same goes for a route that moved
 * address — to a stranger on the internet, `POST /api/users` and `POST /api/people` are
 * two different doors, not one door edited.
 *
 * **Why doors are compared field by field rather than by hash.** An endpoint's `hash` is
 * built from its id and how many places it was found — it deliberately does not cover
 * its guards. A door that quietly lost its auth check keeps the same hash, so a hash
 * diff would miss the single most alarming event this feature exists to report. The
 * guards are read directly instead.
 */
import { isAuthRelevant } from './exposure.js';
import type {
  Atlas,
  AtlasChanges,
  AtlasMeta,
  AtlasNode,
  ChangeCounts,
  DoorChange,
  DoorChanges,
  EndpointMeta,
  NodeKind,
} from './types.js';

/** A run to compare against, plus the empty diff that stands in when there is none. */
function emptyCounts(): ChangeCounts {
  return { added: 0, removed: 0, changed: 0 };
}

function emptyDoors(): DoorChanges {
  return { newTotal: 0, newOpen: [], lostCheck: [], removed: [] };
}

/**
 * Compares a freshly analyzed atlas against the one the previous run left on disk.
 *
 * Call it with the atlas that was on disk *before* this run overwrites it — the same
 * value `markStaleDocs` is given. Pass `null` when there was none; the result then says
 * "no baseline", which is a different statement from "nothing changed" and a very
 * different one from "everything is new".
 *
 * Never throws and never guesses: when the two atlases are not comparable — a different
 * version of App Atlas wrote one of them, or it was written for another directory — the
 * result carries the reason instead of four hundred meaningless additions.
 */
export function diffAtlas(previous: Atlas | null, next: Atlas): AtlasChanges {
  if (!previous) {
    return {
      baseline: 'none',
      because: null,
      since: null,
      total: emptyCounts(),
      byKind: {},
      doors: emptyDoors(),
    };
  }

  const mismatch = whyNotComparable(previous.meta, next.meta);
  if (mismatch) {
    return {
      baseline: 'incomparable',
      because: mismatch,
      since: previous.meta.generatedAt ?? null,
      total: emptyCounts(),
      byKind: {},
      doors: emptyDoors(),
    };
  }

  const before = new Map(previous.nodes.map((node) => [node.id, node]));
  const after = new Map(next.nodes.map((node) => [node.id, node]));

  const total = emptyCounts();
  const byKind: Partial<Record<NodeKind, ChangeCounts>> = {};
  const count = (kind: NodeKind, field: keyof ChangeCounts) => {
    total[field]++;
    const bucket = byKind[kind] ?? (byKind[kind] = emptyCounts());
    bucket[field]++;
  };

  for (const node of next.nodes) {
    const old = before.get(node.id);
    if (!old) count(node.kind, 'added');
    else if (old.hash !== node.hash) count(node.kind, 'changed');
  }
  for (const node of previous.nodes) {
    if (!after.has(node.id)) count(node.kind, 'removed');
  }

  return {
    baseline: 'compared',
    because: null,
    since: previous.meta.generatedAt ?? null,
    total,
    byKind,
    doors: diffDoors(previous.nodes, next.nodes, before, after),
  };
}

/**
 * Whether two atlases can be subtracted from one another at all, and if not, why not.
 *
 * All three checks are about the same thing: a diff is only meaningful when both sides
 * were produced by the same rules about the same code. A different tool version may have
 * learned a new framework overnight, in which case every route it now sees would report
 * as new; a different root is simply a different project.
 */
function whyNotComparable(before: AtlasMeta, after: AtlasMeta): string | null {
  if (before.formatVersion !== after.formatVersion) {
    return `the atlas already on disk is stored in format v${before.formatVersion} and this one is v${after.formatVersion}`;
  }
  if (before.toolVersion !== after.toolVersion) {
    return `the atlas already on disk was written by App Atlas v${before.toolVersion} and this is v${after.toolVersion}`;
  }
  if (before.root !== after.root) {
    return `the atlas already on disk was written for ${before.root}, which is not this directory`;
  }
  return null;
}

/**
 * The doors that moved, read out of the endpoint nodes on both sides.
 *
 * Only doors a stranger can knock on are considered, using the same rule the auth
 * coverage numbers use — a cron job appearing is a fact about a schedule, not about
 * exposure, and mixing the two would inflate the one number that has to stay believable.
 *
 * `newOpen` is exactly the new members of the set `stats.unprotectedRoutes` counts, so
 * the headline here and the headline there can never disagree. `lostCheck` deliberately
 * is *not* filtered that way: a door that had a check last run and has none now is an
 * event rather than a background level, there is never a long list of them, and the one
 * case the filter would swallow — a page whose auth call was deleted — is precisely the
 * one somebody needs to hear about.
 */
function diffDoors(
  previousNodes: AtlasNode[],
  nextNodes: AtlasNode[],
  before: Map<string, AtlasNode>,
  after: Map<string, AtlasNode>,
): DoorChanges {
  const doors = emptyDoors();

  for (const node of nextNodes) {
    if (node.kind !== 'endpoint') continue;
    const meta = node.meta as unknown as EndpointMeta;
    if (!isAuthRelevant(meta)) continue;

    const old = before.get(node.id);
    if (!old) {
      doors.newTotal++;
      if (meta.open?.kind === 'worth-a-look') doors.newOpen.push(toDoorChange(node, meta));
      continue;
    }

    const oldMeta = old.meta as unknown as EndpointMeta;
    const wasChecked = (oldMeta.guards ?? []).length > 0;
    if (wasChecked && (meta.guards ?? []).length === 0) doors.lostCheck.push(toDoorChange(node, meta));
  }

  for (const node of previousNodes) {
    if (node.kind !== 'endpoint' || after.has(node.id)) continue;
    const meta = node.meta as unknown as EndpointMeta;
    if (!isAuthRelevant(meta)) continue;
    doors.removed.push(toDoorChange(node, meta));
  }

  doors.newOpen.sort(byWeightThenName);
  doors.lostCheck.sort(byWeightThenName);
  doors.removed.sort(byWeightThenName);
  return doors;
}

/** A door that writes data first, then alphabetically, so the list reads the same twice. */
function byWeightThenName(a: DoorChange, b: DoorChange): number {
  return Number(b.writes) - Number(a.writes) || a.name.localeCompare(b.name);
}

function toDoorChange(node: AtlasNode, meta: EndpointMeta): DoorChange {
  const site = meta.sites?.[0];
  return {
    id: node.id,
    name: meta.route ? `${meta.method ? `${meta.method} ` : ''}${meta.route}` : node.name,
    endpointKind: meta.endpointKind,
    writes: Boolean(meta.writes),
    path: site?.path ?? node.path ?? null,
    line: site?.line ?? node.startLine ?? null,
  };
}

// ---------------------------------------------------------------------------

/**
 * One sentence, plus the doors it is about.
 *
 * The doors travel with the sentence rather than in a list of their own so that no
 * surface has to guess which named routes belong under which claim. A screen that has
 * room for names prints them underneath; one that does not prints the sentence alone and
 * is still telling the truth.
 */
export interface ChangeNote {
  /** True on its own, with no caveat attached. */
  text: string;
  /** Empty when the sentence is about files and folders rather than doors. */
  doors: DoorChange[];
}

/**
 * The "what changed" sentences, in one place — the same arrangement `authHeadline` uses,
 * and for the same reason. The CLI summary, the exported brief and the overview screen
 * all want to say this, and three surfaces phrasing it themselves is how a repo gets
 * told "nothing changed" on one screen and "3 new doors" on the next.
 */
export interface ChangeReport {
  /**
   * `warn` when a door opened or lost its lock. `muted` when there was nothing to
   * compare against, which is a caveat rather than news.
   */
  tone: 'ok' | 'warn' | 'muted';
  /** The one worth reading first. */
  headline: ChangeNote;
  /** What the headline leaves out, in the order it should be read. */
  lines: ChangeNote[];
}

/**
 * Turns a diff into the few sentences worth printing, or `null` when the atlas predates
 * this feature and genuinely has nothing to say.
 *
 * The first run gets a sentence too. Saying nothing would leave a reader to assume the
 * absence of news is good news, when in fact nobody has looked yet.
 *
 * No sentence returned here ends in a full stop: the command line sets them as lines and
 * the exported brief and the web page set them as sentences, so the punctuation belongs
 * to whichever of them is doing the setting.
 */
export function describeChanges(changes: AtlasChanges | null | undefined): ChangeReport | null {
  if (!changes) return null;

  if (changes.baseline === 'none') {
    return say('muted', 'first run — no earlier atlas to compare against, so nothing here is new and nothing is missing', [
      'the next run will say what changed since this one',
    ]);
  }

  if (changes.baseline === 'incomparable') {
    return say(
      'muted',
      `nothing to compare against — ${changes.because ?? 'the atlas on disk was written under different conditions'}`,
      ['a diff across that gap would be noise rather than news, so the next run is the one that will say what changed'],
    );
  }

  const { doors, total } = changes;

  // Most alarming first, and each claim carrying the doors it is about. Whichever
  // survives to the top becomes the headline, so the ordering here *is* the editorial
  // judgement: a door standing open outranks a door that vanished, which outranks
  // whatever else moved.
  const notes: ChangeNote[] = [];
  if (doors.newOpen.length > 0) {
    const open = doors.newOpen.length;
    notes.push({
      text:
        doors.newTotal === open
          ? `${plural(open, 'new door', 'new doors')} since the last run, with no auth check App Atlas can see`
          : `${plural(doors.newTotal, 'new door', 'new doors')} since the last run — ${open} of them with no auth check App Atlas can see`,
      doors: doors.newOpen,
    });
  }
  if (doors.lostCheck.length > 0) {
    notes.push({
      text: `${plural(doors.lostCheck.length, 'door', 'doors')} that had an auth check last run ${
        doors.lostCheck.length === 1 ? 'has' : 'have'
      } none now`,
      doors: doors.lostCheck,
    });
  }
  if (doors.removed.length > 0) {
    notes.push({
      text: `${plural(doors.removed.length, 'door', 'doors')} that ${
        doors.removed.length === 1 ? 'was' : 'were'
      } here last run ${doors.removed.length === 1 ? 'is' : 'are'} gone`,
      doors: doors.removed,
    });
  }

  const shape = movement(changes);
  if (notes.length === 0) {
    notes.push({
      text:
        total.added === 0 && total.removed === 0 && total.changed === 0
          ? 'nothing changed since the last run'
          : doors.newTotal > 0
            ? // Deliberately not "and something checks them". A new door can also be an
              // unchecked page, or one behind a file App Atlas could not read; both carry
              // a reason, neither is a clean bill of health, and this is the last place
              // in the product to start rounding up.
              `${plural(doors.newTotal, 'new door', 'new doors')} since the last run, and nothing about ${
                doors.newTotal === 1 ? 'it' : 'them'
              } is left unexplained`
            : `${shape || 'a few things moved'} since the last run`,
      doors: [],
    });
  }
  if (shape && !notes[0].text.startsWith(shape)) notes.push({ text: shape, doors: [] });

  return {
    // A vanished door is news; only a door standing open is a warning.
    tone: doors.newOpen.length > 0 || doors.lostCheck.length > 0 ? 'warn' : 'ok',
    headline: notes[0],
    lines: notes.slice(1),
  };
}

/** The two cases with nothing to compare, where no sentence is about any door. */
function say(tone: ChangeReport['tone'], headline: string, lines: string[]): ChangeReport {
  return {
    tone,
    headline: { text: headline, doors: [] },
    lines: lines.map((text) => ({ text, doors: [] })),
  };
}

/** The order a reader cares about, not the order the graph happens to be built in. */
const KIND_NOUNS: [NodeKind, string, string][] = [
  ['endpoint', 'door', 'doors'],
  ['file', 'file', 'files'],
  ['function', 'function', 'functions'],
  ['type', 'type', 'types'],
  ['module', 'folder', 'folders'],
  ['service', 'service', 'services'],
  ['store', 'data store', 'data stores'],
];

/** Enough to convey scale; beyond this the line stops being read at all. */
const MAX_MOVEMENT_PHRASES = 5;

/**
 * "3 new files, 12 files changed, 1 new type" — the ordinary churn, in one line, so the
 * signal above it is not competing with four hundred listed additions.
 *
 * Doors already named above are subtracted rather than counted twice: what is left is
 * the doors nobody outside can knock on, which is a real fact for a library whose whole
 * boundary is its exports, and noise nowhere.
 *
 * The two structural kinds (`app`, `zone`) are left out: they exist once each and their
 * hashes move whenever the file count does, which says nothing anybody wants to read.
 */
function movement(changes: AtlasChanges): string {
  const phrases: string[] = [];
  let dropped = 0;
  for (const [kind, one, many] of KIND_NOUNS) {
    const counts = changes.byKind[kind];
    if (!counts) continue;
    const added = kind === 'endpoint' ? counts.added - changes.doors.newTotal : counts.added;
    const removed = kind === 'endpoint' ? counts.removed - changes.doors.removed.length : counts.removed;
    for (const phrase of [
      added > 0 ? `${added} new ${added === 1 ? one : many}` : '',
      removed > 0 ? `${removed} ${removed === 1 ? one : many} gone` : '',
      counts.changed > 0 ? `${counts.changed} ${counts.changed === 1 ? one : many} changed` : '',
    ]) {
      if (!phrase) continue;
      if (phrases.length < MAX_MOVEMENT_PHRASES) phrases.push(phrase);
      else dropped++;
    }
  }
  if (phrases.length === 0) return '';
  return phrases.join(', ') + (dropped > 0 ? `, and ${dropped} more kinds of change` : '');
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
