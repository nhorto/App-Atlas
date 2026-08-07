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
import type { Dialect } from './dialect.js';
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
  /** Repo-relative path → the namespace that file declares. Every file, cached or not. */
  const namespaceOf = new Map<string, string>();
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
    // Recovered from the file node rather than from the IR, because on this path the
    // file was never parsed. Written there by `buildNodes` for exactly this reason.
    const cached = slice.nodes.find((node) => node.kind === 'file');
    const namespace = cached?.meta?.namespace;
    if (typeof namespace === 'string') namespaceOf.set(ref.relPath, namespace);
    reused++;
  }

  if (stale.length === 0) {
    const mergedNodes = mergePartialTypes(nodes, edges, boundaries, namespaceOf);
    return { nodes: mergedNodes, edges: [...edges.values()], boundaries, warnings, timings, slices, reused };
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
    const read = await extractFile(dialect, ref.relPath, text);
    parsed.set(ref.relPath, read);
    if (read.namespace) namespaceOf.set(ref.relPath, read.namespace);
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
    bucket.nodes.push(...buildNodes(ref, file, texts.get(ref.relPath) ?? '', project.signals.goModule, dialect));
    declarations.set(ref.relPath, declaredIn(bucket.nodes));
  }
  timings.declarations = Date.now() - t2;

  // ---- resolve names into edges ---------------------------------------------
  // Built from every file of this language in the project, not only the ones just read,
  // so an edited file can still point at an untouched one.
  const index = buildPackageIndex(files.map((f) => f.relPath));
  const byNamespace = new Map<string, string[]>();
  for (const [relPath, namespace] of namespaceOf) {
    const list = byNamespace.get(namespace);
    if (list) list.push(relPath);
    else byNamespace.set(namespace, [relPath]);
  }
  const scope: NameScope = {
    kind: dialect.scope ?? 'directory',
    byNamespace,
    namespaceOf,
    moduleIsAFile: dialect.namespaceIsAFile ?? false,
  };

  const t3 = Date.now();
  for (const ref of stale) {
    const file = parsed.get(ref.relPath);
    const bucket = buckets.get(ref.relPath);
    if (!file?.ok || !bucket) continue;
    linkFile(ref, file, index, declarations, bucket.edges, project.signals.goModule, scope);

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

  const mergedNodes = mergePartialTypes(nodes, edges, boundaries, namespaceOf);
  return { nodes: mergedNodes, edges: [...edges.values()], boundaries, warnings, timings, slices, reused };
}

/**
 * A `partial` class is one type, however many files declare it (#97).
 *
 * The rule is three facts, all written down: same name, same namespace, and *every*
 * declaration carries `partial` — a class without the keyword cannot be split, so two
 * types that merely share a name are never merged. `Glance.App.App` and
 * `Glance.Core.Entities.App` stay two, because the namespaces differ; that direction of
 * error would be worse than the doubling this fixes.
 *
 * Runs project-wide after every file is read — a per-file pass cannot know how many
 * parts exist — and on the *assembled* node list, never on the slices, so the per-file
 * cache stays raw and the merge is recomputed identically on incremental runs.
 *
 * The merged node keeps the part with the most members as its face: a reader who opens
 * it should land on the half that holds what they searched for. The other files are not
 * dropped silently — `meta.declaredIn` names every one, because a type that lives in
 * two files is a real shape and picking one file without saying so would send a reader
 * to the wrong half.
 */
