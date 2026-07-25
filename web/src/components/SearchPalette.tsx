/**
 * @fileoverview Cmd-K search over everything in the atlas.
 */
import { useEffect, useRef, useState } from 'react';
import { search } from '../api';
import type { AtlasNode } from '../types';

interface Props {
  open: boolean;
  onClose: () => void;
  onPick: (id: string) => void;
}

export function SearchPalette({ open, onClose, onPick }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AtlasNode[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setResults([]);
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      search(q)
        .then((r) => {
          if (!cancelled) {
            setResults(r);
            setActive(0);
          }
        })
        .catch(() => undefined);
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, open]);

  if (!open) return null;

  const pick = (node: AtlasNode | undefined) => {
    if (!node) return;
    onPick(node.id);
    onClose();
  };

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Search files, functions, types…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, results.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              pick(results[active]);
            } else if (e.key === 'Escape') {
              onClose();
            }
          }}
        />
        {results.length > 0 ? (
          <ul className="palette-results">
            {results.map((node, i) => (
              <li key={node.id}>
                <button className={i === active ? 'is-active' : ''} onMouseEnter={() => setActive(i)} onClick={() => pick(node)}>
                  <span className={`dot zone-${node.zone}`} />
                  <span className="link-name">{node.name}</span>
                  <span className="link-path">{node.path}</span>
                  <span className="link-note">{node.kind}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="palette-hint">
            {query.trim().length < 2 ? 'Type at least two characters.' : 'Nothing matches that.'}
          </p>
        )}
      </div>
    </div>
  );
}
