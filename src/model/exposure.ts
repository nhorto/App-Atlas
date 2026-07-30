/**
 * @fileoverview Why a door with no visible check is that way (issues #24 and #36).
 *
 * "12 routes have no auth check" is a true sentence and a nearly useless one when
 * eight of the twelve are marketing pages and one is the door people log in through.
 * A reader who opens the first two, finds them obviously fine, and stops reading never
 * reaches the tenth — the one that actually mattered. A number that trains people to
 * ignore it is worse than no number.
 *
 * The other half of the same problem: a file the analyzer could not parse contributes
 * no guards, so every route that leaned on it reports as wide open. That is not a
 * cautious answer, it is a confident wrong one, and it is exactly the failure this
 * product cannot afford — rounding a protection claim *down* costs a reader's trust
 * as surely as rounding it up costs their security.
 *
 * So the unchecked doors are split by *why*, and split is the operative word: every
 * door stays on the screen carrying the fact that explains it, and the headline counts
 * only the ones nothing explains. Nothing is hidden, and no reason here is a guess
 * about intent — each one is a fact already in the graph:
 *
 *   - `page`      — the framework's own conventions say a browser renders this.
 *   - `auth-mount`— the app's auth provider is mounted at this address.
 *   - `unreadable`— a file this route imports could not be read, so "no check found"
 *                   is a statement about the analyzer, not about the code.
 */
import { makeFileId } from './types.js';
import type {
  AtlasEdge,
  AtlasNode,
  AtlasStats,
  EndpointMeta,
  OpenVerdict,
  ServiceMeta,
} from './types.js';

export type { OpenKind, OpenVerdict } from './types.js';

/** Doors a stranger on the internet can knock on. Crons and queues are not. */
const AUTH_RELEVANT = new Set(['http-route', 'server-action', 'realtime']);

/**
 * Auth coverage is measured over the doors a stranger can knock on. A cron job or a
 * queue worker is not reachable from the internet, so counting it as "unprotected"
 * would inflate the number that matters and teach people to ignore it.
 *
 * A webhook is the one kind that answers *both* ways. When something in the file
 * verifies the sender's signature, that signature is the lock, and a door whose lock is
 * a different shape does not belong in a count of session checks. But a route is also
 * *called* a webhook on the strength of the word in its address, and there the
 * promotion was quietly deleting a door from the only screen that exists to find open
 * doors: `/api/webhooks/x` with nothing verifying anything is a door anyone can post to,
 * and it was leaving the count without ever being reported once.
 *
 * So the exemption is the signature, and only the signature. mealie's `/webhooks/…`
 * routes turn out to be ordinary CRUD over webhook *subscriptions* — they take a
 * session like everything else, and they belong in the count like everything else.
 */
export function isAuthRelevant(meta: EndpointMeta): boolean {
  if (meta.endpointKind === 'webhook') return !meta.verified;
  return AUTH_RELEVANT.has(meta.endpointKind);
}

const WORTH_A_LOOK: OpenVerdict = { kind: 'worth-a-look', because: null };

/**
 * Classifies every unchecked door in the atlas. Guarded doors are absent from the
 * result — this answers "why is nothing checking it", not "is it safe".
 *
 * Takes nodes and edges rather than an `AtlasGraph` because the analyzer computes its
 * headline counts before a graph exists, and two definitions of the same number that
 * can drift apart are worse than one definition passed around.
 */
