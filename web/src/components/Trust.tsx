/**
 * @fileoverview The three trust tiers, in one place.
 *
 * Principle 1 of the spec is that facts come from the compiler and words come from
 * your code first. That only means anything if the reader can tell, at a glance,
 * which they are looking at — so every explanation in this app is rendered through
 * here and none of them are rendered anywhere else.
 *
 *   code facts        derived by the type checker; cannot be wrong
 *   from your docs    deterministic, but a human or an agent wrote it, so it can rot
 *   AI explanation    generated; useful, and never mistaken for either of the above
 *
 * The difference is deliberately quiet — a small label, not a warning triangle. The
 * point is to be answerable when someone asks "how do you know that?", not to make
 * them anxious about every sentence on screen.
 */
import type { ReactNode } from 'react';
import type { AtlasNode } from '../types';

export type TrustKind = 'facts' | 'docs' | 'ai';

const WORDS: Record<TrustKind, string> = {
  facts: 'Code facts',
  docs: "From your code's docs",
  ai: 'AI explanation',
};

export function TrustLabel({ kind, note }: { kind: TrustKind; note?: string }) {
  return (
    <div className={`trust trust-${kind}`}>
      {WORDS[kind]}
      {note ? <span className="trust-note">{note}</span> : null}
    </div>
  );
}

/** A docstring that describes code which has changed since it was written. */
export function isStale(node: AtlasNode): boolean {
  return node.meta?.docsStale === true;
}

/**
 * The explanation for one node, however we came by it. Rendering the empty case here
 * too is what keeps "no description yet" from looking like a bug — it is a state with
 * a next step, not a gap.
 */
export function Summary({ node, children }: { node: AtlasNode; children?: ReactNode }) {
  if (node.summary && node.summarySource === 'docs') {
    const stale = isStale(node);
    return (
      <section className="panel-section">
        <TrustLabel kind="docs" />
        <p className="summary-text">{node.summary}</p>
        {stale ? (
          <p className="stale-warning">
            This description has not changed since the code below it did — it may no longer be true.
          </p>
        ) : null}
      </section>
    );
  }

  if (node.summary && node.summarySource === 'ai') {
    return (
      <section className="panel-section">
        <TrustLabel kind="ai" />
        <p className="summary-text">{node.summary}</p>
      </section>
    );
  }

  return (
    <section className="panel-section">
      <p className="summary-empty">
        No description yet. Write a <code>/** … */</code> comment above it and App Atlas reads it verbatim.
      </p>
      {children}
    </section>
  );
}
