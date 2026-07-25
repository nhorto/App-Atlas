/**
 * @fileoverview The atlas store.
 *
 * SQLite via Node's built-in `node:sqlite` — no native dependency, so `npx app-atlas`
 * never has to compile anything on a user's machine. The database is the source of
 * truth; the JSON export beside it is what agents and the web app read.
 *
 * M1 writes a full snapshot on every run. The per-node hashes are already stored so
 * that M5 can switch to incremental writes without a format change.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CachedExplanation } from '../enrich/types.js';
import type { Atlas, AtlasEdge, AtlasMeta, AtlasNode } from './types.js';

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
`;

/** Where an analyzed project keeps its atlas. */
export function atlasDir(root: string): string {
  return path.join(root, '.app-atlas');
}

export function atlasDbPath(root: string): string {
  return path.join(atlasDir(root), 'atlas.db');
}

export function atlasJsonPath(root: string): string {
  return path.join(atlasDir(root), 'atlas.json');
}

export class AtlasStore {
  private constructor(private readonly db: DatabaseSync) {}

  static open(dbPath: string): AtlasStore {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec(SCHEMA);
    return new AtlasStore(db);
  }

  /** Replaces the entire atlas in one transaction. */
  write(atlas: Atlas): void {
    const insertNode = this.db.prepare(
      `INSERT INTO nodes (id, kind, name, label, parent_id, language, path, start_line, end_line,
                          zone, summary, summary_source, doc_hash, body_hash, hash, provenance, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertEdge = this.db.prepare(
      `INSERT INTO edges (id, kind, from_id, to_id, weight, confidence, provenance, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertMeta = this.db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`);

    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM nodes');
      this.db.exec('DELETE FROM edges');
      for (const n of atlas.nodes) {
        insertNode.run(
          n.id,
          n.kind,
          n.name,
          n.label,
          n.parentId,
          n.language,
          n.path,
          n.startLine,
          n.endLine,
          n.zone,
          n.summary,
          n.summarySource,
          n.docHash,
          n.bodyHash,
          n.hash,
          n.provenance,
          JSON.stringify(n.meta ?? {}),
        );
      }
      for (const e of atlas.edges) {
        insertEdge.run(
          e.id,
          e.kind,
          e.fromId,
          e.toId,
          e.weight,
          e.confidence,
          e.provenance,
          JSON.stringify(e.meta ?? {}),
        );
      }
      insertMeta.run('atlas', JSON.stringify(atlas.meta));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Every cached explanation, by cache key. */
  readExplanations(): Map<string, CachedExplanation> {
    const rows = this.db.prepare('SELECT * FROM explanations').all() as unknown as ExplanationRow[];
    const out = new Map<string, CachedExplanation>();
    for (const row of rows) {
      out.set(row.key, {
        nodeId: row.node_id,
        tier: row.tier as CachedExplanation['tier'],
        hash: row.hash,
        text: row.text,
        backend: row.backend,
        createdAt: row.created_at,
      });
    }
    return out;
  }

  writeExplanations(entries: Map<string, CachedExplanation>): void {
    if (entries.size === 0) return;
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO explanations (key, node_id, tier, hash, text, backend, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec('BEGIN');
    try {
      for (const [key, entry] of entries) {
        insert.run(key, entry.nodeId, entry.tier, entry.hash, entry.text, entry.backend, entry.createdAt);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Throws away every generated explanation. Behind `--refresh-ai`. */
  clearExplanations(): void {
    this.db.exec('DELETE FROM explanations');
  }

  read(): Atlas | null {
    const metaRow = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('atlas') as unknown as
      | { value: string }
      | undefined;
    if (!metaRow) return null;
    const meta = JSON.parse(metaRow.value) as AtlasMeta;

    const nodes = (this.db.prepare('SELECT * FROM nodes').all() as unknown as NodeRow[]).map(rowToNode);
    const edges = (this.db.prepare('SELECT * FROM edges').all() as unknown as EdgeRow[]).map(rowToEdge);
    return { meta, nodes, edges };
  }

  close(): void {
    this.db.close();
  }
}

/** Writes both the database and the JSON export for a project. */
export function persistAtlas(root: string, atlas: Atlas, extraJsonPath?: string): { dbPath: string; jsonPath: string } {
  const dbPath = atlasDbPath(root);
  const store = AtlasStore.open(dbPath);
  try {
    store.write(atlas);
  } finally {
    store.close();
  }
  const jsonPath = atlasJsonPath(root);
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  const json = JSON.stringify(atlas);
  fs.writeFileSync(jsonPath, json, 'utf8');
  if (extraJsonPath) {
    fs.mkdirSync(path.dirname(path.resolve(extraJsonPath)), { recursive: true });
    fs.writeFileSync(path.resolve(extraJsonPath), json, 'utf8');
  }
  return { dbPath, jsonPath };
}

/** Reads a previously written atlas, preferring the database. */
export function loadAtlas(root: string): Atlas | null {
  const dbPath = atlasDbPath(root);
  if (fs.existsSync(dbPath)) {
    const store = AtlasStore.open(dbPath);
    try {
      const atlas = store.read();
      if (atlas) return atlas;
    } finally {
      store.close();
    }
  }
  const jsonPath = atlasJsonPath(root);
  if (fs.existsSync(jsonPath)) {
    try {
      return JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as Atlas;
    } catch {
      return null;
    }
  }
  return null;
}

interface NodeRow {
  id: string;
  kind: string;
  name: string;
  label: string | null;
  parent_id: string | null;
  language: string | null;
  path: string | null;
  start_line: number | null;
  end_line: number | null;
  zone: string;
  summary: string | null;
  summary_source: string | null;
  doc_hash: string | null;
  body_hash: string | null;
  hash: string;
  provenance: string;
  meta: string;
}

interface ExplanationRow {
  key: string;
  node_id: string;
  tier: string;
  hash: string;
  text: string;
  backend: string;
  created_at: string;
}

interface EdgeRow {
  id: string;
  kind: string;
  from_id: string;
  to_id: string;
  weight: number;
  confidence: string;
  provenance: string;
  meta: string;
}

function rowToNode(row: NodeRow): AtlasNode {
  return {
    id: row.id,
    kind: row.kind as AtlasNode['kind'],
    name: row.name,
    label: row.label,
    parentId: row.parent_id,
    language: row.language,
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    zone: row.zone as AtlasNode['zone'],
    summary: row.summary,
    summarySource: row.summary_source as AtlasNode['summarySource'],
    docHash: row.doc_hash,
    bodyHash: row.body_hash,
    hash: row.hash,
    provenance: row.provenance as AtlasNode['provenance'],
    meta: safeParse(row.meta),
  };
}

function rowToEdge(row: EdgeRow): AtlasEdge {
  return {
    id: row.id,
    kind: row.kind as AtlasEdge['kind'],
    fromId: row.from_id,
    toId: row.to_id,
    weight: row.weight,
    confidence: row.confidence as AtlasEdge['confidence'],
    provenance: row.provenance as AtlasEdge['provenance'],
    meta: safeParse(row.meta),
  };
}

function safeParse(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}
