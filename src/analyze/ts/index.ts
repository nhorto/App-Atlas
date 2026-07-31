/**
 * @fileoverview The TypeScript/JavaScript analyzer — the facts layer.
 *
 * Built on ts-morph so we get the real TypeScript type checker, not a parser. That
 * matters: everything interesting (what a function returns, which symbol an
 * identifier actually refers to, and in M2 whether `db` is a PrismaClient) needs
 * resolution, not syntax.
 *
 * Emits: file nodes, function nodes, type nodes, `imports` edges between files, and
 * `references` edges between the symbols that use each other. Nothing here guesses —
 * every node and edge is compiler-derived, provenance `static`.
 *
 * Everything is accumulated per file rather than into one pile, because a file's
 * results are also the unit the cache stores between runs (see `cache.ts`). A file that
 * has not been edited is restored from that cache and never reaches the compiler.
 */
import path from 'node:path';
import { Node, Project, SyntaxKind, ts } from 'ts-morph';
import type {
  ArrowFunction,
  ClassDeclaration,
  EnumDeclaration,
  FunctionDeclaration,
  FunctionExpression,
  Identifier,
  InterfaceDeclaration,
  MethodDeclaration,
  ParameterDeclaration,
  PropertyAssignment,
  PropertyDeclaration,
  PropertySignature,
  SourceFile,
  Type,
  TypeAliasDeclaration,
  VariableDeclaration,
} from 'ts-morph';
import type { AtlasEdge, AtlasNode, FieldInfo, ParamInfo } from '../../model/types.js';
import { makeEdgeId, makeFileId, makeFunctionId, makeTypeId } from '../../model/types.js';
import { hashParts, hashText } from '../../util/hash.js';
import { extOf, toPosix } from '../../util/paths.js';
import { detectBoundaries } from '../boundaries/index.js';
import type { BoundaryFinding } from '../boundaries/types.js';
import type { FileSlice, LanguagePlugin, PluginContext, PluginResult } from '../plugin.js';
import type { SourceFileRef } from '../project.js';
import { appendAll } from '../../util/append.js';

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const MAX_TYPE_TEXT = 180;
const FILE_ID_PREFIX = 'file:';

export const typescriptPlugin: LanguagePlugin = {
  id: 'typescript',
  displayName: 'TypeScript / JavaScript',
  claims: (file) => TS_EXTENSIONS.has(extOf(file.relPath)),
  analyze: (ctx) => analyzeTypeScript(ctx),
};

interface Registered {
  /** `${lowercased abs path}|${node start pos}` → atlas node id. */
  byPosition: Map<string, string>;
  /** Every declared name we know about, for cheap identifier pre-filtering. */
  names: Set<string>;
}

/** What one file declared, before it is merged into the project-wide index. */
interface Declared {
  positions: [number, string][];
  names: string[];
}

/** One fresh file, part-analyzed, on its way to becoming a slice. */
interface Bucket {
  ref: SourceFileRef;
  sf: SourceFile;
  fileNode: AtlasNode | null;
  nodes: AtlasNode[];
  edges: Map<string, AtlasEdge>;
  boundaries: BoundaryFinding[];
  positions: [number, string][];
}

