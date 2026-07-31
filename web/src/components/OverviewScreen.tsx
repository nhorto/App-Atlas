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
import { Fragment } from 'react';
import type { ReactNode } from 'react';
import type {
  AtlasChanges,
  ChangeNote,
  ChangeReport,
  AtlasNode,
  DoorChange,
  LevelNode,
  OverviewView,
  Tour,
  UnimportedView,
} from '../types';
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

      {/* Above the figures, because somebody who has been steering an agent all weekend
          did not come here to learn how many files they have. Whether the last run left
          anything to compare against is part of the answer, so the block appears even on
          a first run — silence would read as "nothing happened". */}
      {view.changes ? <Changes report={view.changes} changes={meta.changes} onReveal={onReveal} /> : null}

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

      {/* Directly under the reading order, because it is the same question turned round:
          those are the files everything leans on, these are the ones nothing does. */}
      <Unimported view={view.unimported} onReveal={onReveal} />

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

/**
 * The files nothing else in the app imports.
 *
 * For somebody who steered an agent for a weekend this is often the most useful thing on
 * the page: abandoned attempts sit in the tree looking exactly like the code that runs,
 * and nothing else here tells them apart. Which is also why every word of it is a
 * statement about the import graph and not a suggestion about what to do — a file
 * reached by a computed path is invisible to this and always will be, so the section
 * says "nothing imports it", never "this is dead".
 *
 * The three states are rendered as three different things on purpose. A refusal is not
 * an empty list: it means nobody looked, and drawing it as good news would be the one
 * mistake this whole feature exists to avoid.
 */
function Unimported({ view, onReveal }: { view: UnimportedView; onReveal: (id: string) => void }) {
  if (!view.answered) {
    return (
      <Section title="Files nothing else imports" hint="Not reported for this project">
        <p className="section-note">{sentenceCase(view.because ?? 'no answer')}.</p>
      </Section>
    );
  }

  if (view.total === 0) {
    return (
      <Section title="Files nothing else imports" hint="There are none">
        {/* The sentence comes from the model, so this page and the brief the same run
            wrote cannot describe the same repo differently. */}
        <p className="section-note">{sentenceCase(view.headline ?? '')}.</p>
      </Section>
    );
  }

  return (
    <Section
      title="Files nothing else imports"
      hint="No import, no door, no manifest entry, no framework convention — worth opening"
    >
      <p className="section-note">{sentenceCase(view.headline ?? '')}, out of {view.considered} weighed up.</p>
      <ol className="start-list">
        {view.files.map((file) => (
          <li key={file.id}>
            <button onClick={() => onReveal(file.id)} title={file.path}>
              <span className={`dot zone-${file.zone}`} />
              <span className="start-name">{file.path}</span>
              <span className={`start-summary source-${file.summarySource ?? 'none'}`}>
                {file.summary ?? (file.exportedNames.length > 0 ? `exports ${file.exportedNames.join(', ')}` : '')}
              </span>
              <span className="start-count">{file.loc}</span>
            </button>
          </li>
        ))}
      </ol>
      {view.total > view.files.length ? (
        <p className="section-note">…and {view.total - view.files.length} more.</p>
      ) : null}
      <ul className="warn-list">
        {view.caveats.map((caveat) => (
          <li key={caveat}>{sentenceCase(caveat)}.</li>
        ))}
      </ul>
    </Section>
  );
}

/**
 * What moved since the previous run.
 *
 * Every sentence here was written by the model layer and is handed over verbatim, so
 * this screen and the command line that produced the atlas cannot describe the same week
 * differently. All this component decides is what gets a name and what gets a number:
 * doors are named, because "2 new routes have no auth check" leaves the reader hunting;
 * the ordinary churn becomes three badges, because nobody reads a list of file counts.
 */
function Changes({
  report,
  changes,
  onReveal,
}: {
  report: ChangeReport;
  changes: AtlasChanges | undefined;
  onReveal: (id: string) => void;
}) {
  // Once there is a real comparison, the sentence about ordinary churn gives way to the
  // badges below — they say the same thing in less space. With no baseline there are no
  // badges and no churn, and the line that survives is the one explaining why.
  const compared = changes?.baseline === 'compared';
  const lines = compared ? report.lines.filter((line) => line.doors.length > 0) : report.lines;

  return (
    <section className={`changes changes-${report.tone}`}>
      <h2>Since the last run</h2>
      <Note note={report.headline} lead onReveal={onReveal} />
      {lines.map((line) => (
        <Fragment key={line.text}>
          <Note note={line} onReveal={onReveal} />
        </Fragment>
      ))}
      {compared ? <ChangeBadges changes={changes} /> : null}
    </section>
  );
}

function Note({ note, lead, onReveal }: { note: ChangeNote; lead?: boolean; onReveal: (id: string) => void }) {
  return (
    <>
      <p className={lead ? 'changes-headline' : 'changes-line'}>{sentenceCase(note.text)}.</p>
      {note.doors.length > 0 ? (
        <ul className="changes-doors">
          {note.doors.map((door) => (
            <li key={door.id}>
              <button onClick={() => onReveal(door.id)} title={whereOf(door)}>
                <span className="changes-door-name">{door.name}</span>
                {door.writes ? <span className="changes-door-writes">writes data</span> : null}
                <span className="changes-door-where">{whereOf(door)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/**
 * The shape of the churn: how much appeared, vanished and merely differs. Hovering gives
 * the breakdown by kind, which is detail rather than headline — the point of the badges
 * is scale, so that a reader can tell one renamed helper from a rewritten app.
 */
function ChangeBadges({ changes }: { changes: AtlasChanges }) {
  const detail = (field: 'added' | 'removed' | 'changed') =>
    Object.entries(changes.byKind)
      .filter(([, counts]) => counts[field] > 0)
      .map(([kind, counts]) => `${counts[field]} ${kind}`)
      .join(', ') || 'nothing';

  return (
    <div className="changes-badges">
      <span className="change-badge is-added" title={detail('added')}>
        {signed('+', changes.total.added)} added
      </span>
      <span className="change-badge is-removed" title={detail('removed')}>
        {signed('−', changes.total.removed)} removed
      </span>
      <span className="change-badge is-changed" title={detail('changed')}>
        {changes.total.changed} changed
      </span>
    </div>
  );
}

/** "−0 removed" reads as a change; a plain zero reads as the absence of one. */
function signed(sign: string, value: number): string {
  return value === 0 ? '0' : `${sign}${value}`;
}

function whereOf(door: DoorChange): string {
  if (!door.path) return door.endpointKind;
  return door.line ? `${door.path}:${door.line}` : door.path;
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
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
