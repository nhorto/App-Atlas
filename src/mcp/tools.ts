/**
 * @fileoverview The seven tools an agent can call, over the graph that already exists.
 *
 * Everything here is a query, not an analysis — `model/insights.ts`, `model/graph.ts` and
 * `model/unimported.ts` answer all seven questions already, and this file is the shape
 * those answers take when the reader is a model rather than a screen.
 *
 * The rule that shapes every result: **an agent is even less able than a person to tell a
 * fact from a guess**, and it will repeat whatever it is told to somebody who then acts
 * on it. So each row carries where it was found and how it was known — `certain` when a
 * compiler said so, `likely` when a convention matched, `(ai)` when a model wrote the
 * sentence — and every answer ends with what the analysis could not see. A tool that
 * returns "3 routes are unprotected" with no provenance is one hop away from a customer
 * being told their app is safe.
 *
 * Both halves of a result matter and neither is a summary of the other. `content` is the
 * whole answer as text, because that is what lands in the transcript for a person to read
 * and it is the only field every revision of the protocol has. `structuredContent` is the
 * same facts as data, keyed the way `.app-atlas/atlas.json` keys them, so an agent that
 * reads both never has to learn two vocabularies.
 */
import type { AtlasGraph } from '../model/graph.js';
import { traceError } from '../model/errortrace.js';
import type { PlacedFrame, UnplacedReason } from '../model/errortrace.js';
import { authHeadline } from '../model/exposure.js';
import { buildInsights } from '../model/insights.js';
import type { RouteInsight } from '../model/insights.js';
import { installedPackages } from '../model/packages.js';
import { bundleMaps } from '../model/sourcemap.js';
import { grammarTier } from '../model/tiers.js';
import { findPersonalData } from '../model/personal.js';
import type { AtlasEdge, AtlasNode, CodeSite, EndpointMeta, GuardInfo } from '../model/types.js';
import type { AtlasApp, AtlasSource } from './atlas.js';

/** What one tool call sends back. Mirrors the protocol's `CallToolResult`. */
export interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  /** True when the tool ran but could not answer — the agent sees the reason and can act. */
  isError?: boolean;
}

/** One tool as it appears in `tools/list`. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Enough rows to act on. Past this an agent is paying for a list it will not read. */
const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 500;

/** The env inventory rides on a pseudo-door; it has its own tool and is not a way in. */
const NOT_A_DOOR = new Set(['env']);

const SCOPE_PROPERTY = {
  scope: {
    type: 'string',
    description:
      'In a monorepo, which app to ask about — its name as `app-atlas analyze` reported it. ' +
      'Leave it out in an ordinary repo; leave it out in a monorepo and the first app answers, and says so.',
  },
} as const;

/**
 * The tools, in the order they are worth reaching for.
 *
 * Descriptions are written for a model choosing between them, and each one states what
 * the tool cannot see. A model that knows the analysis is static will not tell somebody
 * their deployed configuration is fine.
 */