export function analyzeTypeScript(ctx: PluginContext): PluginResult {
  const { project, files, options } = ctx;
  const warnings: string[] = [];
  const timings: Record<string, number> = {};

  const nodes: AtlasNode[] = [];
  const edges = new Map<string, AtlasEdge>();
  const boundaries: BoundaryFinding[] = [];
  const registered: Registered = { byPosition: new Map(), names: new Set() };

  /**
   * Absolute POSIX path (lowercased) → repo-relative path, for import resolution.
   * Built from every file in the project, not only the ones being read this time: an
   * edited file importing an untouched one still has to resolve that import.
   */
  const pathToRel = new Map<string, string>();
  for (const ref of files) pathToRel.set(normPath(ref.absPath), ref.relPath);

  // ---- Pass 0: restore whatever has not changed -----------------------------
  const t0 = Date.now();
  const staleRefs: SourceFileRef[] = [];
  let reused = 0;
  for (const ref of files) {
    const slice = ctx.reuse?.get(ref.relPath);
    if (!slice) {
      staleRefs.push(ref);
      continue;
    }
    appendAll(nodes, slice.nodes);
    mergeEdges(edges, slice.edges);
    appendAll(boundaries, slice.boundaries);
    const posKey = normPath(ref.absPath);
    for (const [pos, id] of slice.positions) registered.byPosition.set(`${posKey}|${pos}`, id);
    for (const node of slice.nodes) {
      if (node.kind !== 'file') registered.names.add(node.name);
    }
    reused++;
  }
  timings.restore = Date.now() - t0;

  // ---- Load only what has to be read ----------------------------------------
  const t1 = Date.now();
  const tsProject = createProject(project.tsConfigPath);
  const buckets: Bucket[] = [];
  for (const ref of staleRefs) {
    try {
      buckets.push({
        ref,
        sf: tsProject.addSourceFileAtPath(toPosix(ref.absPath)),
        fileNode: null,
        nodes: [],
        edges: new Map(),
        boundaries: [],
        positions: [],
      });
    } catch (err) {
      const because = (err as Error).message;
      warnings.push(`Could not read ${ref.relPath}: ${because}`);
      // Still put it on the map. A file that silently vanishes takes its imports and
      // whatever check it declared with it, and the auth screen then reports the
      // routes that leaned on it as unprotected rather than as unexamined (#36).
      nodes.push(unreadFileNode(ref, because));
    }
  }
  timings.load = Date.now() - t1;

  // ---- Pass 1: declarations -------------------------------------------------
  const t2 = Date.now();
  let done = 0;
  for (const bucket of buckets) {
    const declared: Declared = { positions: [], names: [] };
    try {
      bucket.fileNode = extractFile(bucket.ref, bucket.sf, bucket.nodes, declared);
    } catch (err) {
      warnings.push(`Failed to analyze ${bucket.ref.relPath}: ${(err as Error).message}`);
    }
    bucket.positions = declared.positions;
    const posKey = normPath(bucket.ref.absPath);
    for (const [pos, id] of declared.positions) registered.byPosition.set(`${posKey}|${pos}`, id);
    for (const name of declared.names) registered.names.add(name);
    if (++done % 25 === 0) ctx.onProgress?.('Reading files', done, buckets.length);
  }
  if (buckets.length > 0) ctx.onProgress?.('Reading files', buckets.length, buckets.length);
  timings.declarations = Date.now() - t2;

  // ---- Pass 2: imports ------------------------------------------------------
  const t3 = Date.now();
  for (const bucket of buckets) {
    try {
      const { external, unresolved } = extractImports(bucket.ref, bucket.sf, pathToRel, bucket.edges);
      if (bucket.fileNode) {
        bucket.fileNode.meta.externalImports = external;
        if (unresolved.length > 0) bucket.fileNode.meta.unresolvedImports = unresolved;
      }
    } catch (err) {
      warnings.push(`Failed to read imports in ${bucket.ref.relPath}: ${(err as Error).message}`);
    }
  }
  timings.imports = Date.now() - t3;

  // ---- Pass 3: references ---------------------------------------------------
  if (options.followReferences) {
    const t4 = Date.now();
    done = 0;
    for (const bucket of buckets) {
      try {
        extractReferences(bucket.ref, bucket.sf, registered, bucket.edges);
      } catch (err) {
        warnings.push(`Failed to trace references in ${bucket.ref.relPath}: ${(err as Error).message}`);
      }
      if (++done % 25 === 0) ctx.onProgress?.('Tracing references', done, buckets.length);
    }
    if (buckets.length > 0) ctx.onProgress?.('Tracing references', buckets.length, buckets.length);
    timings.references = Date.now() - t4;
  }

  // ---- Pass 4: boundaries ---------------------------------------------------
  if (options.detectBoundaries) {
    const t5 = Date.now();
    done = 0;
    for (const bucket of buckets) {
      const posKey = normPath(bucket.ref.absPath);
      const fileId = makeFileId(bucket.ref.relPath);
      try {
        bucket.boundaries.push(
          ...detectBoundaries({
            ref: bucket.ref,
            sf: bucket.sf,
            fileId,
            project,
            signals: project.signals,
            enclosing: (node) => declaredNodeId(node, posKey, registered, fileId),
          }),
        );
      } catch (err) {
        warnings.push(`Failed to read boundaries in ${bucket.ref.relPath}: ${(err as Error).message}`);
      }
      if (++done % 25 === 0) ctx.onProgress?.('Finding the boundaries', done, buckets.length);
    }
    if (buckets.length > 0) ctx.onProgress?.('Finding the boundaries', buckets.length, buckets.length);
    timings.boundaries = Date.now() - t5;
  }

  // ---- Fold the fresh files back in, and keep a slice of each ---------------
  const slices: FileSlice[] = [];
  for (const bucket of buckets) {
    const sliceEdges = [...bucket.edges.values()];
    slices.push({
      relPath: bucket.ref.relPath,
      hash: ctx.hashes?.get(bucket.ref.relPath) ?? bucket.fileNode?.hash ?? '',
      nodes: bucket.nodes,
      edges: sliceEdges,
      boundaries: bucket.boundaries,
      positions: bucket.positions,
      imports: sliceEdges
        .filter((edge) => edge.kind === 'imports')
        .map((edge) => edge.toId.slice(FILE_ID_PREFIX.length)),
    });
    appendAll(nodes, bucket.nodes);
    mergeEdges(edges, sliceEdges);
    appendAll(boundaries, bucket.boundaries);
  }

  return { nodes, edges: [...edges.values()], boundaries, warnings, timings, slices, reused };
}

