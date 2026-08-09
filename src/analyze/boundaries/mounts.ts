/**
 * @fileoverview The address a customer types, assembled from the pieces the code
 * scatters across three files.
 *
 * A FastAPI handler is decorated `@router.get("/{id}")`. Two files away, that router is
 * built with `prefix="/items"`; one file further out it is mounted under
 * `prefix=settings.API_V1_STR`. The real address is `/api/v1/items/{id}`, and no single
 * file contains it. Showing `/{id}` is not merely terse — it is an address that does
 * not answer, given to someone who is about to read it out to a customer.
 *
 * Two rules keep this from becoming guesswork:
 *
 * 1. **A link is followed only when exactly one file answers to it.** Two candidates
 *    means we do not know which, and the same discipline the Python import resolver
 *    already uses applies here.
 * 2. **An unreadable prefix is shown as `…`, never dropped.** `prefix=settings.API_V1_STR`
 *    with the constant out of reach yields `…/items/{id}` — which tells the reader there
 *    is more in front, rather than handing them a shorter address that looks complete.
 */
import type {
  BoundaryFinding,
  EndpointFinding,
  GlobalPrefixFinding,
  GuardFinding,
  PathConstantFinding,
  RouterBuildFinding,
  RouterMountFinding,
} from './types.js';

/** One piece of an address: either the text, or a gap we could not read. */
type Part = { known: string } | { known: null };

const GAP: Part = { known: null };

/** How a gap is written for a reader. */
const ELLIPSIS = '…';

/**
 * Rewrites every endpoint finding whose route is only part of its address.
 *
 * Returns a new array; the findings arriving here may have come from the incremental
 * cache, and a mutation would compose the same prefix twice on the next run.
 */
export function composeRoutePrefixes(findings: BoundaryFinding[]): BoundaryFinding[] {
  const builds: RouterBuildFinding[] = [];
  const mounts: RouterMountFinding[] = [];
  const constants: PathConstantFinding[] = [];
  const globals: GlobalPrefixFinding[] = [];
  for (const finding of findings) {
    if (finding.type === 'router-build') builds.push(finding);
    else if (finding.type === 'router-mount') mounts.push(finding);
    else if (finding.type === 'path-constant') constants.push(finding);
    else if (finding.type === 'global-prefix') globals.push(finding);
  }
  const hasPrefixes = mounts.length > 0 || globals.length > 0 || builds.some((build) => build.hasPrefix);
  const hasCallerPrefixed = findings.some((finding) => finding.type === 'endpoint' && finding.prefixFromCaller);
  if (!hasPrefixes && !hasCallerPrefixed) return findings;

  const chains = new Chains(builds, mounts, constants);
  const everywhere = globalPrefixes(globals);
  return findings.map((finding) => {
    if (finding.type === 'guard') return placeMatchers(finding, chains);
    // A module's `forRoutes('user')` names the address without the prefix the framework
    // puts in front of every route it serves. Same one line of `main.ts`, same answer.
    if (finding.type === 'path-guard') {
      const global = everywhere.get(finding.framework);
      if (!global) return finding;
      return { ...finding, matcher: global.known === null ? '' : render([global], finding.matcher) };
    }
    if (finding.type !== 'endpoint' || finding.route === null) return finding;
    const global = finding.framework ? everywhere.get(finding.framework) : undefined;
    const own = finding.routerVar
      ? chains.prefixFor(routerKey(moduleOf(finding.site.path), finding.routerVar))
      : [];
    if (!global && own.length === 0) {
      // Composition failed, and for most routes that is fine — `r.GET("/api/ping")` on
      // the top-level engine has no prefix because its address is already whole. A
      // route on a *caller-prefixed* router is the other case (#151): the fragment it
      // wrote is not its address, and treating it as one collided `POST ""` from an
      // articles package — mounted behind AuthMiddleware — with the `POST ""` that
      // signs users up, guards pooled across the pair. #153's rule, in Go: an address
      // that could not be read is not an address, and two of them are never one door.
      if (!finding.prefixFromCaller) return finding;
      return unresolvedAddress(finding);
    }
    return applyPrefix(finding, global ? [global, ...own] : own);
  });
}

/**
 * #153's pattern for a door whose prefix lives with a caller nothing connected: keyed
 * on its file and router so strangers never merge, shown with the ellipsis where the
 * prefix would be, and `route: null` so nothing downstream matches a prefix or a
 * webhook shape against a fragment. The handler's name rides along in the label
 * because `POST …` on its own sends the reader searching; the ellipsis is honest and
 * the parenthesis is the way back to the code.
 */
