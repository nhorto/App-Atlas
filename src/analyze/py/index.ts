/**
 * @fileoverview The Python analyzer — the second language plugin.
 *
 * SPEC.md 5.2 calls this the "good tier", and the difference from TypeScript is worth
 * being honest about. TypeScript gets a type checker, so "this identifier is that
 * declaration" is a fact. Python has no checker here, so a call is matched to a
 * declaration by name through the import that introduced it. Inside a file that is as
 * good as certain; across files it is an inference, and every edge says so by carrying
 * `likely` rather than `certain`. The model was built to tolerate exactly this — a
 * plugin may be shallower without the rest of the system knowing (SPEC.md 5.7).
 *
 * Everything the interpreter says is a fact about syntax; everything about *which file
 * a name lives in* is decided here, where the whole project is in view.
 */
import path from 'node:path';
import fs from 'node:fs';
import type { AtlasEdge, AtlasNode, FieldInfo, ParamInfo } from '../../model/types.js';
import { makeEdgeId, makeFileId, makeFunctionId, makeTypeId } from '../../model/types.js';
import { hashParts, hashText } from '../../util/hash.js';
import { extOf } from '../../util/paths.js';
import type { BoundaryFinding } from '../boundaries/types.js';
import type { FileSlice, LanguagePlugin, PluginContext, PluginResult } from '../plugin.js';
import type { SourceFileRef } from '../project.js';
import { detectPythonBoundaries } from './boundaries.js';
import { buildModuleIndex, resolveModule } from './modules.js';
import type { ModuleIndex } from './modules.js';
import { BATCH_SIZE, extractorPath, findInterpreter, run } from './run.js';
import type { Interpreter } from './run.js';
import type { PyDef, PyFile, PyPayload } from './types.js';

// A notebook is Python too — it just keeps its statements in a JSON envelope, which
// extract.py unwraps. Everything downstream sees ordinary Python.
const PY_EXTENSIONS = new Set(['.py', '.pyi', '.ipynb']);
const EXTRACT_TIMEOUT_MS = 120_000;

export const pythonPlugin: LanguagePlugin = {
  id: 'python',
  displayName: 'Python',
  claims: (file) => PY_EXTENSIONS.has(extOf(file.relPath)),
  analyze: (ctx) => analyzePython(ctx),
};

/** A name a file can be reached by → where it is declared. */
interface Declaration {
  nodeId: string;
  relPath: string;
}