function createProject(tsConfigPath: string | null): Project {
  const fallbackOptions = {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    strict: false,
    skipLibCheck: true,
  };
  if (tsConfigPath) {
    return new Project({
      tsConfigFilePath: toPosix(tsConfigPath),
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { noEmit: true, skipLibCheck: true, allowJs: true },
    });
  }
  return new Project({ useInMemoryFileSystem: false, compilerOptions: fallbackOptions });
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

/**
 * A file the compiler would not even open. It keeps its place on the map, marked, so
 * that everything downstream can tell "nothing to protect here" apart from "I never
 * got to look".
 */
function unreadFileNode(ref: SourceFileRef, because: string): AtlasNode {
  return {
    id: makeFileId(ref.relPath),
    kind: 'file',
    name: path.posix.basename(ref.relPath),
    label: null,
    parentId: null,
    language: 'typescript',
    path: ref.relPath,
    startLine: 1,
    endLine: 1,
    zone: ref.zone,
    summary: null,
    summarySource: null,
    docHash: null,
    bodyHash: null,
    hash: hashText(ref.relPath),
    provenance: 'static',
    meta: {
      ext: extOf(ref.relPath),
      loc: 0,
      externalImports: [],
      exportedNames: [],
      functionCount: 0,
      typeCount: 0,
      unread: because,
    },
  };
}

function extractFile(ref: SourceFileRef, sf: SourceFile, nodes: AtlasNode[], declared: Declared): AtlasNode {
  const fileId = makeFileId(ref.relPath);
  const text = sf.getFullText();
  const doc = extractFileDoc(text);

  const fileNode: AtlasNode = {
    id: fileId,
    kind: 'file',
    name: path.posix.basename(ref.relPath),
    label: null,
    parentId: null, // filled in by the orchestrator once the module tree exists
    language: 'typescript',
    path: ref.relPath,
    startLine: 1,
    endLine: sf.getEndLineNumber(),
    zone: ref.zone,
    summary: doc,
    summarySource: doc ? 'docs' : null,
    docHash: doc ? hashText(doc) : null,
    bodyHash: hashText(text),
    hash: hashText(text),
    provenance: doc ? 'docs' : 'static',
    meta: {
      ext: extOf(ref.relPath),
      loc: countLines(text),
      externalImports: [],
      exportedNames: [],
      functionCount: 0,
      typeCount: 0,
    },
  };
  nodes.push(fileNode);

  const usedIds = new Set<string>();
  const exportedNames: string[] = [];
  let functionCount = 0;
  let typeCount = 0;

  const register = (id: string, ...positions: number[]) => {
    for (const pos of positions) declared.positions.push([pos, id]);
  };

  // --- functions ---
  for (const fn of sf.getFunctions()) {
    const name = fn.getName() ?? (fn.isDefaultExport() ? 'default' : '(anonymous)');
    const id = uniqueId(makeFunctionId(ref.relPath, name), usedIds);
    nodes.push(
      functionNode({
        id,
        name,
        fileId,
        ref,
        decl: fn,
        params: fn.getParameters(),
        returnType: typeTextOf(fn.getReturnTypeNode()?.getText(), () => fn.getReturnType(), fn),
        isAsync: fn.isAsync(),
        isExported: fn.isExported() || fn.isDefaultExport(),
        docText: jsDocOf(fn),
      }),
    );
    register(id, fn.getStart());
    declared.names.push(name);
    if (fn.isExported() || fn.isDefaultExport()) exportedNames.push(name);
    functionCount++;
  }

  // --- arrow / function-expression consts ---
  for (const decl of sf.getVariableDeclarations()) {
    const init = decl.getInitializer();
    if (!init || !(Node.isArrowFunction(init) || Node.isFunctionExpression(init))) continue;
    const fnExpr = init as ArrowFunction | FunctionExpression;
    const name = decl.getName();
    const statement = decl.getVariableStatement();
    const isExported = statement?.isExported() ?? false;
    const id = uniqueId(makeFunctionId(ref.relPath, name), usedIds);
    nodes.push(
      functionNode({
        id,
        name,
        fileId,
        ref,
        decl,
        params: fnExpr.getParameters(),
        returnType: typeTextOf(fnExpr.getReturnTypeNode()?.getText(), () => fnExpr.getReturnType(), fnExpr),
        isAsync: fnExpr.isAsync(),
        isExported,
        docText: statement ? jsDocOf(statement) : null,
      }),
    );
    // Both the variable declaration and the function body should map to this node.
    register(id, decl.getStart(), fnExpr.getStart());
    declared.names.push(name);
    if (isExported) exportedNames.push(name);
    functionCount++;
  }

  // --- service objects: an object literal whose properties are functions ---
  // `export const cellarService = { async getCellar() { … } }` is how a great deal
  // of real app code — especially agent-written code — organizes its data layer.
  // The object is not a class, but its methods are functions all the same, and a
  // map that skips them has a hole where the heart of the app should be.
  for (const decl of sf.getVariableDeclarations()) {
    let init = decl.getInitializer();
    while (init && (Node.isAsExpression(init) || Node.isSatisfiesExpression(init) || Node.isParenthesizedExpression(init))) {
      init = init.getExpression();
    }
    if (!init || !Node.isObjectLiteralExpression(init)) continue;
    const objName = decl.getName();
    const statement = decl.getVariableStatement();
    const isExported = statement?.isExported() ?? false;
    let sawFunction = false;

    for (const prop of init.getProperties()) {
      if (Node.isMethodDeclaration(prop)) {
        const methodName = prop.getName();
        const id = uniqueId(makeFunctionId(ref.relPath, `${objName}.${methodName}`), usedIds);
        nodes.push(
          functionNode({
            id,
            name: methodName,
            fileId,
            ref,
            decl: prop,
            params: prop.getParameters(),
            returnType: typeTextOf(prop.getReturnTypeNode()?.getText(), () => prop.getReturnType(), prop),
            isAsync: prop.isAsync(),
            isExported,
            docText: jsDocOf(prop),
            isMethod: true,
            ownerName: objName,
          }),
        );
        register(id, prop.getStart());
        declared.names.push(methodName);
        functionCount++;
        sawFunction = true;
      } else if (Node.isPropertyAssignment(prop)) {
        const inner = prop.getInitializer();
        if (!inner || !(Node.isArrowFunction(inner) || Node.isFunctionExpression(inner))) continue;
        const fnExpr = inner as ArrowFunction | FunctionExpression;
        const methodName = prop.getName();
        const id = uniqueId(makeFunctionId(ref.relPath, `${objName}.${methodName}`), usedIds);
        nodes.push(
          functionNode({
            id,
            name: methodName,
            fileId,
            ref,
            decl: prop,
            params: fnExpr.getParameters(),
            returnType: typeTextOf(fnExpr.getReturnTypeNode()?.getText(), () => fnExpr.getReturnType(), fnExpr),
            isAsync: fnExpr.isAsync(),
            isExported,
            docText: jsDocOf(prop),
            isMethod: true,
            ownerName: objName,
          }),
        );
        // Both the property and the function body should map to this node.
        register(id, prop.getStart(), fnExpr.getStart());
        declared.names.push(methodName);
        functionCount++;
        sawFunction = true;
      }
    }

    // The object itself only earns a mention when it turned out to be a service —
    // a bag of plain constants stays out of the export list, as before.
    if (sawFunction && isExported) exportedNames.push(objName);
  }

  // --- classes (a type node, with its methods as function nodes inside) ---
  for (const cls of sf.getClasses()) {
    const name = cls.getName() ?? 'default';
    const id = uniqueId(makeTypeId(ref.relPath, name), usedIds);
    nodes.push(classNode(id, name, fileId, ref, cls));
    register(id, cls.getStart());
    declared.names.push(name);
    if (cls.isExported() || cls.isDefaultExport()) exportedNames.push(name);
    typeCount++;

    for (const method of cls.getMethods()) {
      const methodName = method.getName();
      const methodId = uniqueId(makeFunctionId(ref.relPath, `${name}.${methodName}`), usedIds);
      nodes.push(
        functionNode({
          id: methodId,
          name: methodName,
          fileId: id,
          ref,
          decl: method,
          params: method.getParameters(),
          returnType: typeTextOf(method.getReturnTypeNode()?.getText(), () => method.getReturnType(), method),
          isAsync: method.isAsync(),
          isExported: cls.isExported(),
          docText: jsDocOf(method),
          isMethod: true,
          ownerName: name,
        }),
      );
      register(methodId, method.getStart());
      declared.names.push(methodName);
      functionCount++;
    }
  }

  // --- interfaces / type aliases / enums ---
  for (const iface of sf.getInterfaces()) {
    const name = iface.getName();
    const id = uniqueId(makeTypeId(ref.relPath, name), usedIds);
    nodes.push(interfaceNode(id, name, fileId, ref, iface));
    register(id, iface.getStart());
    declared.names.push(name);
    if (iface.isExported()) exportedNames.push(name);
    typeCount++;
  }

  for (const alias of sf.getTypeAliases()) {
    const name = alias.getName();
    const id = uniqueId(makeTypeId(ref.relPath, name), usedIds);
    nodes.push(typeAliasNode(id, name, fileId, ref, alias));
    register(id, alias.getStart());
    declared.names.push(name);
    if (alias.isExported()) exportedNames.push(name);
    typeCount++;
  }

  for (const enumDecl of sf.getEnums()) {
    const name = enumDecl.getName();
    const id = uniqueId(makeTypeId(ref.relPath, name), usedIds);
    nodes.push(enumNode(id, name, fileId, ref, enumDecl));
    register(id, enumDecl.getStart());
    declared.names.push(name);
    if (enumDecl.isExported()) exportedNames.push(name);
    typeCount++;
  }

  fileNode.meta.exportedNames = exportedNames.sort();
  fileNode.meta.functionCount = functionCount;
  fileNode.meta.typeCount = typeCount;
  return fileNode;
}

interface FunctionNodeInput {
  id: string;
  name: string;
  fileId: string;
  ref: SourceFileRef;
  decl: FunctionDeclaration | VariableDeclaration | MethodDeclaration | PropertyAssignment;
  params: ParameterDeclaration[];
  returnType: string;
  isAsync: boolean;
  isExported: boolean;
  docText: string | null;
  isMethod?: boolean;
  ownerName?: string;
}

function functionNode(input: FunctionNodeInput): AtlasNode {
  const params = input.params.map(paramInfo);
  const signature = `${input.name}(${params
    .map((p) => `${p.rest ? '...' : ''}${p.name}${p.optional ? '?' : ''}: ${p.type}`)
    .join(', ')}): ${input.returnType}`;
  const bodyText = input.decl.getText();

  return {
    id: input.id,
    kind: 'function',
    name: input.name,
    label: null,
    parentId: input.fileId,
    language: 'typescript',
    path: input.ref.relPath,
    startLine: input.decl.getStartLineNumber(),
    endLine: input.decl.getEndLineNumber(),
    zone: input.ref.zone,
    summary: input.docText,
    summarySource: input.docText ? 'docs' : null,
    docHash: input.docText ? hashText(input.docText) : null,
    bodyHash: hashText(bodyText),
    hash: hashParts(signature, bodyText),
    provenance: input.docText ? 'docs' : 'static',
    meta: {
      signature,
      params,
      returnType: input.returnType,
      isAsync: input.isAsync,
      isExported: input.isExported,
      isMethod: input.isMethod ?? false,
      ownerName: input.ownerName,
      loc: input.decl.getEndLineNumber() - input.decl.getStartLineNumber() + 1,
    },
  };
}

function interfaceNode(
  id: string,
  name: string,
  fileId: string,
  ref: SourceFileRef,
  iface: InterfaceDeclaration,
): AtlasNode {
  const fields: FieldInfo[] = iface.getProperties().map((p) => ({
    name: p.getName(),
    type: typeTextOf(p.getTypeNode()?.getText(), () => p.getType(), p),
    optional: p.hasQuestionToken(),
  }));
  const doc = jsDocOf(iface);
  return typeNode({
    id,
    name,
    fileId,
    ref,
    decl: iface,
    typeKind: 'interface',
    fields,
    isExported: iface.isExported(),
    extendsList: iface.getExtends().map((e) => e.getText()),
    doc,
  });
}

function classNode(id: string, name: string, fileId: string, ref: SourceFileRef, cls: ClassDeclaration): AtlasNode {
  const fields: FieldInfo[] = cls.getProperties().map((p) => ({
    name: p.getName(),
    type: typeTextOf(p.getTypeNode()?.getText(), () => p.getType(), p),
    optional: p.hasQuestionToken(),
  }));
  const extendsList: string[] = [];
  const base = cls.getExtends();
  if (base) extendsList.push(base.getText());
  for (const impl of cls.getImplements()) extendsList.push(impl.getText());
  return typeNode({
    id,
    name,
    fileId,
    ref,
    decl: cls,
    typeKind: 'class',
    fields,
    isExported: cls.isExported() || cls.isDefaultExport(),
    extendsList,
    doc: jsDocOf(cls),
  });
}

function typeAliasNode(
  id: string,
  name: string,
  fileId: string,
  ref: SourceFileRef,
  alias: TypeAliasDeclaration,
): AtlasNode {
  const typeNodeRef = alias.getTypeNode();
  const fields: FieldInfo[] = [];
  if (typeNodeRef && Node.isTypeLiteral(typeNodeRef)) {
    for (const member of typeNodeRef.getMembers()) {
      if (Node.isPropertySignature(member)) {
        fields.push({
          name: member.getName(),
          type: typeTextOf(member.getTypeNode()?.getText(), () => member.getType(), member),
          optional: member.hasQuestionToken(),
        });
      }
    }
  }
  const node = typeNode({
    id,
    name,
    fileId,
    ref,
    decl: alias,
    typeKind: 'type-alias',
    fields,
    isExported: alias.isExported(),
    extendsList: [],
    doc: jsDocOf(alias),
  });
  if (fields.length === 0 && typeNodeRef) {
    node.meta.aliasOf = truncate(typeNodeRef.getText(), MAX_TYPE_TEXT);
  }
  return node;
}

function enumNode(id: string, name: string, fileId: string, ref: SourceFileRef, decl: EnumDeclaration): AtlasNode {
  const fields: FieldInfo[] = decl.getMembers().map((m) => ({
    name: m.getName(),
    type: String(m.getValue() ?? ''),
    optional: false,
  }));
  return typeNode({
    id,
    name,
    fileId,
    ref,
    decl,
    typeKind: 'enum',
    fields,
    isExported: decl.isExported(),
    extendsList: [],
    doc: jsDocOf(decl),
  });
}

interface TypeNodeInput {
  id: string;
  name: string;
  fileId: string;
  ref: SourceFileRef;
  decl: InterfaceDeclaration | TypeAliasDeclaration | EnumDeclaration | ClassDeclaration;
  typeKind: 'interface' | 'type-alias' | 'enum' | 'class';
  fields: FieldInfo[];
  isExported: boolean;
  extendsList: string[];
  doc: string | null;
}

function typeNode(input: TypeNodeInput): AtlasNode {
  const bodyText = input.decl.getText();
  return {
    id: input.id,
    kind: 'type',
    name: input.name,
    label: null,
    parentId: input.fileId,
    language: 'typescript',
    path: input.ref.relPath,
    startLine: input.decl.getStartLineNumber(),
    endLine: input.decl.getEndLineNumber(),
    zone: input.ref.zone,
    summary: input.doc,
    summarySource: input.doc ? 'docs' : null,
    docHash: input.doc ? hashText(input.doc) : null,
    bodyHash: hashText(bodyText),
    hash: hashText(bodyText),
    provenance: input.doc ? 'docs' : 'static',
    meta: {
      typeKind: input.typeKind,
      fields: input.fields,
      isExported: input.isExported,
      extends: input.extendsList,
    },
  };
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

/**
 * Returns the packages this file imports, and the project-internal specifiers that
 * could not be resolved; the file-to-file edges go into `edges`.
 *
 * The second list is the more interesting one. `@/auth/login` is a path alias, defined
 * in a tsconfig or a bundler config that may sit somewhere this run never looked, and
 * when it does not resolve the link between two of the project's own files silently
 * disappears — leaving the file on the far end looking as though nothing points at it.
 * Recording the specifier turns an invisible gap into a fact anything downstream can
 * see and refuse to answer over.
 */
function extractImports(
  ref: SourceFileRef,
  sf: SourceFile,
  pathToRel: Map<string, string>,
  edges: Map<string, AtlasEdge>,
): { external: string[]; unresolved: string[] } {
  const fromId = makeFileId(ref.relPath);
  const external = new Set<string>();
  const unresolved = new Set<string>();

  const record = (specifier: string, targetFile: SourceFile | undefined, symbols: string[]) => {
    if (targetFile) {
      const targetRel = pathToRel.get(normPath(targetFile.getFilePath()));
      if (targetRel && targetRel !== ref.relPath) {
        addEdge(edges, {
          kind: 'imports',
          fromId,
          toId: makeFileId(targetRel),
          weight: Math.max(1, symbols.length),
          confidence: 'certain',
          meta: { symbols },
        });
        return;
      }
    }
    if (isPathAlias(specifier)) unresolved.add(specifier);
    if (isBareSpecifier(specifier)) external.add(packageNameOf(specifier));
  };

  for (const imp of sf.getImportDeclarations()) {
    const symbols: string[] = [];
    const def = imp.getDefaultImport();
    if (def) symbols.push(def.getText());
    const ns = imp.getNamespaceImport();
    if (ns) symbols.push(`* as ${ns.getText()}`);
    for (const named of imp.getNamedImports()) symbols.push(named.getName());
    record(imp.getModuleSpecifierValue(), imp.getModuleSpecifierSourceFile(), symbols);
  }

  for (const exp of sf.getExportDeclarations()) {
    const specifier = exp.getModuleSpecifierValue();
    if (!specifier) continue;
    const symbols = exp.getNamedExports().map((n) => n.getName());
    record(specifier, exp.getModuleSpecifierSourceFile(), symbols);
  }

  for (const literal of sf.getImportStringLiterals()) {
    const call = literal.getParent();
    if (!call || !Node.isCallExpression(call)) continue;
    if (call.getExpression().getKind() !== SyntaxKind.ImportKeyword) continue;
    const specifier = literal.getLiteralValue();
    const targetRel = resolveRelative(ref.absPath, specifier, pathToRel);
    if (targetRel && targetRel !== ref.relPath) {
      addEdge(edges, {
        kind: 'imports',
        fromId,
        toId: makeFileId(targetRel),
        weight: 1,
        // The specifier is a literal and the file it names is in this project. Nothing
        // is being guessed at; it is the same fact a static import states, written in
        // the syntax that defers the load.
        confidence: 'certain',
        meta: { symbols: [] },
      });
    } else {
      if (isPathAlias(specifier)) unresolved.add(specifier);
      if (isBareSpecifier(specifier)) external.add(packageNameOf(specifier));
    }
  }

  return { external: [...external].sort(), unresolved: [...unresolved].sort() };
}

/** Extensions that are a module somebody could have imported code from. */
const MODULE_SPECIFIER_EXT = /\.([cm]?[jt]sx?|vue|svelte|astro)$/;

/**
 * Whether an unresolved specifier names something inside this project rather than a
 * package.
 *
 * `@/`, `~`, and `#` cannot begin a real package name — npm forbids the first two
 * outright and `#` is Node's own subpath-imports prefix — so a specifier starting with
 * one of them is always an alias for a path in the repo. If it did not resolve, a link
 * between two of this project's files is missing from the graph.
 *
 * A stylesheet or an image behind the same alias is not that. It never was a module,
 * nothing was ever going to link to it, and counting it would condemn every well-built
 * Next.js app that imports its own CSS through `@/styles`.
 */
function isPathAlias(specifier: string): boolean {
  if (!/^(@\/|~|#)/.test(specifier)) return false;
  const ext = /\.[a-z0-9]+$/i.exec(specifier);
  return ext === null || MODULE_SPECIFIER_EXT.test(specifier);
}

/**
 * The file a relative specifier names, or null when it names nothing in this project.
 *
 * Only for `import('./x')`, which the import *declarations* above never mention and
 * which is how half of modern JavaScript loads a route, a CLI subcommand or a lazy
 * component. Missing them leaves those files looking as though nothing points at them,
 * and something that is only ever loaded lazily is exactly the thing somebody would
 * then be told they could delete.
 *
 * Resolution is done by hand rather than through the compiler because the answer only
 * has to be right for a literal relative path — a specifier built from a variable is
 * unresolvable by anybody and is left alone rather than approximated.
 */
function resolveRelative(fromAbs: string, specifier: string, pathToRel: Map<string, string>): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromAbs), specifier);
  const candidates = [base];
  // `./x.js` in an ESM project is `./x.ts` on disk — the extension is what the output
  // will be called, not what was written.
  const rewritten = base.replace(/\.([cm]?)js(x?)$/, '.$1ts$2');
  if (rewritten !== base) candidates.push(rewritten);
  for (const ext of ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']) {
    candidates.push(`${base}${ext}`, path.join(base, `index${ext}`));
  }
  for (const candidate of candidates) {
    const found = pathToRel.get(normPath(candidate));
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

/**
 * Walks every identifier in the file and asks the checker what it resolves to. When
 * the answer is a declaration we already have a node for, we record a `references`
 * edge from the enclosing function (or the file) to that declaration.
 *
 * This is deliberately not a call graph — it is "who mentions whom", which is what
 * the local-graph view needs and what the checker can answer without guessing.
 */
function extractReferences(
  ref: SourceFileRef,
  sf: SourceFile,
  registered: Registered,
  edges: Map<string, AtlasEdge>,
): void {
  const fileId = makeFileId(ref.relPath);
  const posKey = normPath(ref.absPath);

  sf.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.Identifier) return;
    const identifier = node as Identifier;
    const text = identifier.getText();
    if (!registered.names.has(text)) return;

    let symbol = identifier.getSymbol();
    if (!symbol) return;
    const aliased = symbol.getAliasedSymbol();
    if (aliased) symbol = aliased;

    let targetId: string | undefined;
    for (const decl of symbol.getDeclarations()) {
      const declPosKey = normPath(decl.getSourceFile().getFilePath());
      targetId = registered.byPosition.get(`${declPosKey}|${decl.getStart()}`);
      if (targetId) break;
    }
    if (!targetId) return;

    const { id: fromId, field } = enclosingNodeId(identifier, posKey, registered, fileId);
    if (fromId === targetId) return;

    addEdge(edges, {
      kind: 'references',
      fromId,
      toId: targetId,
      weight: 1,
      confidence: 'certain',
      meta: field ? { fields: [field] } : {},
    });
  });
}

