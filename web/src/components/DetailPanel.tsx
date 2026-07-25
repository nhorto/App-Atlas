/**
 * @fileoverview The universal detail panel (SPEC.md 6.5).
 *
 * Whatever you click — a folder, a file, a function, a type — the answer appears
 * here in the same shape: what it is, what we can say about it, and what it connects
 * to. Every claim is labelled with where it came from, so a reader always knows
 * whether they are looking at a compiler fact or a human-written note.
 */
import type { ReactNode } from 'react';
import type { AtlasNode, FieldInfo, NodeView, OverviewView, ParamInfo } from '../types';
import { zoneLabel } from './AtlasNodeCard';

interface Props {
  detail: NodeView | null;
  overview: OverviewView | null;
  onReveal: (id: string) => void;
  onDrill: (id: string) => void;
  onClose: () => void;
}

export function DetailPanel({ detail, overview, onReveal, onDrill, onClose }: Props) {
  if (!detail) return <OverviewPanel overview={overview} onReveal={onReveal} />;

  const { node } = detail;
  const isContainer = node.kind === 'module' || node.kind === 'file' || node.kind === 'app';

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

      <Summary node={node} />
      <Facts node={node} />

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

function Summary({ node }: { node: AtlasNode }) {
  if (node.summary && node.summarySource === 'docs') {
    return (
      <section className="panel-section">
        <TrustLabel kind="docs" />
        <p className="summary-text">{node.summary}</p>
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
        No description yet. Add a <code>/** … */</code> comment above it and App Atlas will read it verbatim —
        plain-English summaries for everything else arrive in a later milestone.
      </p>
    </section>
  );
}

function TrustLabel({ kind }: { kind: 'facts' | 'docs' | 'ai' }) {
  const text = kind === 'facts' ? 'Code facts' : kind === 'docs' ? "From your code's docs" : 'AI explanation';
  return <div className={`trust trust-${kind}`}>{text}</div>;
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

function NeighborList({ links, onReveal }: { links: NodeView['outgoing']; onReveal: (id: string) => void }) {
  return (
    <ul className="link-list">
      {links.map((link) => (
        <li key={link.edge.id}>
          <button onClick={() => onReveal(link.other.id)}>
            <span className={`dot zone-${link.other.zone}`} />
            <span className="link-name">{link.other.name}</span>
            <span className="link-note">
              {link.edge.kind === 'imports' ? 'imports' : 'uses'}
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
    default:
      return node.kind;
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
    default:
      break;
  }
  return rows;
}