export function classifyOpenDoors(nodes: AtlasNode[], edges: AtlasEdge[]): Map<string, OpenVerdict> {
  const verdicts = new Map<string, OpenVerdict>();

  const open: AtlasNode[] = [];
  const authServices = new Map<string, string>();
  const unreadable = new Map<string, string>();
  /** Files that import an auth package directly — the fact the mount rule is about. */
  const authFiles = new Map<string, string>();

  for (const node of nodes) {
    switch (node.kind) {
      case 'endpoint': {
        const meta = node.meta as unknown as EndpointMeta;
        if (isAuthRelevant(meta) && meta.guards.length === 0) open.push(node);
        break;
      }
      case 'service':
        if ((node.meta as unknown as ServiceMeta).category === 'auth') authServices.set(node.id, node.name);
        break;
      case 'file': {
        if (node.meta.unread) unreadable.set(node.id, node.path ?? node.name);
        // Read from the file's own stamped provider rather than from a service box,
        // because the two answer different questions. `next-auth` runs inside the app
        // and is not a company anybody sends data to (#30), so it has no service box —
        // but it is still exactly what makes a wildcard route the sign-in door.
        const provider = node.meta.authPackage;
        if (typeof provider === 'string' && provider) authFiles.set(node.id, provider);
        break;
      }
      default:
        break;
    }
  }

  if (open.length === 0) return verdicts;

  // Only build the lookups the doors we have actually need. On a repo with nothing
  // unreadable and no auth package, both loops below are skipped entirely.
  const importsOf = unreadable.size > 0 ? edgesByKind(edges, 'imports') : null;
  const authMounts =
    authServices.size > 0 || authFiles.size > 0 ? authMountFiles(edges, authServices, authFiles) : null;

  for (const node of open) {
    const meta = node.meta as unknown as EndpointMeta;
    const files = filesBehind(node, meta);

    // Ignorance first. An unreadable file is the one explanation that must never be
    // masked by a reassuring one, because it is the only one that admits we may be
    // wrong about the rest.
    const blind = importsOf ? firstUnreadImport(files, importsOf, unreadable) : null;
    if (blind) {
      verdicts.set(node.id, {
        kind: 'unreadable',
        because: `imports ${blind}, which App Atlas could not read — a check may live in there`,
      });
      continue;
    }

    const provider = authMounts && isCatchAll(meta.route) ? providerMountedIn(files, authMounts) : null;
    if (provider) {
      verdicts.set(node.id, {
        kind: 'auth-mount',
        because: `${provider} is mounted here — this is the door people sign in through`,
      });
      continue;
    }

    // A page that writes data is not the harmless marketing page this rule is about,
    // so it keeps its place in the list that gets read.
    if (meta.method === 'PAGE' && !meta.writes) {
      verdicts.set(node.id, {
        kind: 'page',
        because: 'a page rather than an API route — the browser renders it for whoever asks',
      });
      continue;
    }

    verdicts.set(node.id, WORTH_A_LOOK);
  }

  return verdicts;
}

/** Counts by reason, for headlines that have to be honest in one sentence. */
export interface OpenTally {
  worthALook: number;
  page: number;
  authMount: number;
  unreadable: number;
}

export function tallyOpenDoors(verdicts: Iterable<OpenVerdict>): OpenTally {
  const tally: OpenTally = { worthALook: 0, page: 0, authMount: 0, unreadable: 0 };
  for (const verdict of verdicts) {
    if (verdict.kind === 'page') tally.page++;
    else if (verdict.kind === 'auth-mount') tally.authMount++;
    else if (verdict.kind === 'unreadable') tally.unreadable++;
    else tally.worthALook++;
  }
  return tally;
}

export interface AuthHeadline {
  /** `warn` when something is either open or unknown. Both deserve the reader's eye. */
  tone: 'ok' | 'warn';
  /** One sentence that is true on its own, with no caveat attached. */
  headline: string;
  /** What the headline leaves out, in the order it should be read. */
  caveats: string[];
}

/**
 * The auth sentence, in one place.
 *
 * The CLI summary, the per-app line, the walkthrough and the exported brief all used
 * to phrase this themselves, which is how a repo ends up being told "every route
 * checks who is calling" on one screen and "21 routes unprotected" on the next. One
 * function, four surfaces, no way for them to disagree.
 *
 * Returns `null` when there is nothing to say because nothing answers a URL.
 */