/**
 * Which atlas node contains this identifier — and, when the identifier is the *type
 * of a field*, which field that is.
 *
 * The field name is what makes the type explorer readable: without it an edge says
 * "Order mentions User somewhere", with it the card can draw a line out of the row
 * that actually holds the reference, which is the whole dbdiagram trick (SPEC.md 6.3).
 */
function enclosingNodeId(
  node: Node,
  posKey: string,
  registered: Registered,
  fallback: string,
): { id: string; field: string | null } {
  let field: string | null = null;
  let previous: Node = node;
  let current: Node | undefined = node.getParent();
  while (current) {
    const hit = registered.byPosition.get(`${posKey}|${current.getStart()}`);
    if (hit) return { id: hit, field };
    // Only an annotation counts. A property *initializer* that happens to call
    // something is not that property pointing at a type.
    if (isFieldLike(current) && current.getTypeNode() === previous) field = current.getName();
    previous = current;
    current = current.getParent();
  }
  return { id: fallback, field };
}

function isFieldLike(node: Node): node is PropertySignature | PropertyDeclaration {
  return Node.isPropertySignature(node) || Node.isPropertyDeclaration(node);
}

/**
 * Like `enclosingNodeId`, but a declaration maps to itself. Boundary detectors hand us
 * the declaration of a route handler directly, and "which function is this" should
 * answer "that one" rather than walking past it to its parent.
 */
