/**
 * @fileoverview The generic tier — one plugin per language, all of them the same code.
 *
 * TypeScript gets a type checker and Python gets the interpreter's own parser. This tier
 * gets a grammar and nothing else, and that is a real difference, not a technicality:
 * every node it produces is stamped `tier: 'tree-sitter'` so no screen can quietly
 * present a name that was matched as a name that was resolved.
 *
 * What it buys is the thing App Atlas was worst at. A Go repo used to produce a blank
 * page. Now it produces its files, its functions, its types, its doors and its guards —
 * and the next language after Go costs a query file and a dialect, because everything
 * below this line already works for all of them.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AtlasEdge, AtlasNode, FieldInfo, ParamInfo } from '../../model/types.js';
import { makeEdgeId, makeFileId, makeFunctionId, makeTypeId } from '../../model/types.js';
import { appendAll } from '../../util/append.js';
import { hashParts, hashText } from '../../util/hash.js';
import { extOf } from '../../util/paths.js';
import type { BoundaryFinding } from '../boundaries/types.js';
import type { FileSlice, LanguagePlugin, PluginContext, PluginResult } from '../plugin.js';
import type { SourceFileRef } from '../project.js';
import { extractFile } from './extract.js';
import type { GDef, GenericFile } from './ir.js';
import { LANGUAGES, languageFor } from './languages.js';
import type { GenericLanguage } from './languages.js';
import { loadQuery } from './runtime.js';

/**
 * One plugin per language rather than one plugin for all of them, so that `atlas.json`
 * says the repo is written in Go rather than in something called "generic".
 */
export const genericPlugins: LanguagePlugin[] = LANGUAGES.map((language) => ({
  id: language.dialect.id,
  displayName: language.dialect.displayName,
  claims: (file: SourceFileRef) => languageFor(file.relPath)?.dialect.id === language.dialect.id,
  analyze: (ctx: PluginContext) => analyzeGeneric(language, ctx),
}));

/** A name a package can be reached by → where it is declared. */
interface Declaration {
  nodeId: string;
  relPath: string;
}