export const MCP_TOOLS: ToolDefinition[] = [
  {
    name: 'unguarded_doors',
    description:
      'Every route into this app that has no authentication check, and the ones that are unchecked for a stated ' +
      'reason, counted separately. Answers "which of my doors is nothing guarding". Read from the source: it cannot ' +
      'see deployed configuration, a live database\'s policies, or a check written in a file that would not parse — ' +
      'and it says which of those apply. "Nothing is unguarded" and "there is nothing to guard" are different answers ' +
      'and this tool never collapses them.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SCOPE_PROPERTY,
        includeExplained: {
          type: 'boolean',
          description:
            'Also list the unchecked doors that have a reason — a page the browser renders for anyone, the address ' +
            'people sign in through, or a route behind a file that could not be read. Default false: they are always ' +
            'counted, but listing them is what makes the number people should act on unreadable.',
        },
      },
    },
  },
  {
    name: 'list_doors',
    description:
      'Every way into this app, of every kind: HTTP routes, server actions, webhooks, scheduled jobs, queue workers, ' +
      'realtime channels, CLI entry points and exported names. Each one says what framework convention found it, ' +
      'whether the code behind it writes data, what checks it, and the file and line to look at. Environment ' +
      'variables are not a door and have their own tool.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SCOPE_PROPERTY,
        kind: {
          type: 'string',
          description:
            'Only doors of this kind: http-route, server-action, webhook, cron, queue, realtime, cli, file-read, ' +
            'export, screen.',
        },
        limit: { type: 'number', description: `How many to return. Default ${DEFAULT_LIMIT}, maximum ${MAX_LIMIT}.` },
      },
    },
  },
  {
    name: 'trace_error',
    description:
      'Put a stack trace on the map: paste one and get back which of your files and functions each frame lands in, ' +
      'and which ways into the app can reach the code that failed. Use it when you have an error and do not yet ' +
      'know where it came from. Reads V8/Node, browser, Python, Go, .NET and JVM traces, and ignores whatever else ' +
      'is in the paste. Two limits worth stating to whoever asked: the doors are ones that *can* reach the failing ' +
      'code, found by following references backwards — not a record of the call that actually happened, so when ' +
      'several are listed the trace does not say which one ran. And a frame in a dependency, in a file this ' +
      'analysis never read, or in a minified bundle is reported as unplaced rather than guessed at. When the whole ' +
      'stack is somebody else\'s code it says which of this project\'s files import that library — or, if the ' +
      'library is a transitive one, which dependency of theirs declares it. That is where the package is reached ' +
      'for, not where the failing call was made, and it is worded that way for a reason: do not report it as the cause.',
    inputSchema: {
      type: 'object',
      properties: {
        trace: {
          type: 'string',
          description:
            'The error as it was given to you — the whole paste, including the message line and any log noise ' +
            'around it. Do not tidy it first; the parser skips what it does not recognise.',
        },
        ...SCOPE_PROPERTY,
        limit: { type: 'number', description: `How many doors to return. Default ${DEFAULT_LIMIT}, maximum ${MAX_LIMIT}.` },
      },
      required: ['trace'],
    },
  },
  {
    name: 'what_calls',
    description:
      'Who reaches a function, type, file or door — the callers, the importers and the routes that expose it. Use it ' +
      'before changing or deleting something. Every row carries a confidence, because these edges are resolved by a ' +
      'type checker in some languages and matched by name in others. This is not a sound call graph: a call made ' +
      'through a dynamic lookup or a string is not in it, so an empty answer means "none found", never "none exist".',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description:
            'An atlas node id (`func:src/lib/db.ts#connect`) or a plain name (`connect`). A name that matches more ' +
            'than one thing returns the candidates rather than picking one.',
        },
        ...SCOPE_PROPERTY,
        limit: { type: 'number', description: `How many callers to return. Default ${DEFAULT_LIMIT}, maximum ${MAX_LIMIT}.` },
      },
      required: ['target'],
    },
  },
  {
    name: 'where_is',
    description:
      'Find something by name and get its file, its lines, what contains it, and its description. Descriptions read ' +
      'out of the code\'s own docstrings are marked `docs`; ones a model wrote are marked `ai` and may be wrong. Use ' +
      'this to turn a name a user said into a place in the repo.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A name, part of a name, or part of a path.' },
        ...SCOPE_PROPERTY,
        limit: { type: 'number', description: `How many matches to return. Default 20, maximum ${MAX_LIMIT}.` },
      },
      required: ['query'],
    },
  },
  {
    name: 'unimported_files',
    description:
      'Which files nothing else in this app imports — the abandoned drafts an agent left behind, if there are any. ' +
      'Reports a fact ("nothing here imports it"), never a verdict ("dead code"), and never a deletion instruction: ' +
      'a file loaded from a computed path or looked up by name at run time is invisible to the import graph and ' +
      'always will be. Files a framework runs itself, files a manifest declares as a way in, tests, config and ' +
      'anything behind a door are never listed. Refuses to answer at all — with the reason — when the reference ' +
      'pass was skipped, when the run covered one app inside a bigger repo, or when the project is a library whose ' +
      'callers are outside it.',
    inputSchema: { type: 'object', properties: { ...SCOPE_PROPERTY } },
  },
  {
    name: 'data_stores',
    description:
      'Where this app keeps data: every database, cache, bucket and browser store, the client library it goes ' +
      'through, the tables named in queries, and how much is read versus written. Also reports row-level security ' +
      'per table as the SQL migrations state it — and reports "not stated" as unknown rather than as off, because a ' +
      'table created in a dashboard may be fully protected by policies no migration ever recorded. Flags tables ' +
      'whose column names suggest personal data, matched on the name alone with no value ever read: treat it as a ' +
      'list of places to look, never as a compliance verdict, and never report a table missing from it as clear.',
    inputSchema: { type: 'object', properties: { ...SCOPE_PROPERTY } },
  },
  {
    name: 'env_vars',
    description:
      'Every environment variable this code reads, where it is read, whether the name looks like a credential, and ' +
      'whether it is written down in the project\'s `.env.example`. Variables the hosting platform sets are marked ' +
      'as such rather than counted as forgotten.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SCOPE_PROPERTY,
        undocumentedOnly: {
          type: 'boolean',
          description: 'Only the ones read by the code and written down nowhere. Default false.',
        },
      },
    },
  },
];

/** Whether a tool of this name exists, for the dispatcher to check before calling. */
export function isKnownTool(name: string): boolean {
  return MCP_TOOLS.some((tool) => tool.name === name);
}

/**
 * Runs one tool and returns its result.
 *
 * Never throws for an answerable-but-empty question: "nothing found" is a real answer and
 * is returned as one. `isError` is reserved for the cases where the tool could not look —
 * no analysis on disk, an app that does not exist — because those are the ones where an
 * agent must not read the empty list as a fact about the code.
 */