function declaredNodeId(node: Node, posKey: string, registered: Registered, fallback: string): string {
  let current: Node | undefined = node;
  while (current) {
    const hit = registered.byPosition.get(`${posKey}|${current.getStart()}`);
    if (hit) return hit;
    current = current.getParent();
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    // `symbols` is what an import brought in; `fields` is which properties made a
    // type point at another type. Both are sets that grow as the edge is seen again.
    for (const key of ['symbols', 'fields'] as const) {
      const added = (input.meta[key] as string[] | undefined) ?? [];
      if (added.length === 0) continue;
      const already = (existing.meta[key] as string[] | undefined) ?? [];
      existing.meta[key] = [...new Set([...already, ...added])];
    }
    return;
  }
  edges.set(id, {
    id,
    kind: input.kind,
    fromId: input.fromId,
    toId: input.toId,
    weight: input.weight,
    confidence: input.confidence,
    provenance: 'static',
    meta: input.meta,
  });
}

/**
 * Folds one file's edges into the project-wide set.
 *
 * In practice nothing ever collides: every edge a file produces starts inside that
 * file, so no two files can claim the same one. It still goes through `addEdge` rather
 * than a plain assignment, so that if that ever stops being true the result is a merged
 * edge and not a silently discarded one.
 */
function mergeEdges(target: Map<string, AtlasEdge>, incoming: Iterable<AtlasEdge>): void {
  for (const edge of incoming) {
    addEdge(target, {
      kind: edge.kind,
      fromId: edge.fromId,
      toId: edge.toId,
      weight: edge.weight,
      confidence: edge.confidence,
      meta: edge.meta,
    });
  }
}

