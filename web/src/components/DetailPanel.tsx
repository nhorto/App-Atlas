/**
 * @fileoverview The universal detail panel (SPEC.md 6.5).
 *
 * Whatever you click — a folder, a file, a function, a type — the answer appears
 * here in the same shape: what it is, what we can say about it, and what it connects
 * to. Every claim is labelled with where it came from, so a reader always knows
 * whether they are looking at a compiler fact or a human-written note.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { explainNode } from '../api';
import type {
  AtlasNode,
  CodeSite,
  EndpointMeta,
  FieldInfo,
  NodeView,
  OverviewView,
  ParamInfo,
  Tour,
  ServiceMeta,
  StoreMeta,
} from '../types';
import { describedScope, zoneLabel } from './AtlasNodeCard';
import { Summary, TrustLabel } from './Trust';

/** Which screen the panel is sitting beside — the instructions differ per screen. */
export type PanelView = 'boundaries' | 'overview' | 'map' | 'types' | 'insights';

interface Props {
  detail: NodeView | null;
  overview: OverviewView | null;
  view: PanelView;
  aiEnabled: boolean;
  /** The walkthrough that starts at this node, when there is one. */
  tour: Tour | null;
  onReveal: (id: string) => void;
  onDrill: (id: string) => void;
  onStartTour: (id: string) => void;
  /** Opens this shape on the Data model, the other screen made of boxes and lines. */
  onShowInDataModel: (id: string) => void;
  onClose: () => void;
}