function unresolvedAddress(finding: EndpointFinding): EndpointFinding {
  const method = finding.method ?? 'ANY';
  const tail = finding.route ?? '';
  const handler =
    finding.handlerId?.startsWith('func:') === true
      ? finding.handlerId.slice(finding.handlerId.lastIndexOf('#') + 1)
      : null;
  return {
    ...finding,
    // The handler is part of the key: realworld registers ArticleList on both its
    // public and its authed group, and those are two addresses even when one function
    // answers both — merging them would pool whatever guard either mount carries.
    // A closure has no handler id, so the line stands in for it.
    key: `${method} ${finding.site.path}#${finding.routerVar ?? ''}#${finding.handlerId ?? `L${finding.site.line}`}${tail}`,
    name: `${method} …${tail}${handler ? ` (${handler})` : ''}`,
    route: null,
  };
}

/**
 * Where a check written on a router actually reaches.
 *
 * `admin.use(requireAuth)` produces the pattern `/:path*`, which read literally is the
 * whole application — so a lock on one sub-router was reporting every door in the repo
 * as protected, including the ones deliberately left open. The pattern is relative to
 * the router it was written on, and this is where that router's address is known.
 *
 * Three answers, because there are three situations. A router something mounts gets its
 * mounted address in front of the pattern. A router nothing mounts but that hosts mounts
 * of its own is the application itself, and its pattern was absolute all along. A router
 * that is neither is one we cannot place — and a check we cannot place is dropped, not
 * widened, because the widened version is a claim of protection over doors nobody
 * checked.
 */