function paramInfo(param: ParameterDeclaration): ParamInfo {
  return {
    name: param.getName(),
    type: typeTextOf(param.getTypeNode()?.getText(), () => param.getType(), param),
    optional: param.hasQuestionToken() || param.hasInitializer(),
    rest: param.isRestParameter(),
  };
}

/**
 * Prefers the type as the developer wrote it (stable, short, familiar) and only asks
 * the checker to infer when there is no annotation.
 */
function typeTextOf(written: string | undefined, infer: () => Type, at: Node): string {
  if (written && written.trim()) return truncate(written.trim(), MAX_TYPE_TEXT);
  try {
    return truncate(infer().getText(at), MAX_TYPE_TEXT);
  } catch {
    return 'unknown';
  }
}

function jsDocOf(node: Node): string | null {
  const docs = (node as unknown as { getJsDocs?: () => { getDescription(): string }[] }).getJsDocs?.();
  if (!docs || docs.length === 0) return null;
  const text = unixLines(docs[docs.length - 1].getDescription()).trim();
  return text.length > 0 ? text : null;
}

/**
 * A docstring written on Windows arrives with its carriage returns still attached, and
 * the panel that shows it sets `white-space: pre-wrap` — where a browser treats a lone
 * `\r` as another line break. Every paragraph in every docstring came out double-spaced
 * on half the machines this tool runs on. The line ending is not part of the sentence.
 */