function mergePartialTypes(
  nodes: AtlasNode[],
  edges: Map<string, AtlasEdge>,
  boundaries: BoundaryFinding[],
  namespaceOf: Map<string, string>,
): AtlasNode[] {
  const groups = new Map<string, AtlasNode[]>();
  for (const node of nodes) {
    if (node.kind !== 'type' || node.meta.partialType !== true) continue;
    const key = `${namespaceOf.get(node.path ?? '') ?? ''}|${node.name}`;
    const list = groups.get(key);
    if (list) list.push(node);
    else groups.set(key, [node]);
  }

  const replaced = new Map<string, string>();
  for (const parts of groups.values()) {
    if (parts.length < 2) continue;
    // The face of the merged type is its canonical part. C# names the parts by
    // convention and the convention is written down in the file name: `Window.cs` and
    // `Window.xaml.cs` declare the type, `Window.Render.cs` declares a facet of it —
    // and the facet's docstring describes the facet, which must not become the card.
    const canonical = (node: AtlasNode): number => {
      const base = (node.path ?? '').split('/').pop() ?? '';
      return base === `${node.name}.cs` || base === `${node.name}.xaml.cs` ? 0 : 1;
    };
    parts.sort(
      (a, b) =>
        canonical(a) - canonical(b) ||
        fieldsOf(b).length - fieldsOf(a).length ||
        (a.path ?? '').localeCompare(b.path ?? ''),
    );
    const survivor = parts[0]!;

    const fields = fieldsOf(survivor);
    const seenFields = new Set(fields.map((f) => f.name));
    const bases = new Set(extendsOf(survivor));
    let loc = 0;
    for (const part of parts) {
      loc += typeof part.meta.loc === 'number' ? part.meta.loc : 0;
      if (part === survivor) continue;
      for (const field of fieldsOf(part)) {
        if (seenFields.has(field.name)) continue;
        seenFields.add(field.name);
        fields.push(field);
      }
      for (const base of extendsOf(part)) bases.add(base);
      // The docstring is wherever somebody wrote it, which for a designer-split class
      // is usually the hand-written half.
      if (!survivor.summary && part.summary) {
        survivor.summary = part.summary;
        survivor.summarySource = part.summarySource;
        survivor.docHash = part.docHash;
        survivor.provenance = part.provenance;
      }
      replaced.set(part.id, survivor.id);
    }
    survivor.meta.extends = [...bases];
    survivor.meta.loc = loc;
    survivor.meta.declaredIn = parts.map((part) => part.path).sort();
    // The hash must move when any part does, or the words layer would keep a summary
    // written about half the class.
    survivor.hash = hashParts(...parts.map((part) => part.hash).sort());
    survivor.bodyHash = hashParts(...parts.map((part) => part.bodyHash ?? '').sort());
  }
  if (replaced.size === 0) return nodes;

  const out = nodes.filter((node) => !replaced.has(node.id));
  for (const node of out) {
    if (node.parentId && replaced.has(node.parentId)) node.parentId = replaced.get(node.parentId)!;
  }

  for (const [id, edge] of [...edges]) {
    const fromId = replaced.get(edge.fromId) ?? edge.fromId;
    const toId = replaced.get(edge.toId) ?? edge.toId;
    if (fromId === edge.fromId && toId === edge.toId) continue;
    edges.delete(id);
    // An edge between two parts of one class was never saying anything a reader needs.
    if (fromId === toId) continue;
    const newId = makeEdgeId(edge.kind, fromId, toId);
    if (!edges.has(newId)) edges.set(newId, { ...edge, id: newId, fromId, toId });
  }

  // A finding written against a removed part follows it — a door whose handler is one
  // half of a split class must not dangle.
  for (const finding of boundaries) {
    const record = finding as unknown as Record<string, unknown>;
    for (const key of ['nodeId', 'handlerId', 'sourceId']) {
      const value = record[key];
      if (typeof value === 'string' && replaced.has(value)) record[key] = replaced.get(value)!;
    }
    const site = record.site as { nodeId?: string | null } | undefined;
    if (site?.nodeId && replaced.has(site.nodeId)) site.nodeId = replaced.get(site.nodeId)!;
  }

  return out;
}

function fieldsOf(node: AtlasNode): FieldInfo[] {
  return Array.isArray(node.meta.fields) ? (node.meta.fields as FieldInfo[]) : [];
}

function extendsOf(node: AtlasNode): string[] {
  return Array.isArray(node.meta.extends) ? (node.meta.extends as string[]) : [];
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

function buildNodes(
  ref: SourceFileRef,
  file: GenericFile,
  text: string,
  ownModule: string | null,
  dialect: Dialect,
): AtlasNode[] {
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
      externalImports: externalImports(file, ownModule, dialect),
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
    nodes.push(typeNode(id, fileId, ref, def, file.language));
    typeCount++;
    if (def.exported) exported.push(def.name);
  }

  for (const def of file.defs) {
    if (def.kind !== 'function') continue;
    const qualified = def.owner ? `${def.owner}.${def.name}` : def.name;
    const id = unique(makeFunctionId(ref.relPath, qualified), used);
    const parentId = (def.owner && typeIds.get(def.owner)) || fileId;
    nodes.push(functionNode(id, parentId, ref, def, file.language));
    functionCount++;
    if (def.exported && !def.owner) exported.push(def.name);
  }

  fileNode.meta.exportedNames = exported.sort();
  fileNode.meta.functionCount = functionCount;
  fileNode.meta.typeCount = typeCount;
  return nodes;
}

