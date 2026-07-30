/**
 * @fileoverview The card that represents one node on the canvas.
 *
 * Cards are ordinary React components (that is why React Flow was chosen), so a
 * folder, a file and a type can each look like what they are instead of all being
 * circles. Colour always means zone; nothing else is colour-coded.
 */
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type {
  EndpointMeta,
  FieldInfo,
  LevelNode,
  ParamInfo,
  ServiceMeta,
  StoreMeta,
} from '../types';

export interface AtlasCardData extends Record<string, unknown> {
  node: LevelNode;
  dim: boolean;
  focus: boolean;
  /** Drawn beyond the membrane: the outside world, not a child of this level. */
  ghost?: boolean;
  onDrill: (id: string) => void;
}

export function AtlasNodeCard({ data, selected }: NodeProps) {
  const { node, dim, focus, ghost, onDrill } = data as unknown as AtlasCardData;
  const classes = [
    'card',
    `card-${node.kind}`,
    `zone-${node.zone}`,
    dim ? 'is-dim' : '',
    focus ? 'is-focus' : '',
    selected ? 'is-selected' : '',
    ghost ? 'is-outside' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      {/* Rendered as a sibling rather than a child: the card clips its own overflow,
          and a tooltip that gets cut off at the card edge is worse than none. */}
      {node.summary ? <HoverCard node={node} /> : null}

      <div className={classes} title={node.path ?? node.name}>
        <Handle type="target" position={Position.Left} className="handle" />

        <div className="card-head">
          <span className="card-kind">{kindGlyph(node)}</span>
          <span className="card-name">{node.label ?? node.name}</span>
          {node.drillable ? (
            // A visible way in. Double-click works too, but a button beats a gesture
            // nobody told you about.
            <button
              className="card-open"
              title={`Look inside ${node.name}`}
              aria-label={`Look inside ${node.name}`}
              onClick={(event) => {
                event.stopPropagation();
                onDrill(node.id);
              }}
            >
              ›
            </button>
          ) : null}
        </div>

        <div className="card-sub">{subtitle(node)}</div>

        {node.kind === 'endpoint' ? <EndpointBadge node={node} /> : null}

        {node.kind === 'module' && node.preview.length > 0 ? (
          <ul className="card-preview">
            {node.preview.slice(0, 4).map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        ) : null}

        {node.kind === 'type' ? <FieldRows node={node} /> : null}

        {node.outsideIn + node.outsideOut > 0 ? (
          <div className="card-outside">
            {node.outsideIn > 0 ? <span title="used by things outside this box">← {node.outsideIn}</span> : null}
            {node.outsideOut > 0 ? <span title="uses things outside this box">{node.outsideOut} →</span> : null}
          </div>
        ) : null}

        <Handle type="source" position={Position.Right} className="handle" />
      </div>
    </>
  );
}

/**
 * The one-line answer, on hover (SPEC.md 6.2). This is the payoff of the words layer
 * on the map: you can sweep a folder full of files and read what each one is for
 * without clicking anything, and the small coloured dot says whether the sentence came
 * from the code's own docs or from a model.
 */
function HoverCard({ node }: { node: LevelNode }) {
  const stale = node.meta?.docsStale === true;
  return (
    <div className="node-hover" aria-hidden>
      <span className="node-hover-name">{node.label ?? node.name}</span>
      <span className="node-hover-text">{node.summary}</span>
      <span className={`node-hover-source source-${node.summarySource ?? 'none'}${stale ? ' is-stale' : ''}`}>
        {node.summarySource === 'docs' ? (stale ? 'your docs · may be outdated' : "your code's docs") : 'AI explanation'}
      </span>
    </div>
  );
}

function FieldRows({ node }: { node: LevelNode }) {
  const fields = (node.meta.fields as FieldInfo[] | undefined) ?? [];
  if (fields.length === 0) return null;
  return (
    <ul className="card-fields">
      {fields.slice(0, 6).map((field) => (
        <li key={field.name}>
          <span className="field-name">
            {field.name}
            {field.optional ? '?' : ''}
          </span>
          <span className="field-type">{field.type}</span>
        </li>
      ))}
      {fields.length > 6 ? <li className="field-more">+{fields.length - 6} more</li> : null}
    </ul>
  );
}

/**
 * A door only says "no auth check" when it is a door a stranger can reach. Crons and
 * queue workers are not, and badging them would train people to ignore the badge.
 *
 * The same goes for the doors that are unchecked for a reason: the analyzer writes
 * that reason onto the endpoint (`meta.open`), so this badge, the group card it sits
 * in and the security screen all say the same thing about the same route.
 */
function EndpointBadge({ node }: { node: LevelNode }) {
  const meta = node.meta as unknown as EndpointMeta;
  if (!['http-route', 'server-action', 'realtime'].includes(meta.endpointKind)) return null;

  const guard = meta.guards[0];
  if (!guard) {
    switch (meta.open?.kind) {
      case 'page':
        return <span className="card-badge badge-public" title={meta.open.because ?? ''}>public page</span>;
      case 'auth-mount':
        return <span className="card-badge badge-public" title={meta.open.because ?? ''}>the sign-in door</span>;
      case 'unreadable':
        return <span className="card-badge badge-unknown" title={meta.open.because ?? ''}>not examined</span>;
      default:
        return <span className="card-badge badge-open">no auth check</span>;
    }
  }
  const certain = meta.guards.some((g) => g.confidence === 'certain');
  const name = guard.provider !== 'custom' ? guard.provider : guard.name;
  return (
    <span className={`card-badge badge-${certain ? 'protected' : 'likely'}`}>
      {certain ? name : `likely · ${name}`}
    </span>
  );
}

function kindGlyph(node: LevelNode): string {
  switch (node.kind) {
    case 'module':
      return '▧';
    case 'file':
      return '▤';
    case 'function':
      return 'ƒ';
    case 'type':
      return '⬡';
    case 'app':
      return '◎';
    case 'zone':
      return (node.meta.direction as string) === 'in' ? '⇥' : '⇤';
    case 'endpoint':
      return '⌾';
    case 'service':
      return '◇';
    case 'store':
      return '⛁';
    default:
      return '•';
  }
}

/** One line of plain English under the name — never a type signature alone. */
function subtitle(node: LevelNode): string {
  switch (node.kind) {
    case 'module': {
      const files = Number(node.meta.descendantFileCount ?? node.meta.fileCount ?? 0);
      return `${files} ${files === 1 ? 'file' : 'files'} · ${zoneLabel(node.zone)}`;
    }
    case 'file': {
      const fns = Number(node.meta.functionCount ?? 0);
      const types = Number(node.meta.typeCount ?? 0);
      const parts: string[] = [];
      if (fns > 0) parts.push(`${fns} ${fns === 1 ? 'function' : 'functions'}`);
      if (types > 0) parts.push(`${types} ${types === 1 ? 'type' : 'types'}`);
      if (parts.length === 0) parts.push(`${Number(node.meta.loc ?? 0)} lines`);
      return parts.join(' · ');
    }
    case 'function': {
      const params = (node.meta.params as ParamInfo[] | undefined) ?? [];
      const returns = String(node.meta.returnType ?? 'void');
      const names = params.map((p) => p.name).join(', ');
      return `(${names}) → ${returns}`;
    }
    case 'type': {
      const kind = String(node.meta.typeKind ?? 'type');
      const fields = ((node.meta.fields as FieldInfo[] | undefined) ?? []).length;
      return fields > 0 ? `${kind} · ${fields} fields` : kind;
    }
    case 'zone': {
      const count = Number(node.meta.endpointCount ?? node.childCount);
      const direction = String(node.meta.direction ?? 'in');
      return direction === 'in' ? `${count} ways data gets in` : `${count} places data goes`;
    }
    case 'endpoint': {
      const meta = node.meta as unknown as EndpointMeta;
      if (meta.endpointKind === 'env') return `${meta.vars?.length ?? 0} variables`;
      if (meta.endpointKind === 'screen') return `${meta.framework} · screen`;
      if (meta.schedule) return `${meta.framework} · ${meta.schedule}`;
      return `${meta.framework} · ${meta.sites.length} ${meta.sites.length === 1 ? 'place' : 'places'}`;
    }
    case 'service': {
      const meta = node.meta as unknown as ServiceMeta;
      const source = meta.packages[0] ?? meta.hosts[0] ?? meta.category;
      return `${source} · ${meta.sites.length} ${meta.sites.length === 1 ? 'call' : 'calls'}`;
    }
    case 'store': {
      const meta = node.meta as unknown as StoreMeta;
      const tables = meta.tables.length;
      return tables > 0 ? `${meta.client} · ${tables} ${tables === 1 ? 'table' : 'tables'}` : meta.client;
    }
    default:
      return node.path ?? '';
  }
}

export function zoneLabel(zone: string): string {
  switch (zone) {
    case 'ui':
      return 'Interface';
    case 'api':
      return 'API';
    case 'logic':
      return 'Logic';
    case 'data':
      return 'Data';
    case 'config':
      return 'Config';
    case 'test':
      return 'Tests';
    default:
      return 'Other';
  }
}

/**
 * The dashed line where the app ends. Everything past it is someone else's
 * computer. Rendered as an ordinary React Flow node so it pans and zooms with the
 * picture instead of floating over it.
 */
export function MembraneNode() {
  return (
    <div className="membrane" aria-hidden="true">
      <span className="membrane-label">where your app ends</span>
    </div>
  );
}
