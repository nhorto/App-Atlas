/**
 * @fileoverview The atlas store.
 *
 * SQLite via Node's built-in `node:sqlite` — no native dependency, so `npx app-atlas`
 * never has to compile anything on a user's machine. The database is the source of
 * truth; the JSON export beside it is what agents and the web app read.
 *
 * The atlas itself is rewritten whole on every run. Two tables deliberately outlive
 * that snapshot — the generated explanations and the per-file analysis cache — because
 * both are keyed by the content they describe rather than by the run that wrote them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync, gzipSync } from 'node:zlib';
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,
  name           TEXT NOT NULL,
  label          TEXT,
  parent_id      TEXT,
  language       TEXT,
  path           TEXT,
  start_line     INTEGER,
  end_line       INTEGER,
  zone           TEXT NOT NULL,
  summary        TEXT,
  summary_source TEXT,
  doc_hash       TEXT,
  body_hash      TEXT,
  hash           TEXT NOT NULL,
  provenance     TEXT NOT NULL,
  meta           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_nodes_kind   ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_path   ON nodes(path);

CREATE TABLE IF NOT EXISTS edges (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  from_id    TEXT NOT NULL,
  to_id      TEXT NOT NULL,
  weight     INTEGER NOT NULL,
  confidence TEXT NOT NULL,
  provenance TEXT NOT NULL,
  meta       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
CREATE INDEX IF NOT EXISTS idx_edges_to   ON edges(to_id);
CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);

-- Generated explanations, keyed by the content they describe rather than by node id.
-- This table deliberately outlives the snapshot above: nodes and edges are rewritten
-- on every analysis, but an explanation of code that has not changed is still true,
-- and re-generating it would charge the user twice for the same sentence.
CREATE TABLE IF NOT EXISTS explanations (
  key        TEXT PRIMARY KEY,
  node_id    TEXT NOT NULL,
  tier       TEXT NOT NULL,
  hash       TEXT NOT NULL,
  text       TEXT NOT NULL,
  backend    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- One row per source file: everything that file contributed to the last atlas, stored
-- under a hash of its text so an unedited file is never parsed again. The hash and the
-- import list sit in their own columns because deciding what to re-analyze must not
-- cost a decompression of every payload in the project.
CREATE TABLE IF NOT EXISTS file_cache (
  rel_path    TEXT PRIMARY KEY,
  hash        TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  imports     TEXT NOT NULL,
  payload     BLOB NOT NULL
);
`;
/** Where an analyzed project keeps its atlas. */
export function atlasDir(root) {
    return path.join(root, '.app-atlas');
}
/**
 * Creates the atlas directory, and keeps it out of the project's version control.
 *
 * The atlas is a derived artifact — a few megabytes rebuilt from source on demand — so
 * it has no business showing up in someone's `git status` the first time they try the
 * tool. Ignoring from the inside means never editing a `.gitignore` the project owns;
 * the `*` covers this file too, so the directory disappears completely.
 *
 * Written only when absent, so deleting it is a durable way to say "I want to commit
 * this after all".
 */
export function ensureAtlasDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const ignoreFile = path.join(dir, '.gitignore');
    try {
        if (!fs.existsSync(ignoreFile))
            fs.writeFileSync(ignoreFile, '*\n', 'utf8');
    }
    catch {
        // A read-only checkout is not a reason to fail the analysis.
    }
}
export function atlasDbPath(root) {
    return path.join(atlasDir(root), 'atlas.db');
}
export function atlasJsonPath(root) {
    return path.join(atlasDir(root), 'atlas.json');
}
/**
 * The list of apps in a monorepo, written at the workspace root.
 *
 * Only the list lives here. Each scope keeps its own atlas and its own cache inside its
 * own directory, so analyzing one package on its own is the same operation as analyzing
 * a single-app repo — the manifest is the only thing that knows they are related.
 */
