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
  ServiceMeta,
  StoreMeta,
} from '../types';
import { zoneLabel } from './AtlasNodeCard';
import { Summary, TrustLabel } from './Trust';

interface Props {
  detail: NodeView | null;
  overview: OverviewView | null;
  aiEnabled: boolean;
  onReveal: (id: string) => void;
  onDrill: (id: string) => void;
  onClose: () => void;
}

export function DetailPanel({ detail, overview, aiEnabled, onReveal, onDrill, onClose }: Props) {
  // A description generated from this panel has to appear in this panel, and the atlas
  // on the server is the copy that got updated — not the one we were handed.
  const [written, setWritten] = useState<{ id: string; text: string } | null>(null);

  if (!detail) return <OverviewPanel overview={overview} onReveal={onReveal} />;

  const node =
    written && written.id === detail.node.id
      ? { ...detail.node, summary: written.text, summarySource: 'ai' as const }
      : detail.node;
  const isContainer =
    node.kind === 'module' || node.kind === 'file' || node.kind === 'app' || node.kind === 'zone';
  const isBoundary = node.kind === 'endpoint' || node.kind === 'service' || node.kind === 'store';

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
        <h2>{node.label ?? node.name}</h2>
        {node.path && node.path !== node.name ? <p className="panel-path">{node.path}</p> : null}
        {isContainer && detail.children.length > 0 ? (
          <button className="btn-primary" onClick={() => onDrill(node.id)}>
            Look inside →
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
  const undocumented = vars.filter((entry) => !entry.documented).length;

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
                {meta.envExample ? (
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

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="panel-section">
      <h3>{title}</h3>
      {hint ? <p className="section-hint">{hint}</p> : null}
      {children}
    </section>
  );
}

function OverviewPanel({ overview, onReveal }: { overview: OverviewView | null; onReveal: (id: string) => void }) {
  if (!overview) return <aside className="panel" />;
  const { meta, busiestFiles } = overview;
  const documented = meta.stats.files > 0 ? Math.round((meta.stats.documentedFiles / meta.stats.files) * 100) : 0;

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
        <p className="summary-empty">
          Click any box to see what it is and what it connects to. Press its <strong>›</strong> button to look
          inside, and the breadcrumb above to come back out.
        </p>
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
          <div className="fact-row">
            <dt>Documented</dt>
            <dd>{documented}% of files</dd>
          </div>
        </dl>
      </section>

      {busiestFiles.length > 0 ? (
        <Section title="Most connected files" hint="A good place to start reading">
          <ul className="link-list">
            {busiestFiles.map(({ node, connections }) => (
              <li key={node.id}>
                <button onClick={() => onReveal(node.id)}>
                  <span className={`dot zone-${node.zone}`} />
                  <span className="link-name">{node.name}</span>
                  <span className="link-note">{connections}</span>
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

function kindWord(node: AtlasNode): string {
  switch (node.kind) {
    case 'module':
      return 'Folder';
    case 'file':
      return 'File';
    case 'function':
      return String(node.meta.isMethod) === 'true' ? 'Method' : 'Function';
    case 'type':
      return String(node.meta.typeKind ?? 'Type');
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
    default:
      return 'Endpoint';
  }
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
      rows.push(['Kind', String(node.meta.typeKind ?? 'type')]);
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
      if (meta.method) rows.push(['Kind', meta.method]);
      if (meta.route) rows.push([meta.endpointKind === 'cron' ? 'Runs' : 'Path', meta.route]);
      if (meta.schedule) rows.push(['Schedule', meta.schedule]);
      rows.push(['Found by', meta.framework]);
      if (meta.endpointKind !== 'env') {
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
