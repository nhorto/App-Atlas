/**
 * @fileoverview The boundary pass — one walk of a file, every detector watching.
 *
 * SPEC.md section 5.3 lists the doors an app can have. Each detector here knows one
 * family of conventions and reports what it recognises; this module gives them a
 * shared view of the file (what it imported, what its local names are bound to) and
 * runs them all in a single traversal so the cost stays one pass, not ten.
 *
 * Nothing in here invents a boundary. If a detector cannot resolve a route path or a
 * table name it says so, and the UI shows the fact it does have.
 */
import { Node, SyntaxKind } from 'ts-morph';
import type { SourceFile } from 'ts-morph';
import { authDetector, functionRefusalDetector, middlewareDetector, wiredGuardDetector } from './auth.js';
import { argAt, dottedName, isBareSpecifier, literalString, packageRoot, snippetOf } from './ast.js';
import { storeDetector } from './data.js';
import { envDetector } from './env.js';
import {
  refusalDetector,
  remixRoutesDetector,
  svelteHooksDetector,
  svelteRoutesDetector,
} from './fileroutes.js';
import {
  edgeFunctionDetector,
  expoRoutesDetector,
  nextRoutesDetector,
  nodeRoutesDetector,
  recordedRouteDetector,
  routeHelperDetector,
  strapiRoutesDetector,
  trpcDetector,
} from './http.js';
import { jobsDetector } from './jobs.js';
import { outboundDetector } from './outbound.js';
import type {
  BoundaryDetector,
  BoundaryFinding,
  DetectorContext,
  ImportBinding,
  LocalBinding,
} from './types.js';
import type { ProjectInfo, SourceFileRef } from '../project.js';
import type { ProjectSignals } from '../signals.js';

export type { BoundaryFinding, DetectorContext } from './types.js';

/** Order is irrelevant to correctness — every detector sees every node. */
const DETECTORS: BoundaryDetector[] = [
  nextRoutesDetector,
  expoRoutesDetector,
  svelteRoutesDetector,
  svelteHooksDetector,
  remixRoutesDetector,
  refusalDetector,
  nodeRoutesDetector,
  routeHelperDetector,
  recordedRouteDetector,
  strapiRoutesDetector,
  trpcDetector,
  edgeFunctionDetector,
  jobsDetector,
  storeDetector,
  outboundDetector,
  authDetector,
  middlewareDetector,
  wiredGuardDetector,
  functionRefusalDetector,
  envDetector,
];

export interface BoundaryInput {
  ref: SourceFileRef;
  sf: SourceFile;
  fileId: string;
  project: ProjectInfo;
  signals: ProjectSignals;
  /** Maps a syntax node to the atlas node that contains it. */
  enclosing(node: Node): string;
}

export function detectBoundaries(input: BoundaryInput): BoundaryFinding[] {
  const findings: BoundaryFinding[] = [];
  const imports = buildImports(input.sf);
  const packages = new Set<string>();
  for (const binding of imports.values()) {
    if (binding.external) packages.add(binding.module);
  }
  for (const specifier of unboundRequires(input.sf)) packages.add(specifier);

  const ctx: DetectorContext = {
    ref: input.ref,
    sf: input.sf,
    fileId: input.fileId,
    project: input.project,
    signals: input.signals,
    imports,
    packages,
    locals: buildLocals(input.sf, imports),
    enclosing: input.enclosing,
    site: (node, snippet) => ({
      path: input.ref.relPath,
      line: node.getStartLineNumber(),
      nodeId: input.enclosing(node),
      snippet: snippet ?? snippetOf(node),
    }),
    emit: (finding) => findings.push(finding),
  };

  const active = DETECTORS.filter((detector) => detector.enabled(ctx));
  for (const detector of active) detector.fileScan?.(ctx);

  const visitors = active.filter((detector) => typeof detector.visit === 'function');
  if (visitors.length > 0) {
    input.sf.forEachDescendant((node) => {
      for (const detector of visitors) detector.visit?.(node, ctx);
    });
  }

  return findings;
}

/**
 * Local name → where it came from. Covers ESM imports and `require`, which is still
 * how a lot of Express and script code is written.
 */
