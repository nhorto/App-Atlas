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
 *   - `auth-mount`— the auth provider is mounted at this address, or this door's own
 *                   handler calls the provider's sign-in routine. Both are "the door
 *                   people sign in through", which is what every screen calls this.
 *   - `unreadable`— a file this route imports could not be read, so "no check found"
 *                   is a statement about the analyzer, not about the code.
 */
import { backbonePhrase, unreadBackbone } from './coverage.js';
import { makeFileId } from './types.js';
import type {
  AtlasEdge,
  AtlasNode,
  AtlasStats,
  EndpointMeta,
  OpenVerdict,
  ServiceMeta,
  SignInCall,
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
  /** Where the app's own data lives, for telling a sign-in apart from a sign-in *and*. */
  const stores = new Set<string>();
  let signInDoors = 0;

  for (const node of nodes) {
    switch (node.kind) {
      case 'endpoint': {
        const meta = node.meta as unknown as EndpointMeta;
        if (isAuthRelevant(meta) && meta.guards.length === 0) open.push(node);
        if (meta.signInCall) signInDoors++;
        break;
      }
      case 'store':
        stores.add(node.id);
        break;
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
  const dataWriters = signInDoors > 0 ? doorsWritingData(edges, stores) : null;

  for (const node of open) {
    const meta = node.meta as unknown as EndpointMeta;
    const files = filesBehind(node, meta);

    // Which program this is, first — above even the ignorance rule, and the one place
    // that ordering is right to invert. "A check may live in the file we could not read"
    // is a statement about how much of *the application* we saw, and this door is not
    // the application: it is a route a test stood up for the length of a run. Nothing
    // reassuring is being said about the app by saying so, which is the whole of what
    // the rule below exists to protect (#247).
    //
    // It also has to come first for the arithmetic to hold. `testRoutes` leaves the
    // denominator whatever verdict a door gets, so a test route classified as
    // `unreadable` would be subtracted once and reported once more.
    if (meta.declaredInTest) {
      verdicts.set(node.id, {
        kind: 'in-test',
        because: 'declared by the test suite — nobody outside a test run can knock on this',
      });
      continue;
    }

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

    // The same door in its other shape (#40): not an address the provider is mounted
    // on, but a handler that calls the provider's own sign-in. A server action that
    // signs you in cannot require you to be signed in already, and on a Supabase repo
    // that mistake was five of eleven findings — enough to teach a reader that the
    // eleven are noise.
    //
    // Qualified the same way the page rule below is, and for the same reason: a handler
    // that signs somebody in *and* writes the app's own data is doing more than opening
    // the door, so it stays in the list that gets read. Deliberately asked of the graph
    // rather than of `meta.writes`, which is no help here — every server action is
    // stamped `writes: true` the moment it is found, on the grounds that it might, so
    // that flag would switch this rule off for exactly the doors it is about.
    if (meta.signInCall && !dataWriters?.has(node.id)) {
      verdicts.set(node.id, { kind: 'auth-mount', because: becauseSignIn(meta.signInCall) });
      continue;
    }

    // A catch-all a build generated (#123). The adapter re-serves routes this atlas has
    // already found and graded one at a time, so counting it says "a route nobody
    // protects" about an app whose routes are all accounted for — and there is nowhere
    // to put a check in a file nobody wrote. Kept on the map, taken out of the count.
    if (meta.generatedEntry) {
      verdicts.set(node.id, {
        kind: 'generated',
        because: 'a build wrote this entry — the routes it serves are on the map already, checked one by one',
      });
      continue;
    }

    // A route named in a routing table whose handler was never located (#139). The URL
    // is served — that is why the door stays — but every check the handler carries is
    // written where this reader has not been, so counting it would report our own blind
    // spot as the application's. Sits below `generated` because a build artifact is a
    // stronger and more specific claim than "not followed yet".
    if (meta.handlerUnlinked) {
      verdicts.set(node.id, {
        kind: 'unlinked',
        because:
          meta.handlerUnlinkedWhy ??
          'declared in a routing table — App Atlas has not followed it to the code that answers it',
      });
      continue;
    }

    // Somebody wrote down that this door is open (#152). A NestJS guard whose whole body
    // is `return true` is the framework's `[AllowAnonymous]`, spelled as a guard because
    // Nest gives it no other spelling — and the intent is as explicit as a comment.
    //
    // Above the page rule and below the ignorance rules, in the same order the rest of
    // this function reads: a stated decision outranks a guess about what a door is for,
    // and nothing outranks admitting we could not see.
    // Something named like a check ran here and let everybody through (#237). The door
    // is as open as one with nothing in front of it, which is why this sits with the
    // reasons that stay in the count rather than the ones that leave it — the value is
    // in naming what a reader will otherwise find and mistake for a lock, exactly as
    // this tool did.
    if (meta.identityOnly) {
      verdicts.set(node.id, {
        kind: 'identity-only',
        because: `${meta.identityOnly} runs in front of this door and refuses nobody — it reads who is calling and hands them on`,
      });
      continue;
    }

    if (meta.declaredPublic) {
      verdicts.set(node.id, {
        kind: 'declared-public',
        because: 'a guard that permits everything is written on it — this door is open on purpose',
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

/**
 * Why no route got an auth verdict, when none did.
 *
 * Kept apart from the sentence that reports it so the two reasons cannot be blurred into
 * a single reassuring-sounding one. "Not followed to a handler" is App Atlas describing
 * its own reach (#139); "declared by the test suite" is App Atlas describing the
 * repository (#247), and a repo whose every door is scaffolding is being told something
 * true and useful rather than being apologised to.
 */
function nothingJudged(routes: number, unlinked: number, inTest: number): string {
  const subject = routes === 1 ? 'the one route is' : `all ${routes} routes are`;
  const unfollowed =
    'declared in a routing table App Atlas has not followed to its handler — ' +
    'no auth verdict was reached for any of them';
  if (inTest === 0) return `${subject} ${unfollowed}`;
  if (unlinked === 0) {
    return `${subject} declared by the test suite — nothing here answers a URL in a deployed app`;
  }
  return (
    `no route was judged: ${inTest} ${inTest === 1 ? 'is' : 'are'} declared by the test suite, and ` +
    `${unlinked} ${unlinked === 1 ? 'is' : 'are'} in a routing table App Atlas has not followed to a handler`
  );
}

/** Counts by reason, for headlines that have to be honest in one sentence. */
export interface OpenTally {
  worthALook: number;
  page: number;
  authMount: number;
  unreadable: number;
  /** Catch-alls a build wrote, whose real routes are counted individually (#123). */
  generated: number;
  /** Routes whose handler was named in a routing table but never followed (#139). */
  unlinked: number;
  /** Routes the code declares open on purpose — Nest's answer to `[AllowAnonymous]` (#152). */
  declaredPublic: number;
  /** Routes a test file declared, which no deployed app answers at (#247). */
  inTest: number;
  /** Routes fronted by a middleware that reads identity and refuses nobody (#237). */
  identityOnly: number;
}

export function tallyOpenDoors(verdicts: Iterable<OpenVerdict>): OpenTally {
  const tally: OpenTally = {
    worthALook: 0,
    page: 0,
    authMount: 0,
    unreadable: 0,
    generated: 0,
    unlinked: 0,
    declaredPublic: 0,
    inTest: 0,
    identityOnly: 0,
  };
  for (const verdict of verdicts) {
    if (verdict.kind === 'page') tally.page++;
    else if (verdict.kind === 'auth-mount') tally.authMount++;
    else if (verdict.kind === 'unreadable') tally.unreadable++;
    else if (verdict.kind === 'generated') tally.generated++;
    else if (verdict.kind === 'unlinked') tally.unlinked++;
    else if (verdict.kind === 'declared-public') tally.declaredPublic++;
    else if (verdict.kind === 'in-test') tally.inTest++;
    else if (verdict.kind === 'identity-only') tally.identityOnly++;
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
  /**
   * The headline already carries the matched-not-proven hedge, and the last caveat says
   * the same thing at length.
   *
   * Two surfaces want different halves of that. A screen with room prints the headline
   * and every caveat under it, where the long form earns its place by saying what to do
   * about it. A walkthrough card runs them together into one paragraph, and there the
   * pair reads as a stutter: "…though 20 of those were matched rather than proven. 20 of
   * the checks were matched by a pattern rather than proven — worth reading those doors
   * yourself." Found on a real app, where both sentences were true and one was enough.
   */
  hedged: boolean;
}

/**
 * The auth sentence, in one place.
 *
 * The CLI summary, the per-app line, the walkthrough and the exported brief all used
 * to phrase this themselves, which is how a repo ends up being told "every route
 * checks who is calling" on one screen and "21 routes unprotected" on the next. One
 * function, four surfaces, no way for them to disagree.
 *
 * Returns `null` when there is nothing to say because nothing answers a URL — and
 * nothing went unread, which is the difference between an app with no doors and an app
 * whose doors were never looked at.
 */
export function authHeadline(stats: AtlasStats): AuthHeadline | null {
  const { routes } = stats;
  const open = stats.unprotectedRoutes;
  const unknown = stats.unreadableRoutes ?? 0;
  const public_ = stats.publicRoutes ?? 0;
  // Test files excluded (#132). The hedge means "a check may live in there", and a check
  // for a production route does not live in a test fixture — bat's unparseable
  // syntax-highlighting asset was softening a claim it could never have changed. A hedge
  // that fires when nothing is actually uncertain teaches a reader to skip hedges, which
  // is #116's failure arriving from the other side. The file is still reported and still
  // counted in `unreadFiles`; only this sentence stops leaning on it.
  const unread = Math.max(0, (stats.unreadFiles ?? 0) - (stats.unreadTestFiles ?? 0));

  // Zero doors reads as good news, and it is only good news when the analyzer could see.
  // A Python project mapped on a machine whose interpreter never answered has zero doors
  // for the same reason a blindfolded person sees no traffic (issue #58), and "nothing
  // here answers a URL" is then the most confidently wrong sentence this tool can print.
  //
  // The strongest form of not-seeing is a whole language (#171): huginn's routes are in
  // 469 Ruby files nothing here parses, and the auth question was never asked of the
  // application at all — which outranks every other reading of "zero routes".
  const backbone = unreadBackbone(stats.unreadLanguages, stats.files);
  if (routes === 0) {
    if (backbone) {
      return {
        tone: 'warn',
        headline:
          `most of this repository is ${backbonePhrase(backbone)}, which App Atlas cannot read — ` +
          'whether anything answers a URL was never in view',
        caveats: [],
        hedged: false,
      };
    }
    if (unread === 0) return null;
    return {
      tone: 'warn',
      headline:
        `no routes were found — but App Atlas could not read ${unread} ${unread === 1 ? 'file' : 'files'}, ` +
        'so this is not the same as saying there are none',
      caveats: [],
      hedged: false,
    };
  }

  // A route whose handler was never followed has not been judged, so it cannot sit in
  // the denominator of a sentence about how many were (#139). netbox declares all 84 of
  // its routes as `path('x/', SomeView.as_view())`; with them counted, the same sentence
  // read "84 of 84 have no auth check" before the set-aside and "every one of the 84 has
  // an auth check" after it. Both were the tool describing its own reach as the app's.
  const unlinked = stats.unlinkedRoutes ?? 0;
  // And a route the suite declared was never the application's to begin with, so it
  // cannot sit in that denominator either (#247). Sails reads "29 of 30 routes have no
  // auth check" and every one of the 29 is `GET /res_sending_back_a_boolean/1`, stood up
  // inside a `.test.js` file — a true sentence about a program nobody deploys, and the
  // whole of what its only security screen showed. The set-aside is the one #132 already
  // made for a file we could not read; the doors were simply left out of it.
  const inTest = stats.testRoutes ?? 0;
  const assessed = Math.max(0, routes - unlinked - inTest);

  let headline: string;
  let mentionedPublic = false;
  if (assessed === 0) {
    // Nothing was judged at all. The number of doors is still a real finding, and it is
    // the only one this sentence is entitled to make — but *why* nothing was judged now
    // has two answers, and they are not interchangeable. One is a failure of this
    // reader's reach; the other is a fact about the repository. Sails is entirely the
    // second, and telling its owner we could not follow their routes would be the tool
    // confessing to a failure it did not have.
    return {
      tone: 'warn',
      headline: nothingJudged(routes, unlinked, inTest),
      caveats: [],
      hedged: false,
    };
  }
  if (open > 0) {
    headline =
      assessed === 1
        ? 'the one route has no auth check App Atlas can see'
        : `${open} of ${assessed} routes have no auth check App Atlas can see`;
  } else if (unknown > 0) {
    headline = `nothing is left unexplained, but ${unknown} of the ${assessed} routes lean on a file App Atlas could not read`;
  } else if (public_ > 0) {
    headline = `every one of the ${assessed} routes is checked, or open on purpose`;
    mentionedPublic = true;
  } else {
    headline =
      assessed === 1 ? 'the one route has an auth check' : `every one of the ${assessed} routes has an auth check`;
  }

  // A clean sweep is the one sentence people repeat in a meeting, and it must not read
  // greener than the evidence under it. Every card carries `likely · Clerk` rather than
  // rounding up to "protected" (M2); dropping that grade here broke the same promise in
  // the most quotable place on the page. On a real Expo app, 20 of 21 doors were behind
  // RLS policies read out of migrations — real evidence, honestly graded `likely` — and
  // the headline told its owner the app was fully locked (#116).
  //
  // The hedge is only ever added to a headline that had nothing else to say. A number
  // of unprotected doors is the more urgent fact and already carries "App Atlas can
  // see"; two hedges in one sentence is a sentence nobody finishes.
  const likelyOnly = stats.likelyOnlyRoutes ?? 0;
  const clean = open === 0 && unknown === 0 && unlinked === 0;
  const hedged = clean && likelyOnly > 0;
  if (hedged) {
    headline +=
      likelyOnly === assessed - public_
        ? assessed - public_ === 1
          ? ' — matched, not proven'
          : ' — all matched, none proven'
        : `, though ${likelyOnly} of those were matched rather than proven`;
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
  if (unlinked > 0) {
    caveats.push(
      `${unlinked} more ${unlinked === 1 ? 'is' : 'are'} declared in a routing table App Atlas has not followed to ` +
        `${unlinked === 1 ? 'its handler' : 'their handlers'}; ${unlinked === 1 ? 'it is' : 'they are'} ` +
        'in no number above, protected or not',
    );
  }
  // Said out loud, not quietly deducted. A set-aside a reader cannot see is a number
  // they have no way to disagree with, and this one rests on a file path — the weakest
  // evidence in the tool, and the one most worth showing your working for (#247).
  if (inTest > 0) {
    caveats.push(
      `${inTest} more ${inTest === 1 ? 'is' : 'are'} declared by the test suite rather than by the app; ` +
        `${inTest === 1 ? 'it is' : 'they are'} in no number above`,
    );
  }
  if (unread > 0) {
    caveats.push(
      `App Atlas could not read ${unread} ${unread === 1 ? 'file' : 'files'}; whatever they declare is missing from every number here`,
    );
  }
  // Routes were found AND most of the repository is in a language nothing here reads —
  // a Rails app with a JS sprinkle. The routes above are real; the denominator is not
  // the application's (#171).
  if (backbone) {
    caveats.push(
      `most of this repository is ${backbonePhrase(backbone)}, which App Atlas cannot read — ` +
        'the routes above are only the ones written in languages it can',
    );
  }
  if (hedged) {
    caveats.push(
      likelyOnly === assessed - public_
        ? 'every check was matched by a pattern rather than proven — open the doors and read what guards them'
        : `${likelyOnly} of the checks were matched by a pattern rather than proven — worth reading those doors yourself`,
    );
  }

  return {
    tone: open > 0 || unknown > 0 || unlinked > 0 || backbone !== null ? 'warn' : 'ok',
    headline,
    caveats,
    hedged,
  };
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

/**
 * Doors whose own handler was seen writing to somewhere the app keeps data.
 *
 * Two hops, both of them facts the analyzer already recorded: `writes-to` says which
 * function wrote, `exposed-by` says which door that function answers. Only stores
 * count. A sign-out handler that posts to the auth provider it is signing you out of
 * has not done anything beyond signing you out, and counting that as "and writes data"
 * would disqualify the very doors this is meant to let through.
 */
function doorsWritingData(edges: AtlasEdge[], stores: Set<string>): Set<string> {
  const doors = new Set<string>();
  if (stores.size === 0) return doors;

  const writers = new Set<string>();
  for (const edge of edges) {
    if (edge.kind === 'writes-to' && stores.has(edge.toId)) writers.add(edge.fromId);
  }
  if (writers.size === 0) return doors;

  for (const edge of edges) {
    if (edge.kind === 'exposed-by' && writers.has(edge.toId)) doors.add(edge.fromId);
  }
  return doors;
}

/**
 * The sentence a non-programmer is shown for a sign-in door.
 *
 * Its first half is a fact they can check in ten seconds — open the file, find that
 * call — and its second half says only what the call is for. Signing out gets its own
 * wording because "reached before you have a session" would simply be untrue of it, and
 * a sentence that is nearly right is how a reader stops believing the rest of them.
 */
function becauseSignIn(call: SignInCall): string {
  const why =
    call.what === 'sign-out'
      ? 'which ends a session rather than checking for one'
      : 'which people reach before they have a session';
  return `calls ${call.call} — ${call.provider}'s own ${call.what} routine, ${why}`;
}