function unixLines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * Pulls a file-level docstring out of the top of a file. Only counts it when it is
 * explicitly tagged (`@fileoverview`, `@file`, `@module`) or clearly sits above the
 * imports — otherwise we would mistake the first function's JSDoc for a file summary.
 */
export function extractFileDoc(text: string): string | null {
  const head = text.slice(0, 4000);
  const match = /\/\*\*([\s\S]*?)\*\//.exec(head);
  if (!match || match.index === undefined) return null;
  const before = head.slice(0, match.index);
  if (/[^\s]/.test(before.replace(/^#!.*$/m, '').replace(/\/\/[^\n]*/g, ''))) return null;

  const raw = match[1];
  const tagged = /@(fileoverview|file|module)\b/.test(raw);
  const after = head.slice(match.index + match[0].length).trimStart();
  const aboveImports = /^(import\b|export\b|['"]use (client|server|strict)['"])/.test(after);
  if (!tagged && !aboveImports) return null;

  const cleaned = unixLines(raw)
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, ''))
    .join('\n')
    .replace(/@(fileoverview|file|module)\s*/g, '')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

function uniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let n = 2;
  while (used.has(`${base}~${n}`)) n++;
  const id = `${base}~${n}`;
  used.add(id);
  return id;
}

function normPath(p: string): string {
  return toPosix(p).toLowerCase();
}

function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('#');
}

/** `@scope/pkg/sub` → `@scope/pkg`; `pkg/sub` → `pkg`. */
function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function countLines(text: string): number {
  let count = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++;
  return count;
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}