function buildImports(sf: SourceFile): Map<string, ImportBinding> {
  const imports = new Map<string, ImportBinding>();
  // Read off the project rather than threaded in: the ts-morph project is built from the
  // repo's tsconfig, so it already holds the answer, and every caller of this would
  // otherwise have to carry it (#274).
  const aliases = pathAliasMatchers(sf.getProject().getCompilerOptions());

  const add = (local: string, specifier: string, imported: string) => {
    const external = isBareSpecifier(specifier) && !isPathAlias(specifier, aliases);
    imports.set(local, {
      local,
      module: external ? packageRoot(specifier) : specifier,
      imported,
      external,
    });
  };

  for (const decl of sf.getImportDeclarations()) {
    const specifier = decl.getModuleSpecifierValue();
    const def = decl.getDefaultImport();
    if (def) add(def.getText(), specifier, 'default');
    const ns = decl.getNamespaceImport();
    if (ns) add(ns.getText(), specifier, '*');
    for (const named of decl.getNamedImports()) {
      add(named.getAliasNode()?.getText() ?? named.getName(), specifier, named.getName());
    }
  }

  for (const decl of sf.getVariableDeclarations()) {
    const init = decl.getInitializer();
    if (!init || !Node.isCallExpression(init)) continue;
    if (init.getExpression().getText() !== 'require') continue;
    const specifier = literalString(argAt(init, 0));
    if (!specifier) continue;
    const name = decl.getNameNode();
    if (Node.isIdentifier(name)) {
      add(name.getText(), specifier, 'default');
    } else if (Node.isObjectBindingPattern(name)) {
      for (const element of name.getElements()) {
        add(element.getName(), specifier, element.getPropertyNameNode()?.getText() ?? element.getName());
      }
    }
  }

  return imports;
}

/**
 * Local name → the call that produced it, so `const prisma = new PrismaClient()` can
 * be recognised later as the database client rather than an ordinary object.
 */
function buildLocals(sf: SourceFile, imports: Map<string, ImportBinding>): Map<string, LocalBinding> {
  const locals = new Map<string, LocalBinding>();
  /** Names declared twice in one file with two different callees — see below. */
  const ambiguous = new Set<string>();

  // Every declaration, not only the top-level ones. `sf.getVariableDeclarations()` stops
  // at the file scope, and the ordinary way to write an Express app is to build the
  // router *inside* a factory:
  //
  //   module.exports = function setupAdminApp() {
  //       const adminApp = express('admin');
  //
  // Ghost is written this way throughout, so no router in it was ever registered, so no
  // mount could ever find one, so no prefix was ever applied to the 261 routes that hang
  // off them (#204). Reading only the file scope made the dominant CommonJS shape
  // invisible.
  for (const decl of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const name = decl.getNameNode();
    if (!Node.isIdentifier(name)) continue;

    let init: Node | undefined = decl.getInitializer();
    while (
      init &&
      (Node.isAwaitExpression(init) ||
        Node.isParenthesizedExpression(init) ||
        Node.isAsExpression(init) ||
        Node.isNonNullExpression(init))
    ) {
      init = init.getExpression();
    }
    if (!init || !(Node.isCallExpression(init) || Node.isNewExpression(init))) continue;

    const callee = dottedName(init.getExpression()) ?? calleeThroughRequire(init.getExpression());
    if (!callee) continue;
    const root = callee.split('.')[0];
    const local = name.getText();

    // Two scopes in one file can each declare a `router`, and they are not the same
    // router. Keyed by name, the second would silently overwrite the first and attach
    // one function's routes to the other's prefix — so a name that means two things is
    // dropped rather than guessed at, the same rule `Builds` applies one layer up.
    const existing = locals.get(local);
    if (existing && existing.callee !== callee) {
      ambiguous.add(local);
      continue;
    }
    if (ambiguous.has(local)) continue;

    locals.set(local, {
      local,
      callee,
      module: imports.get(root)?.external ? (imports.get(root)?.module ?? null) : null,
      isNew: Node.isNewExpression(init),
    });
  }

  for (const name of ambiguous) locals.delete(name);

  return locals;
}

/**
 * Packages a file requires without ever binding the result to a name (#229).
 *
 * `buildImports` records bindings, so `require('express').Router()` and a bare
 * `require('./side-effect')` leave nothing behind — and the route detectors are gated on
 * whether a server framework is in play. In a repo with a manifest that gate is answered
 * project-wide and none of this shows; in one without, it is answered per file, and
 * NodeBB's `src/routes/write/index.js` is the case that matters. Its top of file names
 * winston, meta, plugins and its own controllers, and the only mention of Express is an
 * unbound `require('express').Router()` further down — so the detector was switched off
 * in the file that carries all fourteen `router.use('/api/v3/…')` mounts, and 152 real
 * addresses came out as bare fragments like `/:cid`.
 *
 * Same rule as #230, one level finer: a manifest says what somebody declared and an
 * import says what this code uses, and a require is an import whether or not anyone kept
 * hold of what it returned.
 */
