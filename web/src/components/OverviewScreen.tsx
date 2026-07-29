/**
 * @fileoverview The overview page (SPEC.md 6.4).
 *
 * The answer to "what even is this?" — which, for someone who has been steering an
 * agent for three weeks, is a question they may genuinely not be able to answer about
 * their own product.
 *
 * Written top-down in the order a person actually asks: what is this app, what is it
 * made of, what is it built on, where should I start reading, and how much of what I
 * am being told came from a machine. That last section is not filler. A tool that
 * generates prose about your code owes you a straight answer about how much of what
 * you just read it made up.
 */
import type { ReactNode } from 'react';
import type { AtlasNode, LevelNode, OverviewView, Tour } from '../types';
import { zoneLabel } from './AtlasNodeCard';
import { TrustLabel } from './Trust';

/**
 * A create-whatever template leaves package.json saying "testproject" long after
 * the folder is called cork-and-note. The declared name still leads — it is what
 * the code says — but the folder is the name the person actually knows.
 */
function folderNameOf(root: string, declared: string): string {
  const folder = root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  if (!folder || folder.toLowerCase() === declared.toLowerCase()) return '';
  return ` · in ${folder}`;
}

interface Props {
  view: OverviewView;
  tours: Tour[];
  onDrill: (id: string) => void;
  onReveal: (id: string) => void;
  onStartTour: (id: string) => void;
  onOpenBoundaries: () => void;
}

