/**
 * @fileoverview The card that represents one node on the canvas.
 *
 * Cards are ordinary React components (that is why React Flow was chosen), so a
 * folder, a file and a type can each look like what they are instead of all being
 * circles. Colour always means zone; nothing else is colour-coded.
 */
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { LevelNode, ParamInfo, FieldInfo } from '../types';

export interface AtlasCardData extends Record<string, unknown> {
  node: LevelNode;
  dim: boolean;
  focus: boolean;
  onDrill: (id: string) => void;
}

export function AtlasNodeCard({ data, selected }: NodeProps) {
  const { node, dim, focus, onDrill } = data as unknown as AtlasCardData;
  const classes = [
    'card',
    `card-${node.kind}`,
    `zone-${node.zone}`,
    dim ? 'is-dim' : '',
    focus ? 'is-focus' : '',
    selected ? 'is-selected' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
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