export function DetailPanel({
  detail,
  overview,
  view,
  aiEnabled,
  tour,
  onReveal,
  onDrill,
  onStartTour,
  onShowInDataModel,
  onClose,
}: Props) {
  // A description generated from this panel has to appear in this panel, and the atlas
  // on the server is the copy that got updated — not the one we were handed.
  const [written, setWritten] = useState<{ id: string; text: string } | null>(null);

  if (!detail) return <OverviewPanel overview={overview} view={view} onReveal={onReveal} />;

  const node =
    written && written.id === detail.node.id
      ? { ...detail.node, summary: written.text, summarySource: 'ai' as const }
      : detail.node;
  const isContainer =
    node.kind === 'module' || node.kind === 'file' || node.kind === 'app' || node.kind === 'zone';
  const isBoundary = node.kind === 'endpoint' || node.kind === 'service' || node.kind === 'store';
  const scope = describedScope(node);

  return (
    <aside className="panel">
      <header className="panel-head">
        <div className="panel-eyebrow">
          <span className={`chip zone-chip zone-${node.zone}`}>{zoneLabel(node.zone)}</span>
          <span className="chip kind-chip">{kindWord(node)}</span>
          <button className="panel-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {/* The real name is the heading and the generated one sits under it, marked —
            the same rule the cards on the Map follow, and for the same reason (#94). */}
        <h2>{node.name}</h2>
        {node.label && node.label !== node.name ? (
          <p className="panel-alias">
            <span className="alias-mark">AI</span> {node.label}
            {scope ? (
              <span className="alias-scope"> — written about {scope.covered} of these {scope.total} files</span>
            ) : null}
          </p>
        ) : null}
        {node.path && node.path !== node.name ? <p className="panel-path">{node.path}</p> : null}
        {isContainer && detail.children.length > 0 ? (
          <button className="btn-primary" onClick={() => onDrill(node.id)}>
            Look inside →
          </button>
        ) : null}
        {/* The Map and the Data model are two pictures of the same thing, and the link
            between them explains the split better than any wording could (#95): a shape
            here is written by a file there. */}
        {node.kind === 'type' && view === 'types' && node.path ? (
          <button className="btn-ghost panel-cross" onClick={() => onReveal(node.id)}>
            Show the code on the Map →
          </button>
        ) : null}
        {node.kind === 'type' && view === 'map' ? (
          <button className="btn-ghost panel-cross" onClick={() => onShowInDataModel(node.id)}>
            See it on the Data model →
          </button>
        ) : null}
        {/* SPEC.md 6.5's "explain like I'm new": the same facts, walked instead of listed.
            When the walk belongs to a door the reader did not click — they opened the
            file that answers it — the button says whose walk it is, because "walk me
            through what happens" beside a helper function is a promise about the wrong
            thing. */}
        {tour ? (
          <button className="btn-tour" onClick={() => onStartTour(tour.id)}>
            {tour.id === `tour:${node.id}`
              ? 'Walk me through what happens →'
              : `Walk me through ${lowerFirst(tour.title)} →`}
          </button>
        ) : null}
      </header>

      {isBoundary ? null : (
        <Summary node={node}>
          <ExplainButton
            node={node}
            aiEnabled={aiEnabled}
            onWritten={(text) => setWritten({ id: node.id, text })}
          />
        </Summary>
      )}
      <Facts node={node} />
      {isBoundary ? <Sites node={node} onReveal={onReveal} /> : null}
      {node.kind === 'endpoint' ? <EnvVars node={node} /> : null}

      {detail.children.length > 0 ? (
        <Section title={`Inside (${detail.children.length})`}>
          <ul className="link-list">
            {detail.children.slice(0, 40).map((child) => (
              <li key={child.id}>
                <button onClick={() => onReveal(child.id)}>
                  <span className={`dot zone-${child.zone}`} />
                  <span className="link-name">{child.name}</span>
                  <span className="link-note">{kindWord(child)}</span>
                </button>
              </li>
            ))}
          </ul>
          {detail.children.length > 40 ? <p className="muted">+{detail.children.length - 40} more</p> : null}
        </Section>
      ) : null}

      {detail.typesUsed.length > 0 ? (
        <Section title={`Types used (${detail.typesUsed.length})`} hint="The shapes of data it works with">
          <TypesUsed types={detail.typesUsed} onReveal={onReveal} />
        </Section>
      ) : null}

      {detail.outgoing.length > 0 ? (
        <Section title={`Uses (${detail.outgoingTotal})`} hint="Things this depends on">
          <NeighborList links={detail.outgoing} onReveal={onReveal} />
        </Section>
      ) : null}

      {detail.incoming.length > 0 ? (
        <Section title={`Used by (${detail.incomingTotal})`} hint="Things that would break if you deleted this">
          <NeighborList links={detail.incoming} onReveal={onReveal} />
        </Section>
      ) : null}

      {node.path && overview ? (
        <div className="panel-foot">
          <a
            className="btn-ghost"
            href={`vscode://file/${overview.meta.root.replace(/\\/g, '/')}/${node.path}${
              node.startLine ? `:${node.startLine}` : ''
            }`}
          >
            Open in editor
          </a>
        </div>
      ) : null}
    </aside>
  );
}

/**
 * "Explain this one" — the third tier of the words layer (SPEC.md 5.5), and the only
 * place App Atlas sends real source code anywhere. The button says so before it is
 * pressed, because consent that arrives after the fact is not consent.
 */
function ExplainButton({
  node,
  aiEnabled,
  onWritten,
}: {
  node: AtlasNode;
  aiEnabled: boolean;
  onWritten: (text: string) => void;
}) {
  const [state, setState] = useState<'idle' | 'working'>('idle');
  const [error, setError] = useState<string | null>(null);
  const explainable = node.kind === 'function' || node.kind === 'type' || node.kind === 'file';

  // Reset when the panel switches to a different node, so a failure on one thing
  // does not follow the reader to the next.
  useEffect(() => {
    setState('idle');
    setError(null);
  }, [node.id]);

  if (!explainable || !aiEnabled || node.summary) return null;

  const ask = async () => {
    setState('working');
    setError(null);
    try {
      const result = await explainNode(node.id);
      onWritten(result.text);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setState('idle');
    }
  };

  return (
    <>
      <button className="btn-ghost btn-explain" onClick={ask} disabled={state === 'working'}>
        {state === 'working' ? 'Writing…' : 'Explain this'}
      </button>
      <p className="explain-note">
        {state === 'working'
          ? 'Reading the code and writing a description. This can take a few seconds.'
          : `Sends this ${kindWord(node).toLowerCase()}'s source to your AI backend. Cached afterwards.`}
      </p>
      {error ? <p className="explain-error">{error}</p> : null}
    </>
  );
}

function Facts({ node }: { node: AtlasNode }) {
  const rows = factRows(node);
  if (rows.length === 0) return null;
  return (
    <section className="panel-section">
      <TrustLabel kind="facts" />
      <dl className="facts">
        {rows.map(([label, value]) => (
          <div key={label} className="fact-row">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {node.kind === 'function' ? <Params node={node} /> : null}
      {node.kind === 'type' ? <Fields node={node} /> : null}
    </section>
  );
}

function Params({ node }: { node: AtlasNode }) {
  const params = (node.meta.params as ParamInfo[] | undefined) ?? [];
  if (params.length === 0) return <p className="muted">Takes no arguments.</p>;
  return (
    <table className="mini-table">
      <tbody>
        {params.map((p) => (
          <tr key={p.name}>
            <td className="mono">
              {p.rest ? '…' : ''}
              {p.name}
              {p.optional ? '?' : ''}
            </td>
            <td className="mono muted">{p.type}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Fields({ node }: { node: AtlasNode }) {
  const fields = (node.meta.fields as FieldInfo[] | undefined) ?? [];
  if (fields.length === 0) return null;
  return (
    <table className="mini-table">
      <tbody>
        {fields.map((f) => (
          <tr key={f.name}>
            <td className="mono">
              {f.name}
              {f.optional ? '?' : ''}
            </td>
            <td className="mono muted">{f.type}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Every line of code behind a boundary. This is the evidence for the claim on the
 * card, and it is the difference between "your app talks to Stripe" and "your app
 * talks to Stripe — here, here, and here".
 */
function Sites({ node, onReveal }: { node: AtlasNode; onReveal: (id: string) => void }) {
  const sites = sitesOf(node);
  if (sites.length === 0) return null;

  return (
    <Section title={`Where in the code (${sites.length})`}>
      <ul className="site-list">
        {sites.slice(0, 30).map((site, index) => (
          <li key={`${site.path}:${site.line}:${index}`}>
            <button
              onClick={() => (site.nodeId ? onReveal(site.nodeId) : undefined)}
              disabled={!site.nodeId}
              className="site"
            >
              <span className="site-path">
                {site.path}:{site.line}
              </span>
              {site.snippet ? <code className="site-snippet">{site.snippet}</code> : null}
            </button>
          </li>
        ))}
      </ul>
      {sites.length > 30 ? <p className="muted">+{sites.length - 30} more</p> : null}
    </Section>
  );
}

function sitesOf(node: AtlasNode): CodeSite[] {
  const sites = node.meta.sites as CodeSite[] | undefined;
  return Array.isArray(sites) ? sites : [];
}

/** The env endpoint carries the whole configuration inventory (SPEC.md 6.6). */
function EnvVars({ node }: { node: AtlasNode }) {
  const meta = node.meta as unknown as EndpointMeta;
  const vars = meta.vars ?? [];
  if (vars.length === 0) return null;
  // `NODE_ENV` and `PORT` are set by whatever runs the app, so counting them here
  // would put the reader on a hunt for something nobody forgot.
  const undocumented = vars.filter((entry) => !entry.documented && !entry.platform).length;

  return (
    <Section
      title={`Variables (${vars.length})`}
      hint={
        meta.envExample
          ? `${undocumented} missing from ${meta.envExample}`
          : 'No .env.example to check these against'
      }
    >
      <table className="mini-table">
        <tbody>
          {vars.map((entry) => (
            <tr key={entry.name}>
              <td className="mono">{entry.name}</td>
              <td className="muted">
                {entry.sites.length} {entry.sites.length === 1 ? 'read' : 'reads'}
              </td>
              <td>
                {entry.platform ? (
                  <span className="badge badge-public">set by the platform</span>
                ) : meta.envExample ? (
                  <span className={`badge badge-${entry.documented ? 'protected' : 'open'}`}>
                    {entry.documented ? 'documented' : 'missing'}
                  </span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function NeighborList({ links, onReveal }: { links: NodeView['outgoing']; onReveal: (id: string) => void }) {
  return (
    <ul className="link-list">
      {links.map((link) => (
        <li key={link.edge.id}>
          <button onClick={() => onReveal(link.other.id)}>
            <span className={`dot zone-${link.other.zone}`} />
            <span className="link-name">{link.other.name}</span>
            <span className="link-note">
              {edgeWord(link.edge.kind)}
              {link.edge.weight > 1 ? ` ×${link.edge.weight}` : ''}
            </span>
          </button>
          {link.other.path && link.other.path !== link.other.name ? (
            <span className="link-path">{link.other.path}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * The types a file or function is built around, as chips you can click through to.
 * Deliberately separate from the "uses" list: a reader asking "what shape is the data
 * here?" should not have to hunt for the types among ordinary function calls.
 */
function TypesUsed({ types, onReveal }: { types: AtlasNode[]; onReveal: (id: string) => void }) {
  return (
    <ul className="type-chips">
      {types.map((type) => {
        const fields = ((type.meta.fields as FieldInfo[] | undefined) ?? []).length;
        return (
          <li key={type.id}>
            <button className={`type-chip zone-${type.zone}`} onClick={() => onReveal(type.id)} title={type.path ?? type.name}>
              <span className="type-chip-glyph">⬡</span>
              <span className="type-chip-name">{type.name}</span>
              <span className="type-chip-note">{typeChipNote(type, fields)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function typeChipNote(type: AtlasNode, fields: number): string {
  const kind = typeWord(type.meta.typeKind);
  // A bare "interface · 17" leaves the reader to guess what was counted.
  if (fields > 0) return `${kind} · ${fields} ${fields === 1 ? 'field' : 'fields'}`;
  return kind;
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="panel-section">
      <h3>{title}</h3>
      {hint ? <p className="section-hint">{hint}</p> : null}
      {children}
    </section>
  );
}

/**
 * What to do next, on the screen the reader is actually looking at.
 *
 * The old text described the Map's `›` button and its breadcrumb from every screen,
 * including three that have neither. Instructions for a control that is not on the
 * page are worse than no instructions: the reader hunts for it, does not find it, and
 * now has a reason to doubt everything else the panel says.
 */
function howToRead(view: PanelView): string {
  switch (view) {
    case 'boundaries':
      return 'Click a card to see what it is and what it connects to. A card that stands for several things opens the list, so you choose which one.';
    case 'types':
      return 'Click a shape to see its fields and everywhere it is used.';
    case 'insights':
      return 'Click a route or a variable to see the code behind it.';
    default:
      return 'Click any box to see what it is and what it connects to. Press its › button to look inside, and the breadcrumb above to come back out.';
  }
}

function OverviewPanel({
  overview,
  view,
  onReveal,
}: {
  overview: OverviewView | null;
  view: PanelView;
  onReveal: (id: string) => void;
}) {
  if (!overview) return <aside className="panel" />;
  const { meta, whereToLookFirst } = overview;
  // Null, not zero, when there is nothing to score (#184). `0%` is the worst mark on
  // the scale and reads as "you documented none of it"; the truth on a Java repo is
  // that there was no file here this tool could read, which the map says elsewhere.
  const documented =
    meta.stats.files > 0 ? Math.round((meta.stats.documentedFiles / meta.stats.files) * 100) : null;

  return (
    <aside className="panel">
      <header className="panel-head">
        <div className="panel-eyebrow">
          <span className="chip kind-chip">This app</span>
        </div>
        <h2>{meta.name}</h2>
        {meta.frameworks.length > 0 ? <p className="panel-path">{meta.frameworks.join(' · ')}</p> : null}
      </header>

      <section className="panel-section">
        {/* The panel sits beside four different screens, and only one of them has a
            `›` button and a breadcrumb. Telling somebody on the Boundaries screen to
            press a control that is not there is a small thing that makes them doubt
            the rest of the panel. */}
        <p className="summary-empty">{howToRead(view)}</p>
      </section>

      <section className="panel-section">
        <TrustLabel kind="facts" />
        <dl className="facts">
          <div className="fact-row">
            <dt>Files</dt>
            <dd>{meta.stats.files.toLocaleString()}</dd>
          </div>
          <div className="fact-row">
            <dt>Functions</dt>
            <dd>{meta.stats.functions.toLocaleString()}</dd>
          </div>
          <div className="fact-row">
            <dt>Types</dt>
            <dd>{meta.stats.types.toLocaleString()}</dd>
          </div>
          <div className="fact-row">
            <dt>Lines of code</dt>
            <dd>{meta.stats.linesOfCode.toLocaleString()}</dd>
          </div>
          <div className="fact-row">
            <dt>Connections</dt>
            <dd>{(meta.stats.imports + meta.stats.references).toLocaleString()}</dd>
          </div>
          <div className="fact-row">
            <dt>Ways in</dt>
            <dd>{meta.stats.endpoints.toLocaleString()}</dd>
          </div>
          <div className="fact-row">
            <dt>Services & stores</dt>
            <dd>{(meta.stats.services + meta.stats.stores).toLocaleString()}</dd>
          </div>
          {documented === null ? null : (
            <div className="fact-row">
              <dt>Documented</dt>
              <dd>{documented}% of files</dd>
            </div>
          )}
        </dl>
      </section>

      {whereToLookFirst.length > 0 ? (
        <Section title="Where to look first" hint="The files that pull the most of your app together">
          <ul className="link-list">
            {whereToLookFirst.map(({ node, imports }) => (
              <li key={node.id}>
                <button onClick={() => onReveal(node.id)}>
                  <span className={`dot zone-${node.zone}`} />
                  <span className="link-name">{node.name}</span>
                  <span className="link-note" title={`imports ${imports} ${imports === 1 ? 'file' : 'files'} directly`}>
                    {imports}
                  </span>
                </button>
                {node.path ? <span className="link-path">{node.path}</span> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {meta.warnings.length > 0 ? (
        <Section title="Notes">
          <ul className="warn-list">
            {meta.warnings.slice(0, 6).map((warning, i) => (
              <li key={i}>{warning}</li>
            ))}
          </ul>
        </Section>
      ) : null}
    </aside>
  );
}

function edgeWord(kind: string): string {
  switch (kind) {
    case 'imports':
      return 'imports';
    case 'reads-from':
      return 'reads from';
    case 'writes-to':
      return 'writes to';
    case 'exposed-by':
      return 'answered by';
    case 'protected-by':
      return 'protected by';
    default:
      return 'uses';
  }
}

/** A tour title dropped into the middle of a sentence: "Walk me through what happens…". */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function kindWord(node: AtlasNode): string {
  switch (node.kind) {
    case 'module':
      return 'Folder';
    case 'file':
      return 'File';
    case 'function':
      return String(node.meta.isMethod) === 'true' ? 'Method' : 'Function';
    case 'type':
      return typeWord(node.meta.typeKind);
    case 'app':
      return 'App';
    case 'zone':
      return node.meta.direction === 'in' ? 'Ways in' : 'Ways out';
    case 'endpoint':
      return endpointWord((node.meta as unknown as EndpointMeta).endpointKind);
    case 'service':
      return 'External service';
    case 'store':
      return 'Data store';
    default:
      return node.kind;
  }
}

function endpointWord(kind: string): string {
  switch (kind) {
    case 'http-route':
      return 'Route';
    case 'server-action':
      return 'Server action';
    case 'webhook':
      return 'Webhook';
    case 'cron':
      return 'Scheduled job';
    case 'queue':
      return 'Background job';
    case 'realtime':
      return 'Realtime';
    case 'cli':
      return 'Command line';
    case 'env':
      return 'Configuration';
    case 'file-read':
      return 'File read';
    case 'screen':
      return 'Screen';
    default:
      return 'Endpoint';
  }
}

/**
 * `type-alias` is what the compiler calls it, and nowhere else in this app does the
 * reader have to meet a hyphenated internal name. The Data view already says "type".
 */
function typeWord(kind: unknown): string {
  return kind === 'type-alias' ? 'type' : String(kind ?? 'type');
}

function factRows(node: AtlasNode): [string, string][] {
  const rows: [string, string][] = [];
  switch (node.kind) {
    case 'function':
      rows.push(['Returns', String(node.meta.returnType ?? 'void')]);
      rows.push(['Async', node.meta.isAsync ? 'yes' : 'no']);
      rows.push(['Exported', node.meta.isExported ? 'yes' : 'no']);
      if (node.startLine) rows.push(['Lines', `${node.startLine}–${node.endLine ?? node.startLine}`]);
      break;
    case 'type':
      rows.push(['Kind', typeWord(node.meta.typeKind)]);
      // A table observed in queries was never written down anywhere, so "exported"
      // and line numbers would be facts about the wrong thing. Say where it was seen.
      if (node.meta.observed === true) {
        if (node.meta.provider) rows.push(['Database', String(node.meta.provider)]);
        if (node.path) rows.push(['First seen in', node.path]);
        break;
      }
      rows.push(['Exported', node.meta.isExported ? 'yes' : 'no']);
      if (Array.isArray(node.meta.extends) && (node.meta.extends as string[]).length > 0) {
        rows.push(['Extends', (node.meta.extends as string[]).join(', ')]);
      }
      if (node.meta.aliasOf) rows.push(['Alias of', String(node.meta.aliasOf)]);
      if (node.startLine) rows.push(['Lines', `${node.startLine}–${node.endLine ?? node.startLine}`]);
      break;
    case 'file': {
      rows.push(['Lines', String(node.meta.loc ?? 0)]);
      rows.push(['Functions', String(node.meta.functionCount ?? 0)]);
      rows.push(['Types', String(node.meta.typeCount ?? 0)]);
      const external = (node.meta.externalImports as string[] | undefined) ?? [];
      if (external.length > 0) rows.push(['Packages used', external.join(', ')]);
      break;
    }
    case 'module':
      rows.push(['Files inside', String(node.meta.descendantFileCount ?? node.meta.fileCount ?? 0)]);
      rows.push(['Folder', String(node.meta.dirPath ?? node.path ?? '')]);
      break;
    case 'endpoint': {
      const meta = node.meta as unknown as EndpointMeta;
      // "SCREEN" as a method is the chip above repeating itself; GET and POST are not.
      if (meta.method && meta.endpointKind !== 'screen') rows.push(['Kind', meta.method]);
      if (meta.route) rows.push([meta.endpointKind === 'cron' ? 'Runs' : 'Path', meta.route]);
      if (meta.schedule) rows.push(['Schedule', meta.schedule]);
      rows.push(['Found by', meta.framework]);
      if (meta.endpointKind === 'screen') {
        // The security page leaves screens out of the auth list on purpose: a screen
        // opens inside an app someone already installed, not over the network. Saying
        // "nothing found" here would report two dozen holes the same page denies, and
        // a reader who clicks one card should not be told the opposite of the count.
        rows.push(['Auth', 'not graded — opened from inside the app']);
        rows.push(['Writes data', meta.writes ? 'yes' : 'no']);
      } else if (meta.endpointKind !== 'env') {
        rows.push([
          'Protected by',
          meta.guards.length === 0
            ? 'nothing found'
            : meta.guards
                .map((g) => `${g.name}${g.confidence === 'likely' ? ' (likely)' : ''}`)
                .join(', '),
        ]);
        rows.push(['Writes data', meta.writes ? 'yes' : 'no']);
      }
      break;
    }
    case 'service': {
      const meta = node.meta as unknown as ServiceMeta;
      rows.push(['Kind', meta.category]);
      if (meta.packages.length > 0) rows.push(['Package', meta.packages.join(', ')]);
      if (meta.hosts.length > 0) rows.push(['Hostname', meta.hosts.join(', ')]);
      rows.push(['Called from', `${meta.sites.length} ${meta.sites.length === 1 ? 'place' : 'places'}`]);
      break;
    }
    case 'store': {
      const meta = node.meta as unknown as StoreMeta;
      rows.push(['Client', meta.client]);
      rows.push(['Kind', meta.storeKind]);
      rows.push(['Reads', String(meta.reads)]);
      rows.push(['Writes', String(meta.writes)]);
      if (meta.tables.length > 0) rows.push(['Tables', meta.tables.join(', ')]);
      // Not folded into the row above: the database's own catalog is not this app's
      // data model, and the panel is the one place with room to say which is which.
      if (meta.catalogTables?.length) {
        rows.push(['Inspects its own schema', meta.catalogTables.join(', ')]);
      }
      break;
    }
    case 'zone':
      rows.push(['Direction', node.meta.direction === 'in' ? 'into the app' : 'out of the app']);
      rows.push(['Count', String(node.meta.endpointCount ?? 0)]);
      break;
    default:
      break;
  }
  return rows;
}