export async function analyzePython(ctx: PluginContext): Promise<PluginResult> {
  const { project, files, options } = ctx;
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
    nodes.push(...slice.nodes);
    for (const edge of slice.edges) edges.set(edge.id, edge);
    boundaries.push(...slice.boundaries);
    declarations.set(ref.relPath, declaredIn(slice.nodes));
    reused++;
  }

  if (stale.length === 0) {
    return { nodes, edges: [...edges.values()], boundaries, warnings, timings, slices, reused };
  }

  // ---- ask Python what the changed files say --------------------------------
  const t0 = Date.now();
  const { interpreter, warning } = await findInterpreter(project.root);
  if (warning) warnings.push(warning);
  if (!interpreter) {
    warnings.push(
      `Found ${files.length} Python ${files.length === 1 ? 'file' : 'files'} but no Python 3.9+ to read them with. ` +
        'They appear on the map without their insides. Set APP_ATLAS_PYTHON to point at an interpreter.',
    );
    for (const ref of stale) nodes.push(shallowFileNode(ref, project.root, 'no Python 3.9+ interpreter was available to read it'));
    return { nodes, edges: [...edges.values()], boundaries, warnings, timings, slices, reused };
  }
  timings.interpreter = Date.now() - t0;

  const t1 = Date.now();
  const parsed = new Map<string, PyFile>();
  let done = 0;
  for (let start = 0; start < stale.length; start += BATCH_SIZE) {
    const batch = stale.slice(start, start + BATCH_SIZE);
    const payload = await extract(interpreter, batch, warnings);
    for (const file of payload) parsed.set(file.path, file);
    done += batch.length;
    ctx.onProgress?.('Reading Python', done, stale.length);
  }
  timings.extract = Date.now() - t1;

  // ---- turn it into nodes ---------------------------------------------------
  const t2 = Date.now();
  const texts = new Map<string, string>();
  const buckets = new Map<string, { nodes: AtlasNode[]; edges: Map<string, AtlasEdge>; boundaries: BoundaryFinding[] }>();

  for (const ref of stale) {
    const file = parsed.get(ref.relPath);
    const bucket = { nodes: [] as AtlasNode[], edges: new Map<string, AtlasEdge>(), boundaries: [] as BoundaryFinding[] };
    buckets.set(ref.relPath, bucket);

    if (!file || !file.ok) {
      const because = file?.error ?? 'the Python reader returned nothing for it';
      if (file?.error) warnings.push(`Could not read ${ref.relPath}: ${file.error}`);
      bucket.nodes.push(shallowFileNode(ref, project.root, because));
      continue;
    }
    // A notebook's own bytes are JSON; the Python it contains came back from the
    // extractor, and that is what every line number in this record counts against.
    const text = file.source ?? readText(path.join(project.root, ref.relPath));
    texts.set(ref.relPath, text);
    bucket.nodes.push(...buildNodes(ref, file, text));
    declarations.set(ref.relPath, declaredIn(bucket.nodes));
  }
  timings.declarations = Date.now() - t2;

  // ---- resolve names into edges ---------------------------------------------
  // Built from every Python file in the project, not only the ones just read, so an
  // edited file can still point at an untouched one.
  const index = buildModuleIndex(files.map((f) => f.relPath));

  const t3 = Date.now();
  for (const ref of stale) {
    const file = parsed.get(ref.relPath);
    const bucket = buckets.get(ref.relPath);
    if (!file || !file.ok || !bucket) continue;
    linkFile(ref, file, index, declarations, bucket.edges);

    if (options.detectBoundaries) {
      const fileId = makeFileId(ref.relPath);
      const own = declarations.get(ref.relPath) ?? new Map();
      bucket.boundaries.push(
        ...detectPythonBoundaries({
          file,
          fileId,
          nodeIdForScope: (scope) => (scope ? (own.get(scope)?.nodeId ?? fileId) : fileId),
          packages: project.signals.pythonPackages,
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
    nodes.push(...bucket.nodes);
    for (const edge of sliceEdges) edges.set(edge.id, edge);
    boundaries.push(...bucket.boundaries);
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

/** Runs the extractor over one batch and returns whatever came back. */
async function extract(interpreter: Interpreter, batch: SourceFileRef[], warnings: string[]): Promise<PyFile[]> {
  const request = JSON.stringify({
    files: batch.map((ref) => ({ rel: ref.relPath, abs: ref.absPath })),
  });
  const result = await run(
    interpreter.command,
    [...interpreter.args, extractorPath()],
    request,
    EXTRACT_TIMEOUT_MS,
  );
  if (!result.ok) {
    warnings.push(`Python ${interpreter.version} could not read ${batch.length} files: ${firstLine(result.stderr)}`);
    return [];
  }
  try {
    const payload = JSON.parse(result.stdout) as PyPayload;
    if (payload.error) warnings.push(`The Python reader reported: ${payload.error}`);
    return payload.files ?? [];
  } catch (err) {
    warnings.push(`The Python reader answered in a shape we could not read: ${(err as Error).message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

function buildNodes(ref: SourceFileRef, file: PyFile, text: string): AtlasNode[] {
  const fileId = makeFileId(ref.relPath);
  const lines = text.split(/\r?\n/);
  const nodes: AtlasNode[] = [];
  const used = new Set<string>();

  const doc = firstSentence(file.doc);
  const fileNode: AtlasNode = {
    id: fileId,
    kind: 'file',
    name: path.posix.basename(ref.relPath),
    label: null,
    parentId: null,
    language: 'python',
    path: ref.relPath,
    startLine: 1,
    endLine: file.loc ?? lines.length,
    zone: ref.zone,
    summary: doc,
    summarySource: doc ? 'docs' : null,
    docHash: doc ? hashText(doc) : null,
    bodyHash: hashText(text),
    hash: hashText(text),
    provenance: doc ? 'docs' : 'static',
    meta: {
      ext: extOf(ref.relPath),
      loc: file.loc ?? lines.length,
      externalImports: externalImports(file),
      exportedNames: [] as string[],
      functionCount: 0,
      typeCount: 0,
      // Notebooks only. A reader looking at a stack of cells cannot use "line 412",
      // so the cell each line belongs to travels with the file.
      ...(file.cells ? { cellCount: file.cells.length, cells: file.cells } : {}),
    },
  };
  nodes.push(fileNode);

  const exported: string[] = [];
  let functionCount = 0;
  let typeCount = 0;

  for (const def of file.defs ?? []) {
    if (def.kind === 'function') {
      const id = unique(makeFunctionId(ref.relPath, def.name), used);
      nodes.push(functionNode(id, fileId, ref, def, lines, cellAt(file, def.line)));
      functionCount++;
      if (!def.name.startsWith('_')) exported.push(def.name);
      continue;
    }

    const id = unique(makeTypeId(ref.relPath, def.name), used);
    nodes.push(classNode(id, fileId, ref, def, lines));
    typeCount++;
    if (!def.name.startsWith('_')) exported.push(def.name);

    for (const method of def.methods ?? []) {
      const methodId = unique(makeFunctionId(ref.relPath, `${def.name}.${method.name}`), used);
      // Methods hang off the class, exactly as they do in the TypeScript analyzer, so
      // the drill-down reads the same whichever language you land in.
      nodes.push(functionNode(methodId, id, ref, method, lines, cellAt(file, method.line), def.name));
      functionCount++;
    }
  }

  fileNode.meta.exportedNames = exported.sort();
  fileNode.meta.functionCount = functionCount;
  fileNode.meta.typeCount = typeCount;
  return nodes;
}

/** Which notebook cell a line fell in, or null for an ordinary file. */
function cellAt(file: PyFile, line: number): number | null {
  for (const cell of file.cells ?? []) {
    if (line >= cell.startLine && line <= cell.endLine) return cell.index;
  }
  return null;
}

function functionNode(
  id: string,
  parentId: string,
  ref: SourceFileRef,
  def: PyDef,
  lines: string[],
  cell: number | null,
  ownerName?: string,
): AtlasNode {
  const params: ParamInfo[] = (def.params ?? []).map((p) => ({
    name: p.name,
    type: p.type || 'Any',
    optional: p.optional,
    rest: p.rest,
  }));
  const returnType = def.returns || 'Any';
  const signature = `${def.name}(${params
    .map((p) => `${p.rest ? '*' : ''}${p.name}${p.optional ? '?' : ''}: ${p.type}`)
    .join(', ')}) -> ${returnType}`;
  const body = slice(lines, def.line, def.endLine);
  const doc = firstSentence(def.doc);

  return {
    id,
    kind: 'function',
    name: def.name,
    label: null,
    parentId,
    language: 'python',
    path: ref.relPath,
    startLine: def.line,
    endLine: def.endLine,
    zone: ref.zone,
    summary: doc,
    summarySource: doc ? 'docs' : null,
    docHash: doc ? hashText(doc) : null,
    bodyHash: hashText(body),
    hash: hashParts(signature, body),
    provenance: doc ? 'docs' : 'static',
    meta: {
      signature,
      params,
      returnType,
      isAsync: Boolean(def.isAsync),
      // Python has no export keyword; the convention is that a leading underscore
      // means private, and that convention is what the whole ecosystem reads.
      isExported: !def.name.startsWith('_'),
      isMethod: Boolean(ownerName),
      ownerName,
      decorators: def.decorators.map((d) => d.text ?? d.callee).filter(Boolean),
      loc: def.endLine - def.line + 1,
      ...(cell === null ? {} : { cell }),
    },
  };
}

function classNode(id: string, fileId: string, ref: SourceFileRef, def: PyDef, lines: string[]): AtlasNode {
  const fields: FieldInfo[] = (def.fields ?? []).map((f) => ({
    name: f.name,
    type: f.type || 'Any',
    optional: f.optional,
  }));
  const body = slice(lines, def.line, def.endLine);
  const doc = firstSentence(def.doc);

  return {
    id,
    kind: 'type',
    name: def.name,
    label: null,
    parentId: fileId,
    language: 'python',
    path: ref.relPath,
    startLine: def.line,
    endLine: def.endLine,
    zone: ref.zone,
    summary: doc,
    summarySource: doc ? 'docs' : null,
    docHash: doc ? hashText(doc) : null,
    bodyHash: hashText(body),
    hash: hashParts(def.name, body),
    provenance: doc ? 'docs' : 'static',
    meta: {
      typeKind: 'class',
      fields,
      isExported: !def.name.startsWith('_'),
      extends: def.bases ?? [],
      loc: def.endLine - def.line + 1,
    },
  };
}

/**
 * A file we could not parse still belongs on the map — as a file, with its size.
 *
 * `because` is carried on the node rather than only into `warnings` for two reasons:
 * it survives the cache, so the second run is as honest as the first; and the auth
 * screen needs to know that a route importing this file has an unexamined check in it
 * rather than no check at all (issue #36).
 */
function shallowFileNode(ref: SourceFileRef, root: string, because: string): AtlasNode {
  const text = readText(path.join(root, ref.relPath));
  return {
    id: makeFileId(ref.relPath),
    kind: 'file',
    name: path.posix.basename(ref.relPath),
    label: null,
    parentId: null,
    language: 'python',
    path: ref.relPath,
    startLine: 1,
    endLine: text.split(/\r?\n/).length,
    zone: ref.zone,
    summary: null,
    summarySource: null,
    docHash: null,
    bodyHash: hashText(text),
    hash: hashText(text),
    provenance: 'static',
    meta: {
      ext: extOf(ref.relPath),
      loc: text.split(/\r?\n/).length,
      externalImports: [],
      exportedNames: [],
      functionCount: 0,
      typeCount: 0,
      unread: because,
    },
  };
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

/**
 * Import edges between files, and reference edges from each definition to whatever it
 * names.
 *
 * A name resolves in one of two ways: it was declared in this file, or it arrived
 * through an import that points at another file in the project. Anything else — a
 * third-party symbol, a local variable, a builtin — is left alone.
 */
function linkFile(
  ref: SourceFileRef,
  file: PyFile,
  index: ModuleIndex,
  declarations: Map<string, Map<string, Declaration>>,
  edges: Map<string, AtlasEdge>,
): void {
  const fileId = makeFileId(ref.relPath);

  /** Local name → what it refers to somewhere else in the project. */
  const imported = new Map<string, Declaration>();

  for (const imp of file.imports ?? []) {
    const targetRel = resolveModule(index, ref.relPath, imp.module, imp.level);
    if (!targetRel || targetRel === ref.relPath) continue;

    addEdge(edges, {
      kind: 'imports',
      fromId: fileId,
      toId: makeFileId(targetRel),
      weight: Math.max(1, imp.names.length),
      confidence: 'certain',
      meta: { symbols: imp.names.map(([name]) => name) },
    });

    const targetDecls = declarations.get(targetRel);
    if (!targetDecls) continue;
    for (const [exportedName, localName] of imp.names) {
      const found = targetDecls.get(exportedName);
      if (found) imported.set(localName, found);
    }
  }

  const own = declarations.get(ref.relPath) ?? new Map<string, Declaration>();
  const reference = (fromId: string, names: string[]) => {
    for (const name of names) {
      const local = own.get(name);
      if (local && local.nodeId !== fromId) {
        addEdge(edges, {
          kind: 'references',
          fromId,
          toId: local.nodeId,
          weight: 1,
          // Same file, same name, and Python has one namespace per module — there is
          // nothing left to be wrong about.
          confidence: 'certain',
          meta: {},
        });
        continue;
      }
      const target = imported.get(name);
      if (target && target.nodeId !== fromId) {
        addEdge(edges, {
          kind: 'references',
          fromId,
          toId: target.nodeId,
          weight: 1,
          // The import binds the name and the name matches a declaration, which is
          // strong — but no checker confirmed it, so the map says `likely`.
          confidence: 'likely',
          meta: {},
        });
      }
    }
  };

  for (const def of file.defs ?? []) {
    const declared = own.get(def.name);
    const fromId = declared?.nodeId ?? fileId;
    reference(fromId, def.uses);
    for (const method of def.methods ?? []) {
      const methodDecl = own.get(`${def.name}.${method.name}`);
      reference(methodDecl?.nodeId ?? fromId, method.uses);
    }
  }
  reference(fileId, file.uses ?? []);
}

/** The names this file declares, under both `name` and `Class.method`. */
function declaredIn(nodes: AtlasNode[]): Map<string, Declaration> {
  const out = new Map<string, Declaration>();
  const owners = new Map<string, string>();
  for (const node of nodes) {
    if (node.kind === 'type') owners.set(node.id, node.name);
  }
  for (const node of nodes) {
    if (node.kind === 'file') continue;
    const entry = { nodeId: node.id, relPath: node.path ?? '' };
    const owner = node.parentId ? owners.get(node.parentId) : undefined;
    out.set(owner ? `${owner}.${node.name}` : node.name, entry);
    // A method is also reachable by its bare name from inside its own class.
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

function externalImports(file: PyFile): string[] {
  const out = new Set<string>();
  for (const imp of file.imports ?? []) {
    if (imp.level > 0 || !imp.module) continue;
    out.add(imp.module.split('.')[0]);
  }
  return [...out].sort();
}

function slice(lines: string[], from: number, to: number): string {
  return lines.slice(Math.max(0, from - 1), to).join('\n');
}

/**
 * The first line of a docstring. Python convention is a one-line summary, a blank
 * line, then detail — so the summary is already written for us.
 */
function firstSentence(doc: string | null | undefined): string | null {
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

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.slice(0, 200) ?? 'no output';
}