function unboundRequires(sf: SourceFile): string[] {
  const found: string[] = [];
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    const isRequire = Node.isIdentifier(callee) && callee.getText() === 'require';
    if (!isRequire && callee.getKind() !== SyntaxKind.ImportKeyword) continue;
    const specifier = call.getArguments()[0];
    if (!specifier || !Node.isStringLiteral(specifier)) continue;
    const value = specifier.getLiteralValue();
    // Relative paths are this repo's own files; the gate is about third-party frameworks.
    if (value.startsWith('.') || value.startsWith('/')) continue;
    found.push(value);
  }
  return found;
}

/**
 * `const router = require('express').Router()` — a constructor reached straight off a
 * require, with no name bound in between (#229).
 *
 * `dottedName` walks identifiers and property accesses and stops at the call in the
 * middle, so this shape produced no binding at all: the file's `router` was not known to
 * be a router, nothing mounted onto it composed, and every address on it stayed a
 * fragment. Fourteen of NodeBB's route modules open this way, which is its whole write
 * API. Rendered as `express.Router` so it reads the same as the two-line spelling.
 */
function calleeThroughRequire(expression: Node): string | null {
  if (!Node.isPropertyAccessExpression(expression)) return null;
  const base = expression.getExpression();
  if (!Node.isCallExpression(base)) return null;
  if (base.getExpression().getText() !== 'require') return null;
  const specifier = base.getArguments()[0];
  if (!specifier || !Node.isStringLiteral(specifier)) return null;
  return `${specifier.getLiteralValue()}.${expression.getName()}`;
}

/**
 * `@/lib/db` and `~/server/auth` are this repo's own code wearing a bare specifier.
 *
 * Three spellings were a guess at a convention, and the convention is wider than three:
 * outline writes `@server/*` and `@shared/*`, and `@app/*`, `@lib/*` and `src/*` are all
 * in the same family. Every one of them was read as an npm package, so a repository's own
 * server directory came back `external: true` and `@server` was registered as a
 * dependency it imports (#274).
 *
 * The project already knows. It is built from the tsconfig, so `compilerOptions.paths`
 * is loaded and says exactly which bare specifiers this repo redirects to its own files.
 *
 * **Being in `paths` is not enough**, which is the trap. outline maps two entries straight
 * into its dependencies:
 *
 * ```json
 * "vite":                 ["./node_modules/vite/dist/node/index.d.ts"],
 * "@vitejs/plugin-react": ["./node_modules/@vitejs/plugin-react/dist/index.d.ts"]
 * ```
 *
 * Those are external and have to stay external, or a repo starts claiming its bundler as
 * first-party code. So the question is where the alias *points*, and an alias resolving
 * into `node_modules` is a dependency however it is spelled.
 *
 * The three literals stay as the fallback, for a repo with no tsconfig or no `paths` —
 * which is most JavaScript, and where they were right all along.
 */
function isPathAlias(specifier: string, aliases: RegExp[]): boolean {
  if (specifier.startsWith('@/') || specifier.startsWith('~/') || specifier.startsWith('#')) return true;
  return aliases.some((alias) => alias.test(specifier));
}

/**
 * The `paths` keys that redirect to this repo's own files, as matchers.
 *
 * A key is a glob with at most one `*`, so it becomes an anchored pattern rather than a
 * prefix test: `plugins/*` must not claim `pluginsomething`, and a key with no star at
 * all — `vite` — matches that one specifier and nothing under it.
 */
function pathAliasMatchers(options: { paths?: Record<string, string[]> }): RegExp[] {
  const out: RegExp[] = [];
  for (const [key, targets] of Object.entries(options.paths ?? {})) {
    if (targets.some((target) => /(^|[\\/])node_modules[\\/]/.test(target))) continue;
    const [head, tail = ''] = key.split('*');
    const escape = (part: string) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out.push(new RegExp(key.includes('*') ? `^${escape(head)}.*${escape(tail)}$` : `^${escape(key)}$`));
  }
  return out;
}