export async function analyzeGeneric(language: GenericLanguage, ctx: PluginContext): Promise<PluginResult> {
  const { project, files, options } = ctx;
  const { dialect } = language;
  const warnings: string[] = [];
  const timings: Record<string, number> = {};

  const nodes: AtlasNode[] = [];
  const edges = new Map<string, AtlasEdge>();
  const boundaries: BoundaryFinding[] = [];
  const slices: FileSlice[] = [];

  // ---- restore what has not changed -----------------------------------------
  const stale: SourceFileRef[] = [];
  let reused = 0;
  const declarations = new Map<string, Map<string, Declaration>>();
  for (const ref of files) {
    const slice = ctx.reuse?.get(ref.relPath);
    if (!slice) {
      stale.push(ref);
      continue;
    }
    appendAll(nodes, slice.nodes);
    for (const edge of slice.edges) edges.set(edge.id, edge);
    appendAll(boundaries, slice.boundaries);
    declarations.set(ref.relPath, declaredIn(slice.nodes));
    reused++;
  }

  if (stale.length === 0) {
    return { nodes, edges: [...edges.values()], boundaries, warnings, timings, slices, reused };
  }

  // ---- is the parser actually here ------------------------------------------
  // Asked once, up front. A grammar that will not load is one fact about this install,
  // not one fact per file, and a hundred copies of it in the warnings would bury the
  // one line that tells the reader what to do about it.
  const t0 = Date.now();
  try {
    await loadQuery(dialect.id);
  } catch (err) {
    warnings.push(
      `Found ${files.length} ${dialect.displayName} ${files.length === 1 ? 'file' : 'files'} but could not start the parser: ` +
        `${(err as Error).message}. They appear on the map without their insides.`,
    );
    for (const ref of stale) nodes.push(shallowFileNode(ref, project.root, dialect.id, 'the tree-sitter grammar for it would not load'));
    return { nodes, edges: [...edges.values()], boundaries, warnings, timings, slices, reused };
  }
  timings.parser = Date.now() - t0;

  // ---- read the changed files -----------------------------------------------
  const t1 = Date.now();
  const parsed = new Map<string, GenericFile>();
  const texts = new Map<string, string>();
  let done = 0;
  for (const ref of stale) {
    const text = readText(ref.absPath);
    texts.set(ref.relPath, text);
    parsed.set(ref.relPath, await extractFile(dialect, ref.relPath, text));
    ctx.onProgress?.(`Reading ${dialect.displayName}`, ++done, stale.length);
  }
  timings.extract = Date.now() - t1;

  // ---- turn it into nodes ---------------------------------------------------
  const t2 = Date.now();
  const buckets = new Map<string, { nodes: AtlasNode[]; edges: Map<string, AtlasEdge>; boundaries: BoundaryFinding[] }>();
  for (const ref of stale) {
    const file = parsed.get(ref.relPath)!;
    const bucket = { nodes: [] as AtlasNode[], edges: new Map<string, AtlasEdge>(), boundaries: [] as BoundaryFinding[] };
    buckets.set(ref.relPath, bucket);

    if (!file.ok) {
      const because = file.error ?? 'the parser returned nothing for it';
      warnings.push(`Could not read ${ref.relPath}: ${because}`);
      bucket.nodes.push(shallowFileNode(ref, project.root, dialect.id, because));
      continue;
    }
    bucket.nodes.push(...buildNodes(ref, file, texts.get(ref.relPath) ?? '', project.signals.goModule));
    declarations.set(ref.relPath, declaredIn(bucket.nodes));
  }
  timings.declarations = Date.now() - t2;

  // ---- resolve names into edges ---------------------------------------------
  // Built from every file of this language in the project, not only the ones just read,
  // so an edited file can still point at an untouched one.
  const index = buildPackageIndex(files.map((f) => f.relPath));

  const t3 = Date.now();
  for (const ref of stale) {
    const file = parsed.get(ref.relPath);
    const bucket = buckets.get(ref.relPath);
    if (!file?.ok || !bucket) continue;
    linkFile(ref, file, index, declarations, bucket.edges, project.signals.goModule);

    if (options.detectBoundaries && language.boundaries) {
      const fileId = makeFileId(ref.relPath);
      const own = declarations.get(ref.relPath) ?? new Map<string, Declaration>();
      bucket.boundaries.push(
        ...language.boundaries({
          file,
          fileId,
          nodeIdForScope: (scope) => (scope ? (own.get(scope)?.nodeId ?? fileId) : fileId),
          nodeIdForName: (name) => own.get(name)?.nodeId ?? null,
          signals: project.signals,
        }),
      );
    }
  }
  timings.references = Date.now() - t3;

  // ---- fold back in ---------------------------------------------------------
  for (const ref of stale) {
    const bucket = buckets.get(ref.relPath);
    if (!bucket) continue;
    const sliceEdges = [...bucket.edges.values()];
    appendAll(nodes, bucket.nodes);
    for (const edge of sliceEdges) edges.set(edge.id, edge);
    appendAll(boundaries, bucket.boundaries);
    slices.push({
      relPath: ref.relPath,
      hash: ctx.hashes?.get(ref.relPath) ?? hashText(texts.get(ref.relPath) ?? ''),
      nodes: bucket.nodes,
      edges: sliceEdges,
      boundaries: bucket.boundaries,
      positions: [],
      imports: sliceEdges.filter((e) => e.kind === 'imports').map((e) => e.toId.slice('file:'.length)),
    });
  }

  return { nodes, edges: [...edges.values()], boundaries, warnings, timings, slices, reused };
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

/**
 * Every node this tier makes carries `tier`, and the reason is the whole point of the
 * tier's existence being defensible. Somewhere downstream a screen will want to say "this
 * function calls that one", and it must be able to find out that the only evidence for it
 * was that the two share a name.
 */
const TIER = 'tree-sitter';

function buildNodes(ref: SourceFileRef, file: GenericFile, text: string, ownModule: string | null): AtlasNode[] {
  const fileId = makeFileId(ref.relPath);
  const nodes: AtlasNode[] = [];
  const used = new Set<string>();

  const doc = firstSentence(file.doc);
  const fileNode: AtlasNode = {
    id: fileId,
    kind: 'file',
    name: path.posix.basename(ref.relPath),
    label: null,
    parentId: null,
    language: file.language,
    path: ref.relPath,
    startLine: 1,
    endLine: file.loc,
    zone: ref.zone,
    summary: doc,
    summarySource: doc ? 'docs' : null,
    docHash: doc ? hashText(doc) : null,
    bodyHash: hashText(text),
    hash: hashText(text),
    provenance: doc ? 'docs' : 'static',
    meta: {
      ext: extOf(ref.relPath),
      loc: file.loc,
      externalImports: externalImports(file, ownModule),
      exportedNames: [] as string[],
      functionCount: 0,
      typeCount: 0,
      tier: TIER,
      // The namespace a file declares is not the directory it sits in, and in Go the
      // difference is load-bearing: `package main` under `cmd/api` is a program, and the
      // same directory could hold a `package api` that is a library.
      ...(file.namespace ? { namespace: file.namespace } : {}),
      // Tree-sitter recovers from syntax it cannot fit, which means a partly-read file
      // looks exactly like a quiet one unless it says so.
      ...(file.hasErrors ? { partial: true } : {}),
    },
  };
  nodes.push(fileNode);

  const exported: string[] = [];
  let functionCount = 0;
  let typeCount = 0;

  // A method belongs under the type it hangs off, exactly as it does in the other two
  // analyzers, so the drill-down reads the same whichever language you land in.
  const typeIds = new Map<string, string>();
  for (const def of file.defs) {
    if (def.kind !== 'type') continue;
    const id = unique(makeTypeId(ref.relPath, def.name), used);
    typeIds.set(def.name, id);
    nodes.push(typeNode(id, fileId, ref, def));
    typeCount++;
    if (def.exported) exported.push(def.name);
  }

  for (const def of file.defs) {
    if (def.kind !== 'function') continue;
    const qualified = def.owner ? `${def.owner}.${def.name}` : def.name;
    const id = unique(makeFunctionId(ref.relPath, qualified), used);
    const parentId = (def.owner && typeIds.get(def.owner)) || fileId;
    nodes.push(functionNode(id, parentId, ref, def));
    functionCount++;
    if (def.exported && !def.owner) exported.push(def.name);
  }

  fileNode.meta.exportedNames = exported.sort();
  fileNode.meta.functionCount = functionCount;
  fileNode.meta.typeCount = typeCount;
  return nodes;
}

function functionNode(id: string, parentId: string, ref: SourceFileRef, def: GDef): AtlasNode {
  const params: ParamInfo[] = def.params.map((p) => ({
    name: p.name,
    type: p.type || 'any',
    optional: false,
    rest: false,
  }));
  const returnType = def.returns || 'void';
  const signature = `${def.name}(${params.map((p) => `${p.name}: ${p.type}`).join(', ')}) -> ${returnType}`;
  const doc = firstSentence(def.doc);

  return {
    id,
    kind: 'function',
    name: def.name,
    label: null,
    parentId,
    language: 'go',
    path: ref.relPath,
    startLine: def.line,
    endLine: def.endLine,
    zone: ref.zone,
    summary: doc,
    summarySource: doc ? 'docs' : null,
    docHash: doc ? hashText(doc) : null,
    bodyHash: hashParts(String(def.startIndex), String(def.endIndex - def.startIndex)),
    hash: hashParts(signature, String(def.endIndex - def.startIndex)),
    provenance: doc ? 'docs' : 'static',
    meta: {
      signature,
      params,
      returnType,
      isAsync: false,
      isExported: def.exported,
      isMethod: Boolean(def.owner),
      ownerName: def.owner ?? undefined,
      decorators: [] as string[],
      loc: def.endLine - def.line + 1,
      tier: TIER,
    },
  };
}

function typeNode(id: string, fileId: string, ref: SourceFileRef, def: GDef): AtlasNode {
  const fields: FieldInfo[] = def.fields.map((f) => ({ name: f.name, type: f.type || 'any', optional: false }));
  const doc = firstSentence(def.doc);

  return {
    id,
    kind: 'type',
    name: def.name,
    label: null,
    parentId: fileId,
    language: 'go',
    path: ref.relPath,
    startLine: def.line,
    endLine: def.endLine,
    zone: ref.zone,
    summary: doc,
    summarySource: doc ? 'docs' : null,
    docHash: doc ? hashText(doc) : null,
    bodyHash: hashParts(String(def.startIndex), String(def.endIndex - def.startIndex)),
    hash: hashParts(def.name, String(def.endIndex - def.startIndex)),
    provenance: doc ? 'docs' : 'static',
    meta: {
      typeKind: 'class',
      fields,
      isExported: def.exported,
      extends: [] as string[],
      loc: def.endLine - def.line + 1,
      tier: TIER,
    },
  };
}

/**
 * A file we could not parse still belongs on the map — as a file, with its size.
 *
 * `because` is carried on the node rather than only into `warnings` so that it survives
 * the cache, and so the auth screen knows a route importing this file has an unexamined
 * check in it rather than no check at all (issue #36).
 */
function shallowFileNode(ref: SourceFileRef, root: string, language: string, because: string): AtlasNode {
  const text = readText(path.join(root, ref.relPath));
  const loc = text.split(/\r?\n/).length;
  return {
    id: makeFileId(ref.relPath),
    kind: 'file',
    name: path.posix.basename(ref.relPath),
    label: null,
    parentId: null,
    language,
    path: ref.relPath,
    startLine: 1,
    endLine: loc,
    zone: ref.zone,
    summary: null,
    summarySource: null,
    docHash: null,
    bodyHash: hashText(text),
    hash: hashText(text),
    provenance: 'static',
    meta: {
      ext: extOf(ref.relPath),
      loc,
      externalImports: [] as string[],
      exportedNames: [] as string[],
      functionCount: 0,
      typeCount: 0,
      tier: TIER,
      unread: because,
    },
  };
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

/**
 * Directory → the files in it.
 *
 * A Go package is a directory, not a file: `import ".../internal/store"` brings in
 * everything under `internal/store`, and a name it exports could be declared in any of
 * them. Every other language this tier is likely to grow — Ruby, Java, C# — groups names
 * the same way, so the index is by directory rather than by anything Go-specific.
 */
export interface PackageIndex {
  /** Directory (posix, no trailing slash, '' for the root) → repo-relative files. */
  byDir: Map<string, string[]>;
  /** Longest directory paths first, for suffix matching. */
  dirs: string[];
}

export function buildPackageIndex(relPaths: string[]): PackageIndex {
  const byDir = new Map<string, string[]>();
  for (const relPath of relPaths) {
    const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
    const list = byDir.get(dir);
    if (list) list.push(relPath);
    else byDir.set(dir, [relPath]);
  }
  return { byDir, dirs: [...byDir.keys()].sort((a, b) => b.length - a.length) };
}

/**
 * The directory an import path names, or null when it points outside this repo.
 *
 * Two ways, in order. If `go.mod` says what this module is called, an import starting
 * with that name is this repo's own code and the rest of the path is the directory —
 * exact, no guessing. Failing that the tail of the import is matched against the
 * directories that exist, which is what gets a repo without a readable `go.mod`
 * something rather than nothing.
 */
export function resolveImport(index: PackageIndex, module: string, ownModule: string | null): string | null {
  if (ownModule) {
    if (module === ownModule) return index.byDir.has('') ? '' : null;
    if (module.startsWith(`${ownModule}/`)) {
      const dir = module.slice(ownModule.length + 1);
      return index.byDir.has(dir) ? dir : null;
    }
    // A module path that names somebody else's repo is somebody else's code, and
    // matching it against our directories by tail is how `github.com/other/api` ends up
    // pointing at our `api/`.
    if (module.includes('.')) return null;
  }
  const segments = module.split('/').filter(Boolean);
  for (let start = 0; start < segments.length; start++) {
    const candidate = segments.slice(start).join('/');
    if (index.byDir.has(candidate)) return candidate;
  }
  return null;
}

function linkFile(
  ref: SourceFileRef,
  file: GenericFile,
  index: PackageIndex,
  declarations: Map<string, Map<string, Declaration>>,
  edges: Map<string, AtlasEdge>,
  ownModule: string | null,
): void {
  const fileId = makeFileId(ref.relPath);
  const here = ref.relPath.includes('/') ? ref.relPath.slice(0, ref.relPath.lastIndexOf('/')) : '';

  /** Local package name → the directory it stands for. */
  const packageDirs = new Map<string, string>();
  for (const imp of file.imports) {
    const dir = resolveImport(index, imp.module, ownModule);
    if (dir === null) continue;
    packageDirs.set(imp.local, dir);
    for (const target of index.byDir.get(dir) ?? []) {
      if (target === ref.relPath) continue;
      addEdge(edges, {
        kind: 'imports',
        fromId: fileId,
        toId: makeFileId(target),
        weight: 1,
        confidence: 'certain',
        meta: { symbols: [imp.module] },
      });
    }
  }

  /** Every declaration visible without qualification: this file's package. */
  const inPackage = new Map<string, Declaration>();
  for (const sibling of index.byDir.get(here) ?? []) {
    for (const [name, decl] of declarations.get(sibling) ?? []) {
      if (!inPackage.has(name)) inPackage.set(name, decl);
    }
  }

  const declarationsIn = (dir: string, name: string): Declaration | null => {
    for (const file of index.byDir.get(dir) ?? []) {
      const found = declarations.get(file)?.get(name);
      if (found) return found;
    }
    return null;
  };

  const reference = (fromId: string, bare: string[], qualified: string[]) => {
    for (const name of bare) {
      const target = inPackage.get(name);
      if (!target || target.nodeId === fromId) continue;
      addEdge(edges, {
        kind: 'references',
        fromId,
        toId: target.nodeId,
        weight: 1,
        // Same file, same package-wide namespace, and no name above it to shadow it.
        // Across files it is still only a name that matched a name, which is exactly
        // what this tier is for and exactly what it must not overstate.
        confidence: target.relPath === ref.relPath ? 'certain' : 'likely',
        meta: {},
      });
    }
    for (const dotted of qualified) {
      const dot = dotted.indexOf('.');
      if (dot === -1) continue;
      const dir = packageDirs.get(dotted.slice(0, dot));
      if (dir === undefined) continue;
      const target = declarationsIn(dir, dotted.slice(dot + 1));
      if (!target || target.nodeId === fromId) continue;
      addEdge(edges, { kind: 'references', fromId, toId: target.nodeId, weight: 1, confidence: 'likely', meta: {} });
    }
  };

  const own = declarations.get(ref.relPath) ?? new Map<string, Declaration>();
  for (const def of file.defs) {
    const qualifiedName = def.owner ? `${def.owner}.${def.name}` : def.name;
    const fromId = own.get(qualifiedName)?.nodeId ?? fileId;
    reference(fromId, def.uses, def.qualifiedUses);
  }
  reference(fileId, file.uses, file.qualifiedUses);
}

/** The names this file declares, under both `name` and `Owner.name`. */
function declaredIn(nodes: AtlasNode[]): Map<string, Declaration> {
  const out = new Map<string, Declaration>();
  for (const node of nodes) {
    if (node.kind === 'file') continue;
    const entry = { nodeId: node.id, relPath: node.path ?? '' };
    const owner = typeof node.meta.ownerName === 'string' ? node.meta.ownerName : null;
    out.set(owner ? `${owner}.${node.name}` : node.name, entry);
    // A method is also reachable by its bare name from inside its own package.
    if (owner && !out.has(node.name)) out.set(node.name, entry);
  }
  return out;
}

interface EdgeInput {
  kind: AtlasEdge['kind'];
  fromId: string;
  toId: string;
  weight: number;
  confidence: AtlasEdge['confidence'];
  meta: Record<string, unknown>;
}

function addEdge(edges: Map<string, AtlasEdge>, input: EdgeInput): void {
  const id = makeEdgeId(input.kind, input.fromId, input.toId);
  const existing = edges.get(id);
  if (existing) {
    existing.weight += input.weight;
    const added = (input.meta.symbols as string[] | undefined) ?? [];
    if (added.length > 0) {
      const already = (existing.meta.symbols as string[] | undefined) ?? [];
      existing.meta.symbols = [...new Set([...already, ...added])];
    }
    return;
  }
  edges.set(id, { id, ...input, provenance: 'static' });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Which third parties this file brings in.
 *
 * Go's own rule, not a list: an import path whose first segment has a dot in it names a
 * host, so it came off the internet. `net/http` and `database/sql` have no dot and are
 * the standard library, which nobody thinks of as a dependency.
 */
function externalImports(file: GenericFile, ownModule: string | null): string[] {
  const out = new Set<string>();
  for (const imp of file.imports) {
    const first = imp.module.split('/')[0] ?? '';
    if (!first.includes('.')) continue;
    if (ownModule && (imp.module === ownModule || imp.module.startsWith(`${ownModule}/`))) continue;
    out.add(imp.module);
  }
  return [...out].sort();
}

/** The first sentence of a doc comment — everybody's convention for the summary. */
function firstSentence(doc: string | null): string | null {
  if (!doc) return null;
  const text = doc.trim().split(/\n\s*\n/)[0]?.replace(/\s+/g, ' ').trim();
  return text ? text : null;
}

function unique(id: string, used: Set<string>): string {
  if (!used.has(id)) {
    used.add(id);
    return id;
  }
  let n = 2;
  while (used.has(`${id}~${n}`)) n++;
  const next = `${id}~${n}`;
  used.add(next);
  return next;
}

function readText(absPath: string): string {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch {
    return '';
  }
}
