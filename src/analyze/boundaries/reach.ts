/**
 * @fileoverview One hop out from the handler.
 *
 * A detector sees one file, and inside that file it sees only what is written
 * literally. Real code does not oblige. The check that protects a route is usually a
 * helper — `verifyCurrentUserHasAccessToPost(...)` — and the check itself lives a file
 * away; the Stripe client a handler charges a card with is built and exported by
 * `lib/stripe.ts`. Stopping at the first hop produces the two worst outputs this tool
 * has: "nobody is checking who called" about the best-protected route in the repo, and
 * "3 companies" for an app that pays out through a fourth.
 *
 * Both are answerable from facts we already computed. `references` edges record who
 * mentions whom, resolved by the compiler; walking them backwards from a check reaches
 * every handler that could run it. Import specifiers resolve a wrapper module back to
 * the package it re-exports.
 *
 * What comes out of here is evidence, not proof — a handler that mentions a guard
 * might call it down a branch that never runs — so every guard found this way is
 * badged `likely` and carries the name of the helper it came through, which is also
 * the thing a reader needs in order to check our work.
 */
import type { AtlasEdge, GuardInfo } from '../../model/types.js';
import { serviceForPackage } from './catalog.js';
import { sendsData } from './outbound.js';
import type {
  BoundaryFinding,
  ClientExportFinding,
  GuardFinding,
  ServiceFinding,
  WrapperCallFinding,
} from './types.js';

/**
 * How far a guard may travel from the check to the handler. Three covers the usual
 * `handler → requireOwner → requireUser → getServerSession`; beyond that "this
 * function can reach a check" stops being a claim about protection.
 */
const MAX_HOPS = 3;

/**
 * A guard sitting in a heavily-referenced function would otherwise walk the whole
 * project. Hitting this cap means the answer would have been "almost everything",
 * which is not a useful thing to tell anyone.
 */
const MAX_REACHED = 400;

export interface ReachedGuard {
  guard: GuardInfo;
  /** The chain from the caller down to the function holding the check. */
  via: string[];
}

/**
 * Atlas node id → the guards that node can reach, and how.
 *
 * Built by walking `references` edges backwards from each check, so the cost is one
 * bounded walk per guard rather than a search per endpoint.
 */
export function reachableGuards(
  guards: GuardFinding[],
  references: AtlasEdge[],
  nodeNames: Map<string, string>,
): Map<string, ReachedGuard[]> {
  const reached = new Map<string, ReachedGuard[]>();
  if (references.length === 0) return reached;

  const callers = new Map<string, string[]>();
  for (const edge of references) {
    const list = callers.get(edge.toId);
    if (list) list.push(edge.fromId);
    else callers.set(edge.toId, [edge.fromId]);
  }

  const label = (id: string) => nodeNames.get(id) ?? id;

  for (const finding of guards) {
    if (finding.scope !== 'node' || !finding.nodeId) continue;

    // `trail` holds, for each node, the chain of names between it and the check.
    const trail = new Map<string, string[]>([[finding.nodeId, [label(finding.nodeId)]]]);
    const seen = new Set<string>([finding.nodeId]);
    let frontier = [finding.nodeId];

    for (let hop = 0; hop < MAX_HOPS && frontier.length > 0 && seen.size < MAX_REACHED; hop++) {
      const next: string[] = [];
      for (const id of frontier) {
        const via = trail.get(id) ?? [];
        for (const caller of callers.get(id) ?? []) {
          if (seen.has(caller)) continue;
          seen.add(caller);
          if (seen.size > MAX_REACHED) break;
          trail.set(caller, [label(caller), ...via]);
          next.push(caller);

          const list = reached.get(caller);
          const entry: ReachedGuard = { guard: finding.guard, via };
          if (list) list.push(entry);
          else reached.set(caller, [entry]);
        }
      }
      frontier = next;
    }
  }

  return reached;
}

/**
 * How a hop-found guard should read on screen: the helper the handler actually calls,
 * then what that helper checks with. Naming only the innermost call would leave the
 * reader looking for a `getServerSession` that is nowhere in their route file.
 */
export function guardThroughHops(reached: ReachedGuard): GuardInfo {
  return {
    ...reached.guard,
    name: [...reached.via, reached.guard.name].join(' → '),
    // Never `certain`. The reference graph proves the handler mentions the helper,
    // not that every path through the handler runs it.
    confidence: 'likely',
  };
}

// ---------------------------------------------------------------------------
// Wrapper modules
// ---------------------------------------------------------------------------

/**
 * `import { stripe } from "@/lib/stripe"` then `stripe.checkout.sessions.create(...)`.
 *
 * The detector that saw the call could not know what `stripe` is, and the detector
 * that saw `new Stripe(...)` could not know anyone calls it. Each left a note; this
 * pairs them up, once, when every file has been read.
 */
export function servicesThroughWrappers(findings: BoundaryFinding[]): ServiceFinding[] {
  const exports = findings.filter((f): f is ClientExportFinding => f.type === 'client-export');
  if (exports.length === 0) return [];
  const calls = findings.filter((f): f is WrapperCallFinding => f.type === 'wrapper-call');
  if (calls.length === 0) return [];

  const out: ServiceFinding[] = [];
  for (const call of calls) {
    const wanted = resolveSpecifier(call.module, call.site.path);
    if (!wanted) continue;

    const match = exports.find(
      (client) => client.exportName === call.exportName && pathsAgree(client.site.path, wanted),
    );
    if (!match) continue;

    const service = serviceForPackage(match.package);
    if (!service) continue;

    out.push({
      type: 'service',
      name: service.name,
      category: service.category,
      package: match.package,
      host: null,
      external: true,
      writes: sendsData(call.dotted, service.category),
      site: call.site,
    });
  }
  return out;
}

/**
 * The module a specifier points at, as a path with no extension.
 *
 * Relative specifiers resolve exactly. Path aliases (`@/lib/stripe`, `~/server/db`)
 * are configured in a tsconfig we do not read, so they resolve to a *suffix* — which
 * is what `pathsAgree` then matches on. Anything else is a package, and a package is
 * not a wrapper.
 */
function resolveSpecifier(specifier: string, fromPath: string): string | null {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const parts = fromPath.split('/').slice(0, -1);
    for (const segment of specifier.split('/')) {
      if (segment === '.' || segment === '') continue;
      if (segment === '..') parts.pop();
      else parts.push(segment);
    }
    return stripExtension(parts.join('/'));
  }
  if (specifier.startsWith('@/') || specifier.startsWith('~/')) return stripExtension(specifier.slice(2));
  if (specifier.startsWith('#')) return stripExtension(specifier.slice(1));
  return null;
}

function stripExtension(path: string): string {
  return path.replace(/\.(m|c)?[jt]sx?$/, '').replace(/\/index$/, '');
}

/** True when the file that exports the client is the file the specifier meant. */
function pathsAgree(exportPath: string, wanted: string): boolean {
  const normalized = stripExtension(exportPath);
  return normalized === wanted || normalized.endsWith(`/${wanted}`);
}