export function callMcpTool(source: AtlasSource, name: string, args: Record<string, unknown>): ToolResult {
  const found = source.resolve(readString(args, 'scope'));
  if (!found.found) return problem(found.because);

  const { graph, app } = found;
  const apps = source.apps();

  switch (name) {
    case 'unguarded_doors':
      return unguardedDoors(graph, app, apps, readBoolean(args, 'includeExplained'));
    case 'list_doors':
      return listDoors(graph, app, apps, readString(args, 'kind'), readLimit(args, DEFAULT_LIMIT));
    case 'trace_error':
      return traceErrorTool(graph, app, apps, readString(args, 'trace') ?? '', readLimit(args, DEFAULT_LIMIT));
    case 'what_calls':
      return whatCalls(graph, app, apps, readString(args, 'target') ?? '', readLimit(args, DEFAULT_LIMIT));
    case 'where_is':
      return whereIs(graph, app, apps, readString(args, 'query') ?? '', readLimit(args, 20));
    case 'unimported_files':
      return unimportedFiles(graph, app, apps);
    case 'data_stores':
      return dataStores(graph, app, apps);
    case 'env_vars':
      return envVars(graph, app, apps, readBoolean(args, 'undocumentedOnly'));
    default:
      return problem(`No tool called "${name}".`);
  }
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

/**
 * The one question no neighbouring tool answers: which doors is nothing guarding.
 *
 * The two empty answers are kept apart on purpose, because they are opposite facts about
 * a repo and an agent told the wrong one will say the wrong thing to a customer. A
 * library or a data pipeline has no route a stranger can knock on, so there is *nothing
 * to guard* — the right sentence there is not "you are fine", it is "this question does
 * not apply to this project". A web app whose every route has a check has *nothing
 * unguarded*, which is a clean bill of health and is allowed to read like one.
 */
function unguardedDoors(
  graph: AtlasGraph,
  app: AtlasApp,
  apps: AtlasApp[],
  includeExplained: boolean,
): ToolResult {
  const insights = buildInsights(graph);
  const stats = graph.meta.stats;
  const headline = authHeadline(stats);
  const lines: string[] = [];

  // `authHeadline` returns null for exactly one reason: nothing in this project answers a
  // URL. Reusing that instead of testing `routes === 0` here keeps the two surfaces from
  // ever drifting into disagreeing about the same repo.
  if (!headline) {
    const otherDoors = graph
      .nodesOfKind('endpoint')
      .filter((node) => !NOT_A_DOOR.has(endpointMeta(node).endpointKind));
    lines.push(
      'Nothing in this project answers a URL, so there is no door a stranger can knock on and nothing here to guard.',
    );
    if (otherDoors.length > 0) {
      const kinds = [...new Set(otherDoors.map((node) => endpointMeta(node).endpointKind))].sort();
      lines.push(
        `It does have ${otherDoors.length} ${plural(otherDoors.length, 'way', 'ways')} in of other kinds ` +
          `(${kinds.join(', ')}) — call list_doors for those. None of them is reachable from the internet, which ` +
          'is why none is measured for authentication.',
      );
    }
    return answer(lines, provenance(app, apps, graph), {
      ...envelope(app, graph),
      nothingToGuard: true,
      routes: 0,
      unguardedCount: 0,
      unguarded: [],
    });
  }

  const unguarded = insights.auth.routes.filter((route) => route.open?.kind === 'worth-a-look');
  const explained = insights.auth.routes.filter(
    (route) => route.open && route.open.kind !== 'worth-a-look',
  );

  lines.push(`${sentenceCase(headline.headline)}.`);
  for (const caveat of headline.caveats) lines.push(`- ${sentenceCase(caveat)}.`);

  if (unguarded.length > 0) {
    lines.push('');
    lines.push('Nothing checks these, and nothing explains why:');
    for (const route of unguarded) lines.push(`  ${routeLine(route)}`);
  } else {
    lines.push('');
    const routes = `${stats.routes} ${plural(stats.routes, 'route', 'routes')}`;
    lines.push(
      explained.length > 0
        ? `Nothing is unguarded: every one of the ${routes} either has a check, or is unchecked for a reason listed below.`
        : `Nothing is unguarded: every one of the ${routes} has a check.`,
    );
  }

  if (explained.length > 0) {
    lines.push('');
    lines.push('Unchecked with a reason, and therefore not in the count above:');
    const byReason = new Map<string, RouteInsight[]>();
    for (const route of explained) {
      const kind = route.open?.kind ?? 'worth-a-look';
      const list = byReason.get(kind);
      if (list) list.push(route);
      else byReason.set(kind, [route]);
    }
    for (const [kind, routes] of byReason) {
      lines.push(`  ${routes.length} ${reasonPhrase(kind, routes.length)}`);
      if (includeExplained) {
        for (const route of routes) lines.push(`    ${routeLine(route)}`);
      }
    }
    if (!includeExplained) lines.push('  Pass includeExplained to see them listed.');
  }

  if (insights.auth.unread.length > 0) {
    lines.push('');
    lines.push(
      `${insights.auth.unread.length} ${plural(insights.auth.unread.length, 'file', 'files')} could not be parsed at ` +
        'all, so whatever they declare is missing from every number above:',
    );
    for (const file of insights.auth.unread.slice(0, 10)) lines.push(`  ${file.path} — ${file.because}`);
  }

  return answer(lines, provenance(app, apps, graph), {
    ...envelope(app, graph),
    nothingToGuard: false,
    routes: stats.routes,
    unguardedCount: unguarded.length,
    unguarded: unguarded.map(routeFact),
    explained: explained.map(routeFact),
    notCounted: {
      publicPages: insights.auth.routes.filter((route) => route.open?.kind === 'page').length,
      signInDoor: insights.auth.routes.filter((route) => route.open?.kind === 'auth-mount').length,
      behindAnUnreadableFile: insights.auth.unreadableCount,
    },
    checked: insights.auth.protectedCount,
    checkedButNotCertain: insights.auth.likelyCount,
    caveats: headline.caveats,
    unreadableFiles: insights.auth.unread,
  });
}

/** Every way in, whatever shape it takes. */
function listDoors(
  graph: AtlasGraph,
  app: AtlasApp,
  apps: AtlasApp[],
  kind: string | undefined,
  limit: number,
): ToolResult {
  const all = graph
    .nodesOfKind('endpoint')
    .filter((node) => !NOT_A_DOOR.has(endpointMeta(node).endpointKind))
    .filter((node) => !kind || endpointMeta(node).endpointKind === kind);

  const shown = all.slice(0, limit);
  const lines: string[] = [];

  if (all.length === 0) {
    lines.push(
      kind
        ? `No ways in of kind "${kind}" were found in ${app.name}.`
        : `No ways into ${app.name} were found. A library or a script legitimately has none — call where_is to see what it does have.`,
    );
    return answer(lines, provenance(app, apps, graph), { ...envelope(app, graph), total: 0, doors: [] });
  }

  lines.push(`${all.length} ${plural(all.length, 'way', 'ways')} into ${app.name}${kind ? ` of kind "${kind}"` : ''}.`);
  lines.push('');
  for (const node of shown) {
    const meta = endpointMeta(node);
    const parts = [`${meta.endpointKind}  ${doorName(node, meta)}`];
    if (meta.schedule) parts.push(`runs ${meta.schedule}`);
    if (meta.writes) parts.push('writes data');
    parts.push(guardPhrase(meta));
    parts.push(`found by ${meta.framework}`);
    parts.push(siteOf(meta.sites, node));
    lines.push(`  ${parts.filter(Boolean).join('  ·  ')}`);
  }
  if (all.length > shown.length) lines.push(`  …and ${all.length - shown.length} more — raise limit to see them.`);

  return answer(lines, provenance(app, apps, graph), {
    ...envelope(app, graph),
    total: all.length,
    returned: shown.length,
    doors: shown.map((node) => doorFact(node)),
  });
}

/** Who reaches a thing — the question asked before anything is changed or deleted. */
/**
 * A pasted stack trace, joined to the map.
 *
 * Written to be read by something that will repeat it. Two failures are worth more care
 * than the happy path: an agent told "this came in through /checkout" when four doors
 * reach the code will state it as fact, and an agent shown only the frames that matched
 * will treat the ones that did not as absent rather than unread. So every door that can
 * reach the failing code is listed with the chain behind it, and every frame that could
 * not be placed is listed with the reason.
 */
function traceErrorTool(
  graph: AtlasGraph,
  app: AtlasApp,
  apps: AtlasApp[],
  pasted: string,
  limit: number,
): ToolResult {
  if (!pasted.trim()) return problem('trace_error needs a "trace" — paste the error as you received it.');

  const result = traceError(graph, pasted, bundleMaps(graph.meta.root), installedPackages(graph.meta.root));
  const lines: string[] = [];

  if (result.parsedNothing) {
    lines.push(
      'Nothing in that paste looked like a stack frame, so there is no file or line to start from. This tool needs ' +
        'a trace with `file:line` in it — a V8 `at fn (path:1:2)`, a Python `File "path", line 1`, a Go panic, a ' +
        '.NET `in path:line 1` or a JVM `at pkg.Class.method(File.java:1)`. If all you have is a description of ' +
        'the symptom, this is the wrong tool: nothing here can turn prose into a location.',
    );
    return answer(lines, provenance(app, apps, graph), {
      ...envelope(app, graph),
      parsedNothing: true,
      frames: [],
      origin: null,
      doors: [],
    });
  }

  lines.push(`${result.frames.length} ${plural(result.frames.length, 'frame', 'frames')} read from the paste:`);
  for (const found of result.frames) {
    const where = `${found.frame.rawPath}:${found.frame.line}`;
    if (found.nodeId) {
      // On a mapped frame the runtime's name is the minified one, so the name worth
      // quoting back is the one the map kept.
      const printed = found.mappedFrom?.name ?? found.frame.functionName;
      const drift = found.nameDrifted ? `  ·  the trace called this ${printed}, so the two have drifted` : '';
      const mapped = found.mappedFrom ? `  ·  via source map ${found.mappedFrom.mapPath}` : '';
      lines.push(
        `  ${where}  →  ${found.nodeKind} ${found.nodeName}  ·  ${found.path}:${found.sourceLine}${mapped}${drift}`,
      );
    } else {
      lines.push(`  ${where}  →  not placed: ${whyUnplaced(found.reason, found.candidates)}`);
    }
  }
  if (result.needsSourceMap) {
    lines.push(
      'Some of those frames are inside build output that no source map in this project places, so their line ' +
        'numbers are the bundle’s and not any file’s. Do not guess at what they were — the fix is a build that ' +
        'emits source maps beside the bundle, or a `.map` that is as new as the bundle it sits next to.',
    );
  }
  lines.push('');

  if (!result.origin) {
    lines.push(
      'None of those frames is code in this project, so there is no frame here to trace back from. The failure ' +
        'surfaced entirely inside dependencies or the runtime.',
    );
    const into = result.intoDependency;
    if (into && into.importers.length > 0) {
      lines.push('');
      lines.push(
        into.via
          ? `The innermost frame is inside ${into.packageName}, which nothing here imports. ${into.via} declares it ` +
              `as a dependency, and your code does import ${into.via}. These files do — which is where it is reached ` +
              'for, not where the failing call was made. The trace does not say which of them was on the run that broke:'
          : `The innermost frame is inside ${into.packageName}. These files import it — which is where it is reached ` +
              'for, not where the failing call was made. The trace does not say which of them was on the run that broke:',
      );
      for (const importer of into.importers) {
        const doors = importer.doors
          .slice(0, limit)
          .map((reach) => reach.door.route ?? reach.door.name)
          .join(', ');
        const reached = doors ? `  ·  reached by ${doors}` : '  ·  no way in reaches it';
        lines.push(`  ${importer.path}${reached}`);
      }
      const rest = into.total - into.importers.length;
      if (rest > 0) {
        lines.push(
          `  …and ${rest} more ${plural(rest, 'file', 'files')}. The ones above are those the most ways in can ` +
            'reach, which is an ordering and not a ranking of suspects.',
        );
      }
    } else if (into && into.total > 0) {
      lines.push('');
      lines.push(
        `The innermost frame is inside ${into.packageName}, and ${into.total} files here import ` +
          `${into.via ?? 'it'} — too many for this trace to narrow down. Naming a few would be picking, so none ` +
          'are named. Something the whole app depends on is not evidence about any one file.',
      );
    } else if (into) {
      lines.push('');
      lines.push(
        `The innermost frame is inside ${into.packageName}. Nothing here imports it and no dependency of this ` +
          'project declares it, so the trace has left this codebase behind — do not name a file as the cause.',
      );
    }
    return answer(lines, provenance(app, apps, graph), {
      ...envelope(app, graph),
      parsedNothing: false,
      frames: result.frames.map(frameFact),
      origin: null,
      doors: [],
      intoDependency: into
        ? {
            package: into.packageName,
            via: into.via,
            importers: into.importers.map((importer) => ({
              path: importer.path,
              doors: importer.doors.map((reach) => reach.door.route ?? reach.door.name),
            })),
            total: into.total,
          }
        : null,
    });
  }

  lines.push(
    `Deepest frame in your own code: ${result.origin.nodeName} — ${result.origin.path}:${
      result.origin.sourceLine ?? result.origin.frame.line
    }`,
  );
  lines.push('');

  const shown = result.doors.slice(0, limit);
  if (result.doors.length === 0) {
    lines.push(
      'No way into the app reaches that code by any reference this analysis can follow. That is "none found", not ' +
        '"none exists" — code called through a dynamic lookup, a string name or reflection leaves no edge behind.',
    );
  } else {
    lines.push(
      `${result.doors.length} ${plural(result.doors.length, 'way in can', 'ways in can')} reach it. ` +
        'Any of them could be the one that ran; the code does not say which.',
    );
    for (const reach of shown) {
      lines.push(
        `  ${reach.door.method ?? reach.door.endpointKind} ${reach.door.route ?? reach.door.name}  ·  ` +
          `${reach.hops} ${plural(reach.hops, 'hop', 'hops')}  ·  ${reach.confidence}`,
      );
      lines.push(`      ${reach.viaNames.join(' → ')}`);
    }
    if (result.doors.length > shown.length) {
      lines.push(`  …and ${result.doors.length - shown.length} more — raise limit to see them.`);
    }
  }

  const footer = [
    ...provenance(app, apps, graph),
    'The ways in above are ones that *can* reach the failing code, found by following references backwards. They ' +
      'are not a record of the call that happened — a stack trace says where the program was, and these edges say ' +
      'where control can go. Do not report one of several as the cause.',
  ];
  if (result.searchTruncated) {
    footer.push('The backward search hit its ceiling before running out of code, so this list may be short.');
  }

  return answer(lines, footer, {
    ...envelope(app, graph),
    parsedNothing: false,
    languages: result.languages,
    frames: result.frames.map(frameFact),
    origin: frameFact(result.origin),
    doors: shown.map((reach) => ({
      id: reach.door.id,
      name: reach.door.name,
      endpointKind: reach.door.endpointKind,
      method: reach.door.method,
      route: reach.door.route,
      guards: reach.door.guards.length,
      writes: reach.door.writes,
      hops: reach.hops,
      confidence: reach.confidence,
      via: reach.via,
      viaNames: reach.viaNames,
    })),
    doorsFound: result.doors.length,
    searchTruncated: result.searchTruncated,
  });
}

function frameFact(found: PlacedFrame): Record<string, unknown> {
  return {
    raw: found.frame.raw,
    rawPath: found.frame.rawPath,
    line: found.frame.line,
    column: found.frame.column,
    functionName: found.frame.functionName,
    language: found.frame.language,
    nodeId: found.nodeId,
    nodeName: found.nodeName,
    nodeKind: found.nodeKind,
    path: found.path,
    sourceLine: found.sourceLine,
    mappedFrom: found.mappedFrom,
    unplacedReason: found.reason,
    candidates: found.candidates,
    nameDrifted: found.nameDrifted,
  };
}

function whyUnplaced(reason: UnplacedReason | null, candidates: string[]): string {
  switch (reason) {
    case 'dependency':
      return 'a dependency, not your code';
    case 'runtime':
      return 'the runtime itself, not a file in the repo';
    case 'ambiguous':
      return `${candidates.length} files here could be it (${candidates.join(', ')}) — the trace does not say which`;
    case 'minified':
      return 'build output, and no source map in the project places that line';
    default:
      return 'no file in this atlas matches that path — it may be generated, minified, or never analysed';
  }
}

function whatCalls(
  graph: AtlasGraph,
  app: AtlasApp,
  apps: AtlasApp[],
  target: string,
  limit: number,
): ToolResult {
  if (!target.trim()) return problem('what_calls needs a "target" — a node id or a name.');

  const resolved = resolveTarget(graph, target.trim());
  if ('candidates' in resolved) {
    const lines = [
      resolved.candidates.length === 0
        ? `Nothing in ${app.name}'s atlas is called "${target}". Try where_is with part of the name.`
        : `"${target}" matches ${resolved.candidates.length} things here, so this tool will not pick one for you. Call it again with one of these ids:`,
    ];
    for (const node of resolved.candidates) lines.push(`  ${node.id}  ${node.kind}  ${placeOf(node)}`);
    return answer(lines, provenance(app, apps, graph), {
      ...envelope(app, graph),
      resolved: null,
      candidates: resolved.candidates.map(nodeFact),
      callers: [],
    });
  }

  const node = resolved.node;
  const incoming = graph.edgesTo(node.id);
  const shown = incoming.slice().sort((a, b) => b.weight - a.weight).slice(0, limit);
  const lines: string[] = [];

  lines.push(`${node.kind} ${node.name} — ${placeOf(node)}`);
  lines.push('');
  if (incoming.length === 0) {
    lines.push(
      'Nothing in this atlas reaches it. That means none was found, not that none exists: a call made through a ' +
        'dynamic lookup, a string, or reflection leaves no edge to find.',
    );
  } else {
    lines.push(`${incoming.length} ${plural(incoming.length, 'thing reaches', 'things reach')} it:`);
    for (const edge of shown) {
      const other = graph.getNodeById(edge.fromId);
      if (!other) continue;
      lines.push(
        `  ${edge.kind}  ${other.kind} ${other.name}  ·  ${edge.confidence}  ·  ${placeOf(other)}`,
      );
    }
    if (incoming.length > shown.length) {
      lines.push(`  …and ${incoming.length - shown.length} more — raise limit to see them.`);
    }
  }

  return answer(
    lines,
    [
      ...provenance(app, apps, graph),
      'A `certain` edge was resolved by the language\'s own checker. A `likely` one was matched by name through the ' +
        'import that introduced it. Neither is a sound call graph — see the tool description.',
    ],
    {
      ...envelope(app, graph),
      resolved: nodeFact(node),
      total: incoming.length,
      returned: shown.length,
      callers: shown
        .map((edge) => callerFact(edge, graph.getNodeById(edge.fromId)))
        .filter((fact): fact is Record<string, unknown> => fact !== null),
    },
  );
}

/** Turn a name somebody said into a place in the repo. */
function whereIs(
  graph: AtlasGraph,
  app: AtlasApp,
  apps: AtlasApp[],
  query: string,
  limit: number,
): ToolResult {
  if (!query.trim()) return problem('where_is needs a "query".');

  const matches = graph.search(query.trim(), limit);
  const lines: string[] = [];
  if (matches.length === 0) {
    lines.push(`Nothing in ${app.name} matches "${query}".`);
    return answer(lines, provenance(app, apps, graph), { ...envelope(app, graph), matches: [] });
  }

  lines.push(`${matches.length} ${plural(matches.length, 'match', 'matches')} for "${query}" in ${app.name}.`);
  lines.push('');
  for (const node of matches) {
    lines.push(`  ${node.kind}  ${node.name}  ·  ${placeOf(node)}  ·  ${node.id}`);
    if (node.summary) lines.push(`      ${oneLine(node.summary)}${node.summarySource === 'ai' ? ' (ai)' : ''}`);
  }

  return answer(lines, provenance(app, apps, graph), {
    ...envelope(app, graph),
    matches: matches.map(nodeFact),
  });
}

/**
 * The files nothing else imports — and, more often than not, the refusal to say.
 *
 * An agent is the reader most likely to act on this list destructively and the reader
 * best placed to check it first, so the answer is written to make checking the obvious
 * next move: every row is a path, and the sentence around it says what the import graph
 * does not contain rather than what the code is. `isError` stays false when the question
 * is refused — the tool worked, and the reason it gives is the useful part.
 */
function unimportedFiles(graph: AtlasGraph, app: AtlasApp, apps: AtlasApp[]): ToolResult {
  const view = graph.getOverview().unimported;
  const lines: string[] = [];

  if (!view.answered) {
    lines.push(`Not reported for ${app.name}: ${view.because}.`);
    return answer(lines, provenance(app, apps, graph), {
      ...envelope(app, graph),
      answered: false,
      because: view.because,
      headline: null,
      files: [],
    });
  }

  if (view.total === 0) {
    lines.push(`In ${app.name}, ${view.headline}. Nothing is unaccounted for.`);
  } else {
    lines.push(
      `${sentenceCase(view.headline ?? '')}, out of ${view.considered} weighed up. No import, no door, ` +
        'no manifest entry and no framework convention accounts for them.',
    );
    lines.push('');
    for (const file of view.files) {
      const names = file.exportedNames.length > 0 ? `  ·  exports ${file.exportedNames.join(', ')}` : '';
      lines.push(`  ${file.path}  ·  ${file.loc} lines  ·  ${file.zone}${names}`);
    }
    if (view.total > view.files.length) lines.push(`  ...and ${view.total - view.files.length} more`);
  }

  lines.push('');
  for (const caveat of view.caveats) lines.push(`- ${sentenceCase(caveat)}.`);

  return answer(lines, provenance(app, apps, graph), {
    ...envelope(app, graph),
    answered: true,
    because: null,
    headline: view.headline,
    considered: view.considered,
    total: view.total,
    files: view.files,
    caveats: view.caveats,
  });
}

/** Where the data lives, and what the migrations say guards it. */
function dataStores(graph: AtlasGraph, app: AtlasApp, apps: AtlasApp[]): ToolResult {
  const insights = buildInsights(graph);
  const lines: string[] = [];

  if (insights.stores.length === 0 && insights.tables.total === 0) {
    lines.push(`No data store was found in ${app.name}. An app that keeps nothing is a real answer.`);
    return answer(lines, provenance(app, apps, graph), { ...envelope(app, graph), stores: [], tables: [] });
  }

  if (insights.stores.length > 0) {
    lines.push(`${insights.stores.length} data ${plural(insights.stores.length, 'store', 'stores')}:`);
    for (const store of insights.stores) {
      const tables = store.tables.length > 0 ? `  ·  tables: ${store.tables.join(', ')}` : '';
      lines.push(
        `  ${store.name}  ·  ${store.storeKind} via ${store.client}  ·  ` +
          `${store.reads} ${plural(store.reads, 'read', 'reads')}, ${store.writes} ${plural(store.writes, 'write', 'writes')}${tables}`,
      );
    }
  }

  if (insights.tables.total > 0) {
    lines.push('');
    lines.push(
      `${insights.tables.total} ${plural(insights.tables.total, 'table', 'tables')}, and what protects each one's rows:`,
    );
    for (const table of insights.tables.list) {
      lines.push(`  ${table.name}  ·  ${rlsPhrase(table.rls, table.declared)}${table.path ? `  ·  ${table.path}${table.line ? `:${table.line}` : ''}` : ''}`);
    }
    if (insights.tables.unknown > 0) {
      lines.push('');
      lines.push(
        `${insights.tables.unknown} of those ${plural(insights.tables.unknown, 'tables has', 'tables have')} nothing ` +
          'said about row security in anything this analysis read. That is unknown, not off: a table created in a ' +
          'dashboard can be fully protected by policies that were never written into this repo.',
      );
    }
  }

  // Column names that look like personal data (#48). An agent will relay whatever it
  // reads here as though it were checked, so the method and both of its failure
  // directions are stated in the same breath as the finding, not in a footnote.
  const personal = findPersonalData(graph.allNodes(), graph.allEdges());
  if (personal.tables.length > 0) {
    lines.push('');
    lines.push(
      `${personal.tables.length} of those ${plural(personal.tables.length, 'tables has', 'tables have')} column ` +
        'names suggesting personal data. This is a match on names — no value was read, and it is not a ' +
        'compliance answer. A table missing from this list has not been cleared, only failed to match a name.',
    );
    for (const table of personal.tables) {
      const direct = table.columns.filter((column) => column.strength === 'direct').map((column) => column.column);
      const ambiguous = table.columns.filter((column) => column.strength === 'ambiguous').map((column) => column.column);
      const parts = [
        direct.length > 0 ? direct.join(', ') : '',
        ambiguous.length > 0 ? `ambiguous: ${ambiguous.join(', ')}` : '',
      ].filter(Boolean);
      const doors = table.doors.length > 0 ? `  ·  reached by ${table.doors.map((door) => door.name).join(', ')}` : '';
      lines.push(`  ${table.name}  ·  ${parts.join('  ·  ')}${doors}`);
    }
  }

  return answer(lines, provenance(app, apps, graph), {
    ...envelope(app, graph),
    stores: insights.stores.map((store) => ({ ...store, provenance: 'static' })),
    tables: insights.tables.list.map((table) => ({ ...table, provenance: 'static' })),
    personalData: personal.tables.map((table) => ({
      table: table.name,
      columns: table.columns,
      reachedBy: table.doors.map((door) => door.name),
      basis: 'column-name match, no values read',
      provenance: 'static',
    })),
    tableCounts: {
      total: insights.tables.total,
      rowSecurityOff: insights.tables.unprotected,
      rowSecurityOnWithNoPolicy: insights.tables.locked,
      notStatedInAnyMigration: insights.tables.unknown,
    },
  });
}

/** Every environment variable the code reads, and whether anyone wrote it down. */
function envVars(graph: AtlasGraph, app: AtlasApp, apps: AtlasApp[], undocumentedOnly: boolean): ToolResult {
  const { env } = buildInsights(graph);
  const shown = undocumentedOnly ? env.undocumented : env.vars;
  const lines: string[] = [];

  if (env.total === 0) {
    lines.push(`${app.name} reads no environment variables.`);
    return answer(lines, provenance(app, apps, graph), { ...envelope(app, graph), total: 0, vars: [] });
  }

  lines.push(
    `${env.total} environment ${plural(env.total, 'variable', 'variables')} are read by this code. ` +
      `${env.undocumented.length} of them ${plural(env.undocumented.length, 'is', 'are')} written down nowhere` +
      `${env.exampleFile ? ` (checked against ${env.exampleFile})` : ' (this project has no .env.example)'}.`,
  );
  lines.push('');
  for (const variable of shown) {
    const notes = [
      variable.secret ? 'looks like a credential' : '',
      variable.platform ? 'set by the hosting platform' : variable.documented ? 'written down' : 'written down nowhere',
    ].filter(Boolean);
    lines.push(`  ${variable.name}  ·  ${notes.join(', ')}  ·  ${siteOf(variable.sites, null)}`);
  }

  return answer(lines, provenance(app, apps, graph), {
    ...envelope(app, graph),
    exampleFile: env.exampleFile,
    total: env.total,
    undocumentedCount: env.undocumented.length,
    vars: shown.map((variable) => ({
      name: variable.name,
      documented: variable.documented,
      secret: variable.secret,
      platform: variable.platform,
      sites: variable.sites.map(siteFact),
      provenance: 'static',
    })),
  });
}

// ---------------------------------------------------------------------------
// Provenance — the part that must reach the agent
// ---------------------------------------------------------------------------

/**
 * The lines every answer ends with: which app answered, when it was analysed, how much
 * its facts are worth, and how to make them current.
 *
 * Repeated on every call rather than stated once at startup, because a model reads the
 * result it is looking at and not the handshake it saw an hour ago. The staleness line is
 * the one that earns its tokens: an atlas from before the agent's last three edits will
 * answer confidently and wrongly, and nothing else in the transcript says so.
 */
function provenance(app: AtlasApp, apps: AtlasApp[], graph: AtlasGraph): string[] {
  const lines: string[] = [];
  lines.push(
    `Source: the atlas of "${app.name}" in ${app.dir}, analysed ${graph.meta.generatedAt} by App Atlas ` +
      `v${graph.meta.toolVersion}. Facts above are read from the source code; sentences marked (ai) were written by ` +
      'a model and may be wrong. Re-run `app-atlas analyze` after the code changes — this server reads the last ' +
      'analysis and never runs one.',
  );

  const tier = grammarTier(graph.allNodes());
  if (tier) lines.push(tier.sentence);

  if (apps.length > 1) {
    const others = apps.filter((other) => other.dir !== app.dir).map((other) => other.id || other.name);
    lines.push(
      `This project holds ${apps.length} apps and this answer is only about "${app.name}". The others are ` +
        `${others.join(', ')} — pass "scope" to ask about one of them.`,
    );
  }
  return lines;
}

/** The keys every structured result carries, so provenance survives the text being skipped. */
function envelope(app: AtlasApp, graph: AtlasGraph): Record<string, unknown> {
  return {
    app: app.name,
    scope: app.id,
    root: app.dir,
    analyzedAt: graph.meta.generatedAt,
    toolVersion: graph.meta.toolVersion,
  };
}

// ---------------------------------------------------------------------------
// Turning atlas records into facts an agent can read
// ---------------------------------------------------------------------------

function routeFact(route: RouteInsight): Record<string, unknown> {
  return {
    id: route.id,
    name: route.name,
    method: route.method,
    route: route.route,
    kind: route.endpointKind,
    framework: route.framework,
    writes: route.writes,
    protection: route.protection,
    open: route.open,
    guards: route.guards.map(guardFact),
    sites: route.sites.map(siteFact),
    provenance: 'static',
  };
}

function doorFact(node: AtlasNode): Record<string, unknown> {
  const meta = endpointMeta(node);
  return {
    id: node.id,
    name: doorName(node, meta),
    kind: meta.endpointKind,
    method: meta.method,
    route: meta.route,
    framework: meta.framework,
    writes: meta.writes,
    schedule: meta.schedule ?? null,
    verified: meta.verified ?? null,
    guards: (meta.guards ?? []).map(guardFact),
    open: meta.open ?? null,
    sites: (meta.sites ?? []).map(siteFact),
    provenance: node.provenance,
  };
}

/** A guard keeps its confidence here exactly as the badge keeps it on screen. */
function guardFact(guard: GuardInfo): Record<string, unknown> {
  return {
    name: guard.name,
    provider: guard.provider,
    how: guard.how,
    path: guard.path,
    line: guard.line,
    confidence: guard.confidence,
  };
}

function siteFact(site: CodeSite): Record<string, unknown> {
  return { path: site.path, line: site.line, snippet: site.snippet ?? null };
}

function nodeFact(node: AtlasNode): Record<string, unknown> {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    path: node.path,
    startLine: node.startLine,
    endLine: node.endLine,
    language: node.language,
    zone: node.zone,
    summary: node.summary,
    /** `docs` was read out of the code; `ai` was generated; null means nobody described it. */
    summarySource: node.summarySource,
    provenance: node.provenance,
  };
}