export function OverviewScreen({ view, tours, onDrill, onReveal, onStartTour, onOpenBoundaries }: Props) {
  const { meta, app, topLevel, busiestFiles } = view;
  const stats = meta.stats;
  const parts = topLevel.filter((node) => node.kind === 'module');

  return (
    <div className="page overview-page">
      <header className="page-head">
        <h1>{meta.name}</h1>
        <p className="page-sub">
          {meta.frameworks.length > 0 ? meta.frameworks.join(' · ') : (meta.languages.join(' · ') || 'Source code')}
          {folderNameOf(meta.root, meta.name)}
        </p>
      </header>

      {/* What kind of project App Atlas decided this is, and the signals that decided
          it. On screen because the verdict changes which view opens first: a guess
          that steers the tool has to be one the reader can check and disagree with. */}
      {meta.archetype ? (
        <p className="archetype">
          <span className="archetype-label">{meta.archetype.label}</span>
          <span className="archetype-because">{meta.archetype.because.join(' · ')}</span>
        </p>
      ) : null}

      {app?.summary ? (
        <section className="overview-lede">
          <TrustLabel kind={app.summarySource === 'docs' ? 'docs' : 'ai'} />
          <p>{app.summary}</p>
        </section>
      ) : (
        <section className="overview-lede is-empty">
          <p>
            No description of this app has been written yet. Run <code>app-atlas analyze</code> with an AI backend
            available, or add a <code>@fileoverview</code> comment to your main files.
          </p>
        </section>
      )}

      <section className="overview-stats">
        <Stat value={stats.files} label="files" />
        <Stat value={stats.functions} label="functions" />
        <Stat value={stats.types} label="types" />
        <Stat value={stats.endpoints} label={stats.endpoints === 1 ? 'way in' : 'ways in'} onClick={onOpenBoundaries} />
        <Stat value={stats.externalServices} label="outside services" onClick={onOpenBoundaries} />
        <Stat value={stats.stores} label={stats.stores === 1 ? 'data store' : 'data stores'} onClick={onOpenBoundaries} />
      </section>

      {tours.length > 0 ? (
        <Section
          title="Take the tour"
          hint="Each one walks the map for you, a step at a time. Traced from the code, so they are never out of date."
        >
          <div className="tour-grid">
            {tours.map((tour) => (
              <button key={tour.id} className={`tour-card tour-${tour.kind}`} onClick={() => onStartTour(tour.id)}>
                <span className="tour-title">{tour.title}</span>
                <span className="tour-sub">{tour.subtitle}</span>
              </button>
            ))}
          </div>
          {/* Five suggestions is a suggestion; twenty-four is a directory. But a reader
              who only ever saw five had no way to know the rest existed, which reads as
              "the other nineteen doors are not worth explaining". */}
          {stats.endpoints > tours.length ? (
            <p className="tour-more">
              Every other way in has one too — open a door on{' '}
              <button className="link" onClick={onOpenBoundaries}>
                Boundaries
              </button>{' '}
              and walk it from there.
            </p>
          ) : null}
        </Section>
      ) : null}

      {parts.length > 0 ? (
        <Section
          title="The parts"
          hint="The top level of your app. Click one to look inside."
        >
          <div className="part-grid">
            {parts.map((part) => (
              <button key={part.id} className={`part-card zone-${part.zone}`} onClick={() => onDrill(part.id)}>
                <span className="part-name">{part.label ?? part.name}</span>
                {part.label ? <span className="part-path">{part.name}</span> : null}
                {/* The count already has a home in `part-meta` below, so the fallback
                    is the zone alone — repeating it read as "1 files · Logic / 1 file". */}
                <span className="part-summary">{part.summary ?? zoneLabel(part.zone)}</span>
                <span className="part-meta">
                  {countOf(part)} {countOf(part) === 1 ? 'file' : 'files'}
                </span>
              </button>
            ))}
          </div>
        </Section>
      ) : null}

      {busiestFiles.length > 0 ? (
        <Section title="Where to start reading" hint="The files the rest of your app leans on most">
          <ol className="start-list">
            {busiestFiles.map(({ node, connections }) => (
              <li key={node.id}>
                <button onClick={() => onReveal(node.id)} title={sourceOf(node)}>
                  <span className={`dot zone-${node.zone}`} />
                  <span className="start-name">{node.name}</span>
                  <span className={`start-summary source-${node.summarySource ?? 'none'}`}>{describe(node)}</span>
                  <span className="start-count">{connections}</span>
                </button>
              </li>
            ))}
          </ol>
        </Section>
      ) : null}

      <Section title="Where these words came from" hint="How much of this page is a fact and how much is a guess">
        {/* Both bars count files, so they are comparable. Descriptions of folders and
            of the app itself are counted separately below rather than mixed in. */}
        <div className="provenance-bars">
          <Bar label="Read from your own docstrings" value={stats.documentedFiles} total={stats.files} kind="docs" />
          <Bar label="Written by AI" value={stats.aiFiles} total={stats.files} kind="ai" />
        </div>
        <p className="section-note">
          Everything structural on this page — the files, the connections, the counts, every door and data store —
          is derived by the TypeScript compiler and cannot be wrong. Only the sentences vary.
          {stats.aiSummaries > stats.aiFiles
            ? ` The folder names above, and the paragraph at the top, were written by AI too (${stats.aiSummaries - stats.aiFiles} more).`
            : ''}
        </p>
        {stats.staleDocs > 0 ? (
          <p className="stale-warning">
            {stats.staleDocs} {stats.staleDocs === 1 ? 'docstring describes' : 'docstrings describe'} code that has
            changed since it was written. They are badged wherever they appear.
          </p>
        ) : null}
        {stats.documentedFiles < stats.files ? (
          <p className="section-note">
            Run <code>app-atlas init</code> to have your coding agent write docstrings as it builds. They are read
            verbatim, cost nothing, and beat anything generated after the fact.
          </p>
        ) : null}
      </Section>

      {meta.warnings.length > 0 ? (
        <Section title="Notes">
          <ul className="warn-list">
            {meta.warnings.slice(0, 8).map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

function Stat({ value, label, onClick }: { value: number; label: string; onClick?: () => void }) {
  const content = (
    <>
      <span className="stat-value">{value.toLocaleString()}</span>
      <span className="stat-label">{label}</span>
    </>
  );
  return onClick ? (
    <button className="stat is-clickable" onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className="stat">{content}</div>
  );
}

function Bar({ label, value, total, kind }: { label: string; value: number; total: number; kind: string }) {
  const percent = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="prov-row">
      <span className="prov-label">{label}</span>
      <span className="prov-track">
        <span className={`prov-fill prov-${kind}`} style={{ width: `${percent}%` }} />
      </span>
      <span className="prov-value">
        {value} of {total}
      </span>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="page-section">
      <h2>{title}</h2>
      {hint ? <p className="section-hint">{hint}</p> : null}
      {children}
    </section>
  );
}

function countOf(node: LevelNode): number {
  return Number(node.meta.descendantFileCount ?? node.meta.fileCount ?? node.childCount ?? 0);
}

/**
 * Where a row's sentence came from. A tooltip rather than a badge: ten badges down
 * the side of a list is noise, but the reader can still always find out.
 */
function sourceOf(node: AtlasNode): string {
  if (node.summarySource === 'docs') {
    return node.meta?.docsStale === true
      ? "From this file's own docstring — but the code has changed since it was written"
      : "From this file's own docstring";
  }
  if (node.summarySource === 'ai') return 'Written by AI';
  return 'No description yet — this is what the file contains';
}

/** A file's own words if it has any, otherwise the shape of it. */
function describe(node: AtlasNode): string {
  if (node.summary) return node.summary;
  const functions = Number(node.meta.functionCount ?? 0);
  const types = Number(node.meta.typeCount ?? 0);
  const parts: string[] = [];
  if (functions > 0) parts.push(`${functions} ${functions === 1 ? 'function' : 'functions'}`);
  if (types > 0) parts.push(`${types} ${types === 1 ? 'type' : 'types'}`);
  return parts.join(' · ') || (node.path ?? '');
}
