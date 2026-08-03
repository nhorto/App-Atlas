/**
 * @fileoverview The other half of the Map: the folder tree, exactly as it is on disk.
 *
 * The Map's boxes are groups of folders under generated names, which answers "what are
 * the parts of this app". It does not answer "where is this on disk", and that is the
 * question somebody asks right before they go and open a file. Issue #94, in the words
 * of the person who hit it: *"I think we kind of need both, if I'm being honest."*
 *
 * So: no generated names anywhere in here, not even as a subtitle. Every string in this
 * panel is a name you can paste into a file search, which is the entire point of it.
 *
 * Children are fetched a folder at a time from the endpoint the detail panel already
 * uses. A whole-tree endpoint would be one more thing to keep correct, and a repo big
 * enough for this panel to matter is a repo you would not want to send in one response.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchNode } from '../api';
import type { AtlasNode } from '../types';

interface Props {
  rootId: string;
  /** The level the map is on, marked in the tree so the two views stay tied together. */
  levelId: string | null;
  onDrill: (id: string) => void;
  onReveal: (id: string) => void;
  onClose: () => void;
}

export function FolderTree({ rootId, levelId, onDrill, onReveal, onClose }: Props) {
  const [children, setChildren] = useState<Map<string, AtlasNode[]>>(new Map());
  const [open, setOpen] = useState<Set<string>>(new Set([rootId]));
  const [loading, setLoading] = useState<Set<string>>(new Set());
  /** Folders already asked for. Kept in a ref so the guard sees the answer immediately,
      rather than whatever state a render closure was built with. */
  const asked = useRef<Set<string>>(new Set());

  const load = useCallback(
    async (id: string) => {
      if (asked.current.has(id)) return;
      asked.current.add(id);
      setLoading((busy) => new Set(busy).add(id));
      try {
        const view = await fetchNode(id);
        const kept = view.children.filter((child) => child.kind === 'module' || child.kind === 'file');
        setChildren((known) => new Map(known).set(id, kept));
      } catch {
        setChildren((known) => new Map(known).set(id, []));
      } finally {
        setLoading((busy) => {
          const next = new Set(busy);
          next.delete(id);
          return next;
        });
      }
    },
    [],
  );

  useEffect(() => {
    void load(rootId);
  }, [load, rootId]);

  // Opening the panel while drilled in should show where you are, not the root with
  // everything shut. The chain is walked from the level's own breadcrumb, so every
  // ancestor is fetched exactly once and the row you are standing on is on screen.
  useEffect(() => {
    if (!levelId || levelId === rootId) return;
    let cancelled = false;
    void fetchNode(levelId).then((view) => {
      if (cancelled) return;
      const chain = view.breadcrumb.map((crumb) => crumb.id);
      setOpen((shown) => new Set([...shown, ...chain]));
      for (const id of chain) void load(id);
    });
    return () => {
      cancelled = true;
    };
  }, [levelId, rootId, load]);

  const toggle = (id: string) => {
    setOpen((shown) => {
      const next = new Set(shown);
      if (next.has(id)) next.delete(id);
      else {
        next.add(id);
        void load(id);
      }
      return next;
    });
  };

  const rows: { node: AtlasNode; depth: number }[] = [];
  const walk = (id: string, depth: number) => {
    for (const node of children.get(id) ?? []) {
      rows.push({ node, depth });
      if (node.kind === 'module' && open.has(node.id)) walk(node.id, depth + 1);
    }
  };
  walk(rootId, 0);

  return (
    <aside className="folder-tree" aria-label="Folder tree">
      <header className="folder-tree-head">
        <div>
          <h3>Folders</h3>
          <p className="muted">The tree as it is on disk — real names, nothing generated.</p>
        </div>
        <button className="panel-close" onClick={onClose} aria-label="Close the folder tree">
          ×
        </button>
      </header>

      {rows.length === 0 && loading.size > 0 ? <p className="muted folder-tree-note">Reading the tree…</p> : null}

      <ul className="folder-tree-list">
        {rows.map(({ node, depth }) => {
          const isFolder = node.kind === 'module';
          const expanded = open.has(node.id);
          return (
            <li key={node.id} style={{ paddingLeft: `${depth * 13}px` }}>
              {isFolder ? (
                <button
                  className="folder-twisty"
                  onClick={() => toggle(node.id)}
                  aria-label={expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
                  aria-expanded={expanded}
                >
                  {expanded ? '▾' : '▸'}
                </button>
              ) : (
                <span className="folder-twisty is-blank" aria-hidden="true" />
              )}
              <button
                className={node.id === levelId ? 'folder-name is-current' : 'folder-name'}
                title={node.path ?? node.name}
                onClick={() => (isFolder ? onDrill(node.id) : onReveal(node.id))}
              >
                <span className={`dot zone-${node.zone}`} />
                <span className="folder-label">
                  {node.name}
                  {isFolder ? '/' : ''}
                </span>
                {isFolder ? <span className="folder-count">{fileCount(node)}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

function fileCount(node: AtlasNode): string {
  const files = Number(node.meta.descendantFileCount ?? node.meta.fileCount ?? 0);
  return `${files} ${files === 1 ? 'file' : 'files'}`;
}