function callerFact(edge: AtlasEdge, other: AtlasNode | undefined): Record<string, unknown> | null {
  if (!other) return null;
  return {
    edgeKind: edge.kind,
    confidence: edge.confidence,
    provenance: edge.provenance,
    weight: edge.weight,
    caller: nodeFact(other),
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function answer(lines: string[], footer: string[], structured: Record<string, unknown>): ToolResult {
  const text = [...lines, '', ...footer].join('\n');
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

/**
 * A tool that could not look, as opposed to one that looked and found nothing.
 *
 * `isError` matters more here than it looks: an agent handed an empty list will report
 * that the app has no unguarded doors, which is the exact false reassurance this project
 * exists to avoid. The two states have to be told apart by the client, not by a sentence.
 */
function problem(because: string): ToolResult {
  return { content: [{ type: 'text', text: because }], isError: true };
}

/** "POST /api/orders — writes data — src/app/api/orders/route.ts:12" */
function routeLine(route: RouteInsight): string {
  // A door whose detector never established a verb is printed without one. Filling the
  // gap with "ANY" would be inventing a fact about which methods the address answers,
  // which is the kind of small confident addition nobody would think to check.
  const parts = [route.route ? [route.method, route.route].filter(Boolean).join(' ') : route.name];
  if (route.writes) parts.push('writes data');
  if (route.open?.because) parts.push(route.open.because);
  parts.push(siteOf(route.sites, null));
  return parts.filter(Boolean).join('  ·  ');
}

function doorName(node: AtlasNode, meta: EndpointMeta): string {
  if (!meta.route) return node.name;
  return meta.method ? `${meta.method} ${meta.route}` : meta.route;
}

/** What is checking a door, said with the confidence the analyzer actually had. */
function guardPhrase(meta: EndpointMeta): string {
  const guards = meta.guards ?? [];
  if (guards.length === 0) {
    return meta.open?.because ? `nothing checks it — ${meta.open.because}` : 'nothing checks it';
  }
  const named = guards.map((guard) => `${guard.provider || guard.name}${guard.confidence === 'certain' ? '' : '?'}`);
  const sure = guards.some((guard) => guard.confidence === 'certain');
  return `${sure ? 'checked by' : 'likely checked by'} ${named.join(', ')}`;
}

function reasonPhrase(kind: string, count: number): string {
  switch (kind) {
    case 'page':
      return `${plural(count, 'page', 'pages')} the browser renders for whoever asks`;
    case 'auth-mount':
      return `${plural(count, 'address', 'addresses')} people sign in through, which cannot require a session`;
    case 'unreadable':
      return `behind a file App Atlas could not read — unknown, not open`;
    case 'generated':
      return `${plural(count, 'entry', 'entries')} a build wrote — the routes they serve are graded one by one`;
    case 'unlinked':
      return `${plural(count, 'route', 'routes')} declared in a routing table App Atlas has not followed to a handler`;
    case 'declared-public':
      return `${plural(count, 'door', 'doors')} the code declares open on purpose`;
    default:
      return kind;
  }
}

/** What the migrations said, including the case where they said nothing. */
function rlsPhrase(
  rls: { enabled: boolean; policyCount: number; commands: string[] } | null,
  declared: boolean,
): string {
  if (!rls) {
    return declared
      ? 'row security not stated in any migration we read — unknown, not off'
      : 'named in queries only, with no schema to read — columns and row security both unknown';
  }
  if (!rls.enabled) return 'row security off';
  if (rls.policyCount === 0) return 'row security on with no policy — every request is denied';
  return `row security on, ${rls.policyCount} ${plural(rls.policyCount, 'policy', 'policies')} (${rls.commands.join(', ')})`;
}

/** The first place a finding was seen — where somebody should go and look. */
function siteOf(sites: CodeSite[] | undefined, node: AtlasNode | null): string {
  const site = sites?.[0];
  if (site?.path) return `${site.path}:${site.line}`;
  return node ? placeOf(node) : 'no file recorded';
}

function placeOf(node: AtlasNode): string {
  if (!node.path) return 'no file recorded';
  return node.startLine ? `${node.path}:${node.startLine}` : node.path;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Finds the one thing the caller meant, or refuses.
 *
 * An id is unambiguous and is taken as given. A bare name is not: `handler` can be six
 * functions, and answering about whichever sorted first would give an agent a confident
 * answer about the wrong file. Several matches come back as several matches.
 */
function resolveTarget(graph: AtlasGraph, target: string): { node: AtlasNode } | { candidates: AtlasNode[] } {
  const byId = graph.getNodeById(target);
  if (byId) return { node: byId };

  const exact = graph.allNodes().filter((node) => node.name === target);
  if (exact.length === 1) return { node: exact[0] };
  if (exact.length > 1) return { candidates: exact.slice(0, 20) };

  return { candidates: graph.search(target, 10) };
}

function endpointMeta(node: AtlasNode): EndpointMeta {
  return node.meta as unknown as EndpointMeta;
}

function readString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readBoolean(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true;
}

function readLimit(args: Record<string, unknown>, fallback: number): number {
  const value = args.limit;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), MAX_LIMIT);
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A description on one line, without losing the rest of it.
 *
 * The screen keeps only the first line of a multi-paragraph docstring because it has a
 * card to fit. A reader who wants more clicks. An agent cannot click, and the sentence it
 * needs is as often the second one as the first, so the whole thing is flattened and only
 * then capped.
 */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 300 ? `${flat.slice(0, 299)}…` : flat;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}