function functionNode(id: string, parentId: string, ref: SourceFileRef, def: GDef, language: string): AtlasNode {
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
    language,
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
      decorators: def.decorators,
      loc: def.endLine - def.line + 1,
      tier: TIER,
    },
  };
}

function typeNode(id: string, fileId: string, ref: SourceFileRef, def: GDef, language: string): AtlasNode {
  const fields: FieldInfo[] = def.fields.map((f) => ({ name: f.name, type: f.type || 'any', optional: false }));
  const doc = firstSentence(def.doc);

  return {
    id,
    kind: 'type',
    name: def.name,
    label: null,
    parentId: fileId,
    language,
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
      extends: def.bases,
      // One part of a split type. The merge into one node happens project-wide, once
      // every file has been read — a per-file pass cannot know how many parts exist.
      ...(def.partial ? { partialType: true } : {}),
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

/** How a language decides which declarations one file can see without qualification. */
export interface NameScope {
  kind: 'directory' | 'namespace';
  /** namespace → the files declaring it. Empty for a directory-scoped language. */
  byNamespace: Map<string, string[]>;
  namespaceOf: Map<string, string>;
  /**
   * Namespace scope where one namespace is one file — Rust, where `modules::estimating`
   * *is* estimating.rs. Changes three things, all consequences of the same fact: an
   * import edge needs no name-by-name gate because the import names its one file the
   * way a Go import names its directory; a `use ns::Item` may point one segment past
   * the file and resolves by dropping the item; and ancestor namespaces are other
   * files whose names are not visible without a `use`, so the bare-name pass stays home.
   */
  moduleIsAFile: boolean;
}

/**
 * Every namespace whose names a file sees without writing them out.
 *
 * Its own, and every namespace enclosing it. C# resolves a bare name by walking outward
 * — a file in `Glance.App.Dashboard` reaches a type in `Glance.App` with nothing written
 * down at all — and that is a rule of the language rather than a guess about the code.
 */
function enclosingNamespaces(namespace: string): string[] {
  const parts = namespace.split('.');
  const out: string[] = [];
  for (let take = parts.length; take > 0; take--) out.push(parts.slice(0, take).join('.'));
  return out;
}

function linkFile(
  ref: SourceFileRef,
  file: GenericFile,
  index: PackageIndex,
  declarations: Map<string, Map<string, Declaration>>,
  edges: Map<string, AtlasEdge>,
  ownModule: string | null,
  scope: NameScope,
): void {
  const fileId = makeFileId(ref.relPath);
  const here = ref.relPath.includes('/') ? ref.relPath.slice(0, ref.relPath.lastIndexOf('/')) : '';
  const byNamespace = scope.kind === 'namespace';

  /** The files a group name stands for — a directory's contents, or a namespace's. */
  const filesOf = (group: string): string[] =>
    byNamespace ? (scope.byNamespace.get(group) ?? []) : (index.byDir.get(group) ?? []);

  /**
   * Names this file mentions anywhere, so an import can link to what it actually reached.
   *
   * A `using` names a namespace and a namespace can hold forty files. Linking to all
   * forty would turn one line into forty arrows and call every one of them a dependency;
   * linking to the ones declaring a type this file names is both smaller and truer, and
   * it is built from facts the reference pass already computed (#96).
   */
  const mentioned = new Set<string>(file.uses);
  for (const def of file.defs) {
    for (const name of def.uses) mentioned.add(name);
    for (const dotted of [...def.qualifiedUses, ...file.qualifiedUses]) {
      for (const part of dotted.split('.')) mentioned.add(part);
    }
  }

  /** Local package name → the group it stands for. */
  const packageDirs = new Map<string, string>();
  /** Local name → the one declaration a `use ns::Item` brought in, for the bare-name pass. */
  const itemImports = new Map<string, { group: string; item: string }>();
  for (const imp of file.imports) {
    let group: string | null;
    let item: string | null = null;
    if (byNamespace) {
      if (scope.byNamespace.has(imp.module)) group = imp.module;
      else if (scope.moduleIsAFile) {
        // `use crate::modules::estimating::compute_all` names an item one segment past
        // its file. The file is the module path above it, and the item is what the
        // bare-name pass should look up in that file.
        const dot = imp.module.lastIndexOf('.');
        const parent = dot === -1 ? null : imp.module.slice(0, dot);
        group = parent && scope.byNamespace.has(parent) ? parent : null;
        if (group) item = imp.module.slice(dot + 1);
      } else group = null;
    } else group = resolveImport(index, imp.module, ownModule);
    if (group === null) continue;
    packageDirs.set(imp.local, group);
    if (scope.moduleIsAFile) itemImports.set(imp.local, { group, item: item ?? imp.local });
    for (const target of filesOf(group)) {
      if (target === ref.relPath) continue;
      // Directory scope keeps every file in the package: an import path names the
      // folder, so the whole folder is what was imported. A C# namespace is not a unit
      // anybody imports, so there the edge has to earn itself one file at a time — but
      // a namespace that is one file (Rust) is imported exactly the way a folder is,
      // and `mod estimating;` is the include even when nothing else names it.
      if (
        byNamespace &&
        !scope.moduleIsAFile &&
        ![...(declarations.get(target)?.keys() ?? [])].some((name) => mentioned.has(name))
      ) {
        continue;
      }
      addEdge(edges, {
        kind: 'imports',
        fromId: fileId,
        toId: makeFileId(target),
        weight: 1,
        // A resolved path is a fact; a namespace plus a name that matched a name is the
        // same grade of evidence as everything else in this tier.
        confidence: byNamespace ? 'likely' : 'certain',
        meta: { symbols: [imp.module] },
      });
    }
  }

  /** Every declaration visible without qualification: this file's package. */
  const inPackage = new Map<string, Declaration>();
  // For C#, resolution walks outward through the enclosing namespaces, because the
  // language says a bare name reaches them. A Rust module sees nothing above it
  // without a `use`, so only its own file is in scope — the `use`s are handled by
  // `itemImports`, which is where that language brings names in.
  const visible = byNamespace
    ? scope.moduleIsAFile
      ? [scope.namespaceOf.get(ref.relPath) ?? '']
      : enclosingNamespaces(scope.namespaceOf.get(ref.relPath) ?? '')
    : [here];
  for (const group of visible) {
    for (const sibling of filesOf(group)) {
      for (const [name, decl] of declarations.get(sibling) ?? []) {
        if (!inPackage.has(name)) inPackage.set(name, decl);
      }
    }
  }

  const declarationsIn = (group: string, name: string): Declaration | null => {
    for (const file of filesOf(group)) {
      const found = declarations.get(file)?.get(name);
      if (found) return found;
    }
    return null;
  };

  /** What a `use ns::Item` (or its alias) put in scope, when the bare name is used. */
  const viaImport = (name: string): Declaration | null => {
    const entry = itemImports.get(name);
    return entry ? declarationsIn(entry.group, entry.item) : null;
  };

  const reference = (fromId: string, bare: string[], qualified: string[]) => {
    for (const name of bare) {
      const target = inPackage.get(name) ?? viaImport(name);
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
 * The default is Go's own rule, not a list: an import path whose first segment has a
 * dot in it names a host, so it came off the internet. `net/http` and `database/sql`
 * have no dot and are the standard library, which nobody thinks of as a dependency.
 * A dialect whose imports do not work that way — Rust, whose dependencies are bare
 * crate names — answers for itself through `externalImport`.
 */
function externalImports(file: GenericFile, ownModule: string | null, dialect: Dialect): string[] {
  const out = new Set<string>();
  for (const imp of file.imports) {
    if (dialect.externalImport) {
      if (dialect.externalImport(imp.module)) out.add(imp.module);
      continue;
    }
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