export function authHeadline(stats: AtlasStats): AuthHeadline | null {
  const { routes } = stats;
  if (routes === 0) return null;

  const open = stats.unprotectedRoutes;
  const unknown = stats.unreadableRoutes ?? 0;
  const public_ = stats.publicRoutes ?? 0;
  const unread = stats.unreadFiles ?? 0;

  let headline: string;
  let mentionedPublic = false;
  if (open > 0) {
    headline =
      routes === 1
        ? 'the one route has no auth check App Atlas can see'
        : `${open} of ${routes} routes have no auth check App Atlas can see`;
  } else if (unknown > 0) {
    headline = `nothing is left unexplained, but ${unknown} of the ${routes} routes lean on a file App Atlas could not read`;
  } else if (public_ > 0) {
    headline = `every one of the ${routes} routes is checked, or open on purpose`;
    mentionedPublic = true;
  } else {
    headline =
      routes === 1 ? 'the one route has an auth check' : `every one of the ${routes} routes has an auth check`;
  }

  const caveats: string[] = [];
  if (open > 0 && unknown > 0) {
    caveats.push(
      `${unknown} more lean on a file App Atlas could not read — the check may well be in there`,
    );
  }
  if (public_ > 0 && !mentionedPublic) {
    caveats.push(`${public_} more are pages or the door people sign in through, open on purpose`);
  }
  if (unread > 0) {
    caveats.push(
      `App Atlas could not read ${unread} ${unread === 1 ? 'file' : 'files'}; whatever they declare is missing from every number here`,
    );
  }

  return { tone: open > 0 || unknown > 0 ? 'warn' : 'ok', headline, caveats };
}

/** Files that could not be parsed, so the reader can see what the map is missing. */
export function unreadableFiles(nodes: AtlasNode[]): { path: string; because: string }[] {
  const list: { path: string; because: string }[] = [];
  for (const node of nodes) {
    if (node.kind !== 'file' || !node.meta.unread) continue;
    list.push({ path: node.path ?? node.name, because: String(node.meta.unread) });
  }
  return list.sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------

/**
 * Every file this door's code was found in. Usually one, but a route registered in one
 * file and handled in another has two, and either of them could be the one that
 * imports something unreadable.
 */
function filesBehind(node: AtlasNode, meta: EndpointMeta): string[] {
  const paths = new Set<string>();
  if (node.path) paths.add(node.path);
  for (const site of meta.sites) if (site.path) paths.add(site.path);
  return [...paths].map(makeFileId);
}

function edgesByKind(edges: AtlasEdge[], kind: AtlasEdge['kind']): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind !== kind) continue;
    const list = map.get(edge.fromId);
    if (list) list.push(edge.toId);
    else map.set(edge.fromId, [edge.toId]);
  }
  return map;
}

/**
 * One hop, deliberately. Two hops would let a single unreadable utility somewhere deep
 * in a large repo excuse every door in it, which trades one dishonest headline for
 * another. A file this route imports directly is a claim we can put in front of a
 * reader and have them check in ten seconds.
 */
function firstUnreadImport(
  files: string[],
  importsOf: Map<string, string[]>,
  unreadable: Map<string, string>,
): string | null {
  for (const fileId of files) {
    if (unreadable.has(fileId)) return unreadable.get(fileId)!;
    for (const imported of importsOf.get(fileId) ?? []) {
      const path = unreadable.get(imported);
      if (path) return path;
    }
  }
  return null;
}

/** File id → the name of the auth provider whose package that file pulls in. */
function authMountFiles(
  edges: AtlasEdge[],
  authServices: Map<string, string>,
  authFiles: Map<string, string>,
): Map<string, string> {
  const mounts = new Map<string, string>(authFiles);
  for (const edge of edges) {
    const provider = authServices.get(edge.toId);
    if (!provider || !edge.fromId.startsWith('file:')) continue;
    mounts.set(edge.fromId, provider);
  }
  return mounts;
}

function providerMountedIn(files: string[], mounts: Map<string, string>): string | null {
  for (const fileId of files) {
    const provider = mounts.get(fileId);
    if (provider) return provider;
  }
  return null;
}

/**
 * Auth providers mount themselves on a wildcard so one handler can answer sign-in,
 * callback and sign-out. Requiring the wildcard *as well as* the provider's package is
 * what keeps this from excusing an ordinary route that merely happens to ask who is
 * calling — that route is one we want in the list.
 */
function isCatchAll(route: string | null): boolean {
  return route !== null && route.includes('*');
}
