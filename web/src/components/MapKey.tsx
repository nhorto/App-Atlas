/**
 * @fileoverview The key to the Map: what the colours mean, what the arrows mean, and
 * which of them you are currently being shown.
 *
 * This replaces a row of coloured dots that looked like a filter and was not one
 * (#91). Six dots along the bottom edge of a canvas is the shape of a filter control in
 * every mapping tool anyone has used, so reading it as one was not a misunderstanding of
 * the screen — it was the screen implying something it did not do.
 *
 * It does it now, under one rule: **hiding is fine, hiding silently is not.** A zone
 * that is switched off says so where it used to say its name, with the number of boxes
 * it is holding back at this level, and it is one click from coming back.
 */
import { ARROWS, ARROW_BUDGET, type ArrowStyle, type HiddenZone } from '../mapview';
import type { Zone } from '../types';
import { zoneLabel } from './AtlasNodeCard';

interface Props {
  /** The zones this project actually has. A dot for a zone with nothing in it invites
      the reader to go looking for something that is not there. */
  zones: Zone[];
  hiddenZones: Set<Zone>;
  /** What the filter is holding back at this level, per zone. */
  hidden: HiddenZone[];
  onToggleZone: (zone: Zone) => void;
  /** Arrows on screen, and arrows there would be without the budget. */
  arrowsShown: number;
  arrowsTotal: number;
  showAllArrows: boolean;
  onToggleArrows: () => void;
}

export function MapKey({
  zones,
  hiddenZones,
  hidden,
  onToggleZone,
  arrowsShown,
  arrowsTotal,
  showAllArrows,
  onToggleArrows,
}: Props) {
  const hiddenCount = new Map(hidden.map((entry) => [entry.zone, entry.count]));
  const capped = arrowsShown < arrowsTotal;

  return (
    <div className="mapkey">
      <div className="mapkey-row">
        <span className="mapkey-title">Colour</span>
        {zones.map((zone) => {
          const off = hiddenZones.has(zone);
          const held = hiddenCount.get(zone) ?? 0;
          return (
            <button
              key={zone}
              className={off ? 'legend-item is-off' : 'legend-item'}
              onClick={() => onToggleZone(zone)}
              // The title carries the whole promise, because the chip only has room for
              // the number: what happens on click, and what is being held back.
              title={
                off
                  ? `${zoneLabel(zone)} is hidden${held > 0 ? ` — ${held} on this level` : ''}. Click to show it.`
                  : `Click to hide ${zoneLabel(zone)}`
              }
              aria-pressed={!off}
            >
              <span className={`dot zone-${zone}`} />
              {/* The strike belongs to the name alone. A line drawn through the count
                  as well would cross out the very thing the count is there to say. */}
              <span className="legend-name">{zoneLabel(zone)}</span>
              {off ? <span className="legend-off">{held > 0 ? `${held} hidden` : 'hidden'}</span> : null}
            </button>
          );
        })}
      </div>

      <div className="mapkey-row">
        <span className="mapkey-title">Arrows</span>
        {ARROWS.filter((arrow) => arrow.kind !== 'both').map((arrow) => (
          <span key={arrow.kind} className="legend-item" title={arrow.means}>
            <ArrowGlyph arrow={arrow} />
            {arrow.word}
          </span>
        ))}
        <span className="legend-item legend-note">
          the number is how many of them one line stands for
        </span>
      </div>

      {capped || showAllArrows ? (
        <div className="mapkey-row">
          <span className="mapkey-title">Showing</span>
          <span className="legend-item legend-note">
            {showAllArrows
              ? `all ${arrowsTotal} arrows`
              : `the ${arrowsShown} heaviest of ${arrowsTotal} arrows`}
          </span>
          <button className="legend-link" onClick={onToggleArrows}>
            {showAllArrows ? `show the top ${ARROW_BUDGET}` : 'show them all'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The line as it is actually drawn, at the size of a word.
 *
 * Drawn from the same {@link ArrowStyle} the canvas draws from, including which end
 * carries the head — a key that showed the head at the wrong end would be worse than no
 * key, since the whole point of #90 is that the head now means something.
 */
function ArrowGlyph({ arrow }: { arrow: ArrowStyle }) {
  const head = <path d="M0,0 L7,3.2 L0,6.4 Z" fill={arrow.stroke} />;
  return (
    <svg className="arrow-glyph" width="30" height="7" viewBox="0 0 30 7" aria-hidden="true">
      <line x1="1" y1="3.2" x2="29" y2="3.2" stroke={arrow.stroke} strokeWidth="1.6" />
      {arrow.head === 'start' || arrow.head === 'both' ? (
        <g transform="translate(8,0) rotate(180,0,3.2)">{head}</g>
      ) : null}
      {arrow.head === 'end' || arrow.head === 'both' ? <g transform="translate(22,0)">{head}</g> : null}
    </svg>
  );
}