export function scopesPath(root) {
    return path.join(atlasDir(root), 'scopes.json');
}
export function writeScopes(root, scopes) {
    const file = scopesPath(root);
    ensureAtlasDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify({ scopes }, null, 2), 'utf8');
}
export function readScopes(root) {
    try {
        const parsed = JSON.parse(fs.readFileSync(scopesPath(root), 'utf8'));
        return Array.isArray(parsed.scopes) ? parsed.scopes : [];
    }
    catch {
        return [];
    }
}
export class AtlasStore {
    db;
    constructor(db) {
        this.db = db;
    }
    static open(dbPath) {
        ensureAtlasDir(path.dirname(dbPath));
        const db = new DatabaseSync(dbPath);
        db.exec('PRAGMA journal_mode = WAL;');
        db.exec(SCHEMA);
        return new AtlasStore(db);
    }
    /** Replaces the entire atlas in one transaction. */
    write(atlas) {
        const insertNode = this.db.prepare(`INSERT INTO nodes (id, kind, name, label, parent_id, language, path, start_line, end_line,
                          zone, summary, summary_source, doc_hash, body_hash, hash, provenance, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const insertEdge = this.db.prepare(`INSERT INTO edges (id, kind, from_id, to_id, weight, confidence, provenance, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
        const insertMeta = this.db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`);
        this.db.exec('BEGIN');
        try {
            this.db.exec('DELETE FROM nodes');
            this.db.exec('DELETE FROM edges');
            for (const n of atlas.nodes) {
                insertNode.run(n.id, n.kind, n.name, n.label, n.parentId, n.language, n.path, n.startLine, n.endLine, n.zone, n.summary, n.summarySource, n.docHash, n.bodyHash, n.hash, n.provenance, JSON.stringify(n.meta ?? {}));
            }
            for (const e of atlas.edges) {
                insertEdge.run(e.id, e.kind, e.fromId, e.toId, e.weight, e.confidence, e.provenance, JSON.stringify(e.meta ?? {}));
            }
            insertMeta.run('atlas', JSON.stringify(atlas.meta));
            this.db.exec('COMMIT');
        }
        catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }
    /** Every cached explanation, by cache key. */
    readExplanations() {
        const rows = this.db.prepare('SELECT * FROM explanations').all();
        const out = new Map();
        for (const row of rows) {
            out.set(row.key, {
                nodeId: row.node_id,
                tier: row.tier,
                hash: row.hash,
                text: row.text,
                backend: row.backend,
                createdAt: row.created_at,
            });
        }
        return out;
    }
    writeExplanations(entries) {
        if (entries.size === 0)
            return;
        const insert = this.db.prepare(`INSERT OR REPLACE INTO explanations (key, node_id, tier, hash, text, backend, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`);
        this.db.exec('BEGIN');
        try {
            for (const [key, entry] of entries) {
                insert.run(key, entry.nodeId, entry.tier, entry.hash, entry.text, entry.backend, entry.createdAt);
            }
            this.db.exec('COMMIT');
        }
        catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }
    /** Throws away every generated explanation. Behind `--refresh-ai`. */
    clearExplanations() {
        this.db.exec('DELETE FROM explanations');
    }
    /**
     * The cheap half of the cache: which files were analyzed, under what hash, and what
     * they import. Rows written under a different fingerprint are ignored rather than
     * deleted — the next write prunes them, and a run that crashes leaves nothing broken.
     */
    readSliceIndex(fingerprint) {
        const rows = this.db
            .prepare('SELECT rel_path, hash, imports FROM file_cache WHERE fingerprint = ?')
            .all(fingerprint);
        const out = new Map();
        for (const row of rows) {
            out.set(row.rel_path, { hash: row.hash, imports: safeParseArray(row.imports) });
        }
        return out;
    }
    /** The expensive half: the payloads themselves, for the files we decided to reuse. */
    readSlicePayloads(relPaths) {
        const out = new Map();
        if (relPaths.length === 0)
            return out;
        const select = this.db.prepare('SELECT payload FROM file_cache WHERE rel_path = ?');
        for (const relPath of relPaths) {
            const row = select.get(relPath);
            if (!row)
                continue;
            try {
                out.set(relPath, gunzipSync(row.payload).toString('utf8'));
            }
            catch {
                /* a corrupt row is a cache miss, not a failure */
            }
        }
        return out;
    }
    /**
     * Replaces the cache with exactly what this run knows about. `keep` is every file
     * still in the project, so deleted files drop out rather than lingering forever.
     */
    writeSlices(fingerprint, rows, keep) {
        const insert = this.db.prepare(`INSERT OR REPLACE INTO file_cache (rel_path, hash, fingerprint, imports, payload)
       VALUES (?, ?, ?, ?, ?)`);
        const existing = this.db.prepare('SELECT rel_path FROM file_cache').all();
        const remove = this.db.prepare('DELETE FROM file_cache WHERE rel_path = ?');
        this.db.exec('BEGIN');
        try {
            for (const row of rows) {
                insert.run(row.relPath, row.hash, fingerprint, JSON.stringify(row.imports), gzipSync(row.json));
            }
            for (const row of existing) {
                if (!keep.has(row.rel_path))
                    remove.run(row.rel_path);
            }
            this.db.exec('COMMIT');
        }
        catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }
    /** Throws away the per-file cache. Behind `--fresh`. */
    clearSlices() {
        this.db.exec('DELETE FROM file_cache');
    }
    read() {
        const metaRow = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('atlas');
        if (!metaRow)
            return null;
        const meta = JSON.parse(metaRow.value);
        const nodes = this.db.prepare('SELECT * FROM nodes').all().map(rowToNode);
        const edges = this.db.prepare('SELECT * FROM edges').all().map(rowToEdge);
        return { meta, nodes, edges };
    }
    close() {
        this.db.close();
    }
}
/** Writes both the database and the JSON export for a project. */
export function persistAtlas(root, atlas, extraJsonPath) {
    const dbPath = atlasDbPath(root);
    const store = AtlasStore.open(dbPath);
    try {
        store.write(atlas);
    }
    finally {
        store.close();
    }
    const jsonPath = atlasJsonPath(root);
    ensureAtlasDir(path.dirname(jsonPath));
    const json = JSON.stringify(atlas);
    fs.writeFileSync(jsonPath, json, 'utf8');
    if (extraJsonPath) {
        fs.mkdirSync(path.dirname(path.resolve(extraJsonPath)), { recursive: true });
        fs.writeFileSync(path.resolve(extraJsonPath), json, 'utf8');
    }
    return { dbPath, jsonPath };
}
/** Reads a previously written atlas, preferring the database. */
export function loadAtlas(root) {
    const dbPath = atlasDbPath(root);
    if (fs.existsSync(dbPath)) {
        const store = AtlasStore.open(dbPath);
        try {
            const atlas = store.read();
            if (atlas)
                return atlas;
        }
        finally {
            store.close();
        }
    }
    const jsonPath = atlasJsonPath(root);
    if (fs.existsSync(jsonPath)) {
        try {
            return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        }
        catch {
            return null;
        }
    }
    return null;
}
function rowToNode(row) {
    return {
        id: row.id,
        kind: row.kind,
        name: row.name,
        label: row.label,
        parentId: row.parent_id,
        language: row.language,
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        zone: row.zone,
        summary: row.summary,
        summarySource: row.summary_source,
        docHash: row.doc_hash,
        bodyHash: row.body_hash,
        hash: row.hash,
        provenance: row.provenance,
        meta: safeParse(row.meta),
    };
}
function rowToEdge(row) {
    return {
        id: row.id,
        kind: row.kind,
        fromId: row.from_id,
        toId: row.to_id,
        weight: row.weight,
        confidence: row.confidence,
        provenance: row.provenance,
        meta: safeParse(row.meta),
    };
}
function safeParse(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return {};
    }
}
function safeParseArray(text) {
    try {
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=store.js.map