function placeMatchers(finding: GuardFinding, chains: Chains): GuardFinding {
  if (!finding.routerVar || finding.scope !== 'matcher') return finding;
  const key = routerKey(moduleOf(finding.guard.path ?? ''), finding.routerVar);
  const where = chains.placeOf(key);
  if (where === null) return { ...finding, matchers: [] };
  if (where.length === 0) return finding;
  // An address with a gap in it cannot say which doors are behind the check.
  if (where.some((part) => part.known === null)) return { ...finding, matchers: [] };
  return {
    ...finding,
    matchers: finding.matchers.map((matcher) => render(where, matcher.replace(/^\//, ''))),
  };
}

/**
 * Framework → the one prefix it applies to everything, when the repo declares one.
 *
 * Two `setGlobalPrefix` calls with different arguments is two apps in one scope, and
 * neither answer would be true of both.
 */
function globalPrefixes(findings: GlobalPrefixFinding[]): Map<string, Part> {
  const byFramework = new Map<string, Set<string>>();
  for (const finding of findings) {
    const values = byFramework.get(finding.framework);
    if (values) values.add(finding.prefix);
    else byFramework.set(finding.framework, new Set([finding.prefix]));
  }
  const out = new Map<string, Part>();
  for (const [framework, values] of byFramework) {
    out.set(framework, values.size === 1 ? { known: [...values][0] } : GAP);
  }
  return out;
}

function applyPrefix(finding: EndpointFinding, parts: Part[]): EndpointFinding {
  const route = render(parts, finding.route as string);
  if (route === finding.route) return finding;
  return {
    ...finding,
    route,
    // The key decides identity in the merge. Without it, a `GET /{id}` in `items.py`
    // and a `GET /{id}` in `users.py` are the same string, and the two doors collapse
    // into one — a repo-wide undercount that only shows up as a number nobody queries.
    key: finding.method ? `${finding.method} ${route}` : route,
    name: finding.method ? `${finding.method} ${route}` : route,
  };
}

/** Joins the pieces, collapsing a run of gaps into one `…`. */
function render(parts: Part[], route: string): string {
  const pieces: string[] = [];
  for (const part of parts) {
    const text = part.known === null ? ELLIPSIS : trimPath(part.known);
    if (!text) continue;
    if (text === ELLIPSIS && pieces[pieces.length - 1] === ELLIPSIS) continue;
    pieces.push(text);
  }
  const tail = trimPath(route);
  const joined = pieces.map((piece) => (piece === ELLIPSIS ? ELLIPSIS : `/${piece}`)).join('');
  if (!joined) return route;
  // `@router.get("/")` under `prefix="/users"` is `/api/v1/users/`, and the framework
  // redirects the slashless spelling to it. The address in the API docs is the one the
  // reader will be asked about, so keep the slash the source asked for.
  const slash = route.endsWith('/') ? '/' : '';
  return `${joined}${tail ? `/${tail}` : ''}${slash}`;
}

/** `/api/v1/` → `api/v1`. Leading and trailing slashes are the caller's job. */
function trimPath(text: string): string {
  return text.replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * A file as another file would import it: no extension, and without the `__init__` or
 * `index` that stands for the directory itself. The same rule holds for Python and for
 * TypeScript, which is why the merge layer can key both languages the same way.
 */
export function moduleOf(relPath: string): string {
  const withoutExt = relPath.replace(/\.(pyi?|go|[cm]?[jt]sx?)$/, '');
  return withoutExt.replace(/(^|\/)(index|__init__)$/, '');
}

/**
 * The directory a file sits in, or `''` for one at the root of the repo.
 *
 * Wanted because not every language's import names a file. A Go import names a package,
 * which is a directory, and every `.go` file in it is that package — so the thing a
 * mount asked for may be the folder rather than any one file inside it.
 */
function dirOf(relPath: string): string {
  const slash = relPath.lastIndexOf('/');
  return slash === -1 ? '' : relPath.slice(0, slash);
}

/**
 * Whether a module path answers to what a mount asked for.
 *
 * The tail rather than the whole, because what a mount writes is relative to wherever
 * the app is started from and nothing in the repo records that: `app/api/routes/items`
 * has to be able to find `backend/app/api/routes/items.py`.
 */
function answersTo(where: string, wanted: string): boolean {
  return where === wanted || where.endsWith(`/${wanted}`);
}

/**
 * How a router is named wherever it is referred to: the file it was built in, as
 * another file would import it, and the variable it was bound to.
 *
 * Exported because the mount graph answers two different questions — what address a
 * route answers at, and what check stands in front of it — and both have to agree about
 * which router is which.
 */
export function routerKey(module: string, varName: string): string {
  return `${module}\0${varName}`;
}

/** Which routers this project builds, indexed the two ways a mount can name one. */
class Builds {
  /** `module\0var` → the call that built it. */
  readonly byKey = new Map<string, RouterBuildFinding>();
  /** Variable name → every router built under it, for tail matching. */
  private readonly byVar = new Map<string, RouterBuildFinding[]>();

  constructor(builds: RouterBuildFinding[]) {
    for (const build of builds) {
      const key = routerKey(moduleOf(build.path), build.varName);
      // Two routers with one name in one file cannot both be right, and picking either
      // would attach somebody's routes to somebody else's prefix.
      if (this.byKey.has(key)) continue;
      this.byKey.set(key, build);
      const list = this.byVar.get(build.varName);
      if (list) list.push(build);
      else this.byVar.set(build.varName, [build]);
    }
  }

  /**
   * The mounted router's own key, or null when the import led nowhere we can see.
   *
   * Asked twice, because a module path can name two different things. Usually it names a
   * file, which is how Python and TypeScript both spell an import, and that is the more
   * precise reading so it is tried first. Only when no file answers is the path read as a
   * *directory* — which is what a Go import always is, `internal/api` standing for every
   * `.go` file in `internal/api/`, none of which the mount can name.
   *
   * Ordering them this way is what keeps the directory reading from loosening anything:
   * a language whose imports name files never reaches it.
   */
  childOf(mount: RouterMountFinding): string | null {
    // A mount with no module names a router built in the mounting file itself.
    if (mount.childModule === null) {
      return mount.childVar === null ? null : routerKey(moduleOf(mount.path), mount.childVar);
    }
    const wanted = mount.childModule;
    // The root directory is spelled `''`, and every file in the repo sits under it. A
    // mount that asked for everything has asked for nothing we can name.
    if (wanted === '') return null;
    return (
      this.only(mount.childVar, (build) => answersTo(moduleOf(build.path), wanted)) ??
      this.only(mount.childVar, (build) => answersTo(dirOf(build.path), wanted))
    );
  }

  /**
   * The single router a mount can only mean, under one reading of the path it named, or
   * null when the answer is not exactly one.
   *
   * The name the mount used is often not the name the router was declared under:
   * `const app = new Hono(); … export const mcpRouter = app` is the ordinary shape, and
   * `export default router` gives no name at all. So when the name finds nothing the file
   * answers for itself — one router in it means one answer, two means we do not know
   * which, and not knowing is reported as not knowing.
   */
  private only(childVar: string | null, matches: (build: RouterBuildFinding) => boolean): string | null {
    const byName = childVar ? (this.byVar.get(childVar) ?? []).filter(matches) : [];
    if (byName.length === 1) return routerKey(moduleOf(byName[0].path), byName[0].varName);

    const inFile = [...this.byKey.values()].filter(matches);
    return inFile.length === 1 ? routerKey(moduleOf(inFile[0].path), inFile[0].varName) : null;
  }
}

/** Child router key → every mount that hangs it under a parent. */
export function mountGraph(
  builds: RouterBuildFinding[],
  mounts: RouterMountFinding[],
): Map<string, RouterMountFinding[]> {
  const index = new Builds(builds);
  const out = new Map<string, RouterMountFinding[]>();
  for (const mount of mounts) {
    const child = index.childOf(mount);
    if (!child) continue;
    const list = out.get(child);
    if (list) list.push(mount);
    else out.set(child, [mount]);
  }
  return out;
}

class Chains {
  private readonly index: Builds;
  /** `module\0var` of the child → the mounts that hang it somewhere. */
  private readonly mountedAt: Map<string, RouterMountFinding[]>;
  /** `module\0var` of every router something is mounted *onto*. */
  private readonly hosts = new Set<string>();
  /** Constant name → the values it was given, repo-wide. */
  private readonly constants = new Map<string, Set<string>>();
  /** `path\0name` → the value that file gave it, which beats the repo-wide answer. */
  private readonly localConstants = new Map<string, string>();
  private readonly memo = new Map<string, Part[]>();

  constructor(builds: RouterBuildFinding[], mounts: RouterMountFinding[], constants: PathConstantFinding[]) {
    this.index = new Builds(builds);
    this.mountedAt = mountGraph(builds, mounts);
    for (const mount of mounts) this.hosts.add(routerKey(moduleOf(mount.path), mount.hostVar));

    for (const constant of constants) {
      const values = this.constants.get(constant.name);
      if (values) values.add(constant.value);
      else this.constants.set(constant.name, new Set([constant.value]));
      const local = `${constant.path}\0${constant.name}`;
      // Two assignments to one name in one file is somebody reassigning; neither
      // spelling is safe to quote, so drop both rather than pick the earlier one.
      this.localConstants.set(local, this.localConstants.has(local) ? '' : constant.value);
    }

  }

  /** Everything in front of a route declared on this router. */
  prefixFor(key: string): Part[] {
    const seen = new Set<string>();
    return this.walk(key, seen);
  }

  /**
   * Where this router sits, or null when it sits nowhere we can see.
   *
   * An empty list means the root: nothing mounts it, but other routers hang off it, so
   * it is the application and addresses written on it are already absolute.
   */
  placeOf(key: string): Part[] | null {
    if (this.mountedAt.has(key)) return this.prefixFor(key);
    return this.hosts.has(key) ? [] : null;
  }

  private walk(key: string, seen: Set<string>): Part[] {
    const done = this.memo.get(key);
    if (done) return done;
    // A router mounted on itself, directly or round a loop, has no address to give.
    if (seen.has(key)) return [];
    seen.add(key);

    const parts = this.chain(key, this.ownPrefix(this.index.byKey.get(key)), seen);
    seen.delete(key);
    this.memo.set(key, parts);
    return parts;
  }

  /** The router's own prefix with every parent in front of it. */
  private chain(key: string, own: Part[], seen: Set<string>): Part[] {
    const mounts = this.mountedAt.get(key) ?? [];
    if (mounts.length === 0) return own;

    const options = mounts.map((mount) => [
      ...this.walk(routerKey(moduleOf(mount.path), mount.hostVar), seen),
      ...this.mountPrefix(mount),
      // Flask's `register_blueprint(bp, url_prefix=…)` does not sit in front of the
      // blueprint's own prefix, it takes its place.
      ...(mount.overridesPrefix && mount.hasPrefix ? [] : own),
    ]);
    const distinct = new Map(options.map((parts) => [signature(parts), parts]));
    if (distinct.size === 1) return options[0];
    // The same routes really do answer at two addresses. Naming one of them would be
    // picking a favourite and calling it the truth, so say only that there is one.
    return [GAP];
  }

  private ownPrefix(build: RouterBuildFinding | undefined): Part[] {
    if (!build || !build.hasPrefix) return [];
    return [this.read(build.prefix ?? null, build.prefixName ?? null, build.path)];
  }

  private mountPrefix(mount: RouterMountFinding): Part[] {
    if (!mount.hasPrefix) return [];
    return [this.read(mount.prefix, mount.prefixName, mount.path)];
  }

  /**
   * A prefix written as a name — `prefix=settings.API_V1_STR`, `prefix=prefix` — looked
   * up among the path-shaped constants the repo declares.
   *
   * The file the prefix was written in gets asked first, because `prefix = "/recipes"`
   * beside the mount that uses it is a local variable, and half a dozen route packages
   * each having their own is normal. Only when the name is not declared here does the
   * repo-wide index answer, and then only if every file agrees on one value.
   */
  private read(literal: string | null, name: string | null, path: string): Part {
    if (literal !== null) return { known: literal };
    if (name === null) return GAP;
    const bare = name.split('.').pop() ?? name;
    const local = this.localConstants.get(`${path}\0${bare}`);
    if (local) return { known: local };
    const values = this.constants.get(bare);
    if (!values || values.size !== 1) return GAP;
    return { known: [...values][0] };
  }
}

/**
 * What two chains have to differ in before they count as disagreeing: the address they
 * produce, not the pieces they were built from. `route('/', routers)` then
 * `route('/mcp', …)` and a bare `route('/mcp', …)` are two spellings of one address.
 */
function signature(parts: Part[]): string {
  return render(parts, '');
}
