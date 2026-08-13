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
  routeHelperDetector,
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

  const add = (local: string, specifier: string, imported: string) => {
    const external = isBareSpecifier(specifier) && !isPathAlias(specifier);
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

/** `@/lib/db` and `~/server/auth` are this repo's own code wearing a bare specifier. */
function isPathAlias(specifier: string): boolean {
  return specifier.startsWith('@/') || specifier.startsWith('~/') || specifier.startsWith('#');
}
