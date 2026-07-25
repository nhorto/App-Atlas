/**
 * @fileoverview The walkthrough primitive (SPEC.md 6.4).
 *
 * One step at a time, with the map doing what the words say: the camera moves to the
 * level being discussed, the things being discussed light up, and the code sits in a
 * drawer underneath. It is the delivery mechanism for everything else the tool knows,
 * which is why it is a component and not a page — anything can start one.
 *
 * Two rules make it feel like a guide rather than a slideshow. Nothing is hidden while
 * a tour runs: the reader can click away, follow their own thread, and come back to
 * "Show me again" without losing their place. And the trust tiers hold — the paragraph
 * is compiler fact, and anything a model or a docstring said is quoted separately,
 * labelled, and clearly somebody else's words.
 */
import { useEffect, useState } from 'react';
import { fetchSource } from '../api';
import type { SourceSlice, Tour } from '../types';
import { TrustLabel } from './Trust';

export function Walkthrough({
  tour,
  index,
  onStep,
  onShowAgain,
  onClose,
}: {
  tour: Tour;
  index: number;
  onStep: (next: number) => void;
  onShowAgain: () => void;
  onClose: () => void;
}) {
  const step = tour.steps[index];
  const [source, setSource] = useState<SourceSlice | null>(null);
  const [showCode, setShowCode] = useState(false);

  useEffect(() => {
    setSource(null);
    if (!step?.codeId) return;
    let cancelled = false;
    fetchSource(step.codeId)
      .then((slice) => {
        if (!cancelled) setSource(slice);
      })
      // No snippet is a missing nicety, not an error worth a message.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [step?.codeId]);

  // Arrow keys are what a stepper is for. Guarded so they still type into the search box.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement | null)?.tagName === 'INPUT') return;
      if (event.key === 'ArrowRight' && index < tour.steps.length - 1) onStep(index + 1);
      if (event.key === 'ArrowLeft' && index > 0) onStep(index - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, tour.steps.length, onStep]);

  if (!step) return null;
  const last = index === tour.steps.length - 1;

  return (
    <aside className={`walkthrough${step.tone === 'warn' ? ' is-warn' : ''}`} aria-label="Guided walkthrough">
      <div className="wt-bar">
        <div className="wt-where">
          <span className="wt-tour">{tour.title}</span>
          <span className="wt-count">
            Step {index + 1} of {tour.steps.length}
          </span>
        </div>
        <div className="wt-dots" aria-hidden>
          {tour.steps.map((one, i) => (
            <button
              key={one.id}
              className={i === index ? 'wt-dot is-current' : 'wt-dot'}
              title={one.title}
              onClick={() => onStep(i)}
            />
          ))}
        </div>
        <button className="wt-close" onClick={onClose} aria-label="End the walkthrough">
          ✕
        </button>
      </div>

      <div className="wt-body">
        <h2>{step.title}</h2>
        <p className="wt-text">{step.body}</p>

        {step.quote ? (
          <blockquote className="wt-quote">
            <TrustLabel kind={step.quoteSource === 'docs' ? 'docs' : 'ai'} />
            <p>{step.quote}</p>
          </blockquote>
        ) : null}

        {source ? (
          <div className="wt-code">
            <button className="wt-code-toggle" onClick={() => setShowCode((open) => !open)}>
              {showCode ? '▾' : '▸'} {source.path}:{source.startLine}
            </button>
            {showCode ? (
              <pre>
                <code>{source.code}</code>
              </pre>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="wt-actions">
        <button className="btn-ghost" onClick={onShowAgain} title="Put the map back where this step left it">
          Show me again
        </button>
        <div className="wt-nav">
          <button className="btn-ghost" disabled={index === 0} onClick={() => onStep(index - 1)}>
            Back
          </button>
          {last ? (
            <button className="btn-primary" onClick={onClose}>
              Done
            </button>
          ) : (
            <button className="btn-primary" onClick={() => onStep(index + 1)}>
              Next
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}
