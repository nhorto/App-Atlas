/**
 * @fileoverview Pick a way in, and see where it can get to (SPEC.md 6.4).
 *
 * The walkthrough answers "what happens here" in five paragraphs and stops. This is
 * the surface for the question people ask next — *where does this go, and where does
 * it leave my app* — so it hands over the whole reachable set at once and lets the
 * reader wander down a branch nobody wrote a sentence about.
 *
 * Two things it must keep saying while they wander. A link means one piece of code
 * names another, which is not a recording of a call that happened, so the wording is
 * "can reach" throughout and never "does". And the walk is bounded, so wherever it was
 * cut short it says so on the page rather than letting a partial answer read as a
 * complete one.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchDoors, fetchFlow } from '../api';
import type { DoorList, DoorSummary, FlowExit, FlowStop, FlowView } from '../types';
import { ErrorPaste } from './ErrorPaste';

interface Props {
  /** Open something on the map, which is where "show me this properly" leads. */
  onReveal: (id: string) => void;
  /** Select something, which fills the detail panel beside this screen. */
  onSelect: (id: string) => void;
  selectedId: string | null;
}

export function TraceScreen({ onReveal, onSelect, selectedId }: Props) {
  const [doors, setDoors] = useState<DoorList | null>(null);
  const [doorId, setDoorId] = useState<string | null>(null);
  const [flow, setFlow] = useState<FlowView | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** The stop the reader is following, which dims everything off its branch. */
  const [branchFrom, setBranchFrom] = useState<string | null>(null);
  /**
   * Which way round the reader is working. Both directions are the same map — pick a
   * door and follow it out, or arrive holding an error and walk back to the doors —
   * so they share a screen rather than splitting the ways-in list across two tabs.
   */
  const [mode, setMode] = useState<'forward' | 'error'>('forward');

  /** Following a door out of the error view is what the forward view already does. */
  const followDoor = useCallback((id: string) => {
    setDoorId(id);
    setMode('forward');
  }, []);

  useEffect(() => {
    let stale = false;
    fetchDoors()
      .then((list) => {
        if (stale) return;
        setDoors(list);
        // Land on something rather than an empty stage: the first door that has code
        // behind it shows what this screen is for, and an unanswered one does not.
        const first = list.groups.flatMap((group) => group.doors).find((door) => door.answered);
        setDoorId((current) => current ?? first?.id ?? null);
      })
      .catch((problem: Error) => !stale && setError(problem.message));
    return () => {
      stale = true;
    };
  }, []);

  useEffect(() => {
    if (!doorId) return;
    let stale = false;
    setBranchFrom(null);
    fetchFlow(doorId)
      .then((found) => !stale && setFlow(found))
      .catch((problem: Error) => !stale && setError(problem.message));
    return () => {
      stale = true;
    };
  }, [doorId]);

  const matches = useMemo(() => filterDoors(doors, query), [doors, query]);
  const onBranch = useMemo(() => branchOf(flow, branchFrom), [flow, branchFrom]);

  if (error) return <p className="trace-empty">{error}</p>;
  if (!doors) return <p className="trace-empty">Reading the ways in…</p>;
  if (doors.total === 0) {
    return <p className="trace-empty">App Atlas found no ways into this project, so there is nothing to follow.</p>;
  }

  return (
    <div className="trace">
      <aside className="trace-doors">
        <div className="trace-search">
          <div className="trace-modes" role="tablist" aria-label="Which way to trace">
            <button
              role="tab"
              aria-selected={mode === 'forward'}
              className={mode === 'forward' ? 'trace-mode is-current' : 'trace-mode'}
              onClick={() => setMode('forward')}
            >
              Follow a way in
            </button>
            <button
              role="tab"
              aria-selected={mode === 'error'}
              className={mode === 'error' ? 'trace-mode is-current' : 'trace-mode'}
              onClick={() => setMode('error')}
            >
              Paste an error
            </button>
          </div>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a way in"
            aria-label="Find a way in"
          />
          <p className="trace-count">
            {doors.total} {doors.total === 1 ? 'way in' : 'ways in'}
            {doors.unanswered > 0 ? ` · ${doors.unanswered} with no code behind them` : ''}
          </p>
        </div>

        {matches.length === 0 ? (
          <p className="trace-none">Nothing matches “{query}”.</p>
        ) : (
          matches.map((group) => (
            <section key={group.kind} className="trace-group">
              <h3>
                {group.label} <span className="trace-group-count">{group.doors.length}</span>
              </h3>
              <ul>
                {group.doors.map((door) => (
                  <li key={door.id}>
                    <button
                      className={door.id === doorId ? 'trace-door is-current' : 'trace-door'}
                      aria-current={door.id === doorId ? 'true' : undefined}
                      onClick={() => setDoorId(door.id)}
                    >
                      <span className="trace-door-name">
                        {door.method && door.method !== 'SCREEN' ? (
                          <span className="trace-method">{door.method}</span>
                        ) : null}
                        {door.route ?? door.name}
                      </span>
                      <span className="trace-door-marks">
                        {door.writes ? <span className="trace-mark is-writes">writes</span> : null}
                        {door.guards.length === 0 && door.answered ? (
                          <span className="trace-mark is-open">no check</span>
                        ) : null}
                        {!door.answered ? <span className="trace-mark is-unanswered">not followed</span> : null}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </aside>

      <div className="trace-flow">
        {mode === 'error' ? (
          <ErrorPaste onSelect={onSelect} onFollowDoor={followDoor} />
        ) : flow ? (
          <Flow
            flow={flow}
            onBranch={onBranch}
            branchFrom={branchFrom}
            setBranchFrom={setBranchFrom}
            onReveal={onReveal}
            onSelect={onSelect}
            selectedId={selectedId}
          />
        ) : (
          <p className="trace-empty">Following it…</p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Flow({
  flow,
  onBranch,
  branchFrom,
  setBranchFrom,
  onReveal,
  onSelect,
  selectedId,
}: {
  flow: FlowView;
  onBranch: Set<string> | null;
  branchFrom: string | null;
  setBranchFrom: (id: string | null) => void;
  onReveal: (id: string) => void;
  onSelect: (id: string) => void;
  selectedId: string | null;
}) {
  const hops = useMemo(() => byHop(flow.stops), [flow.stops]);

  return (
    <>
      <header className="trace-head">
        <h2>What happens when {flow.trigger}</h2>
        <p className="trace-sub">
          {flow.door.framework}
          {flow.door.path ? ` · ${flow.door.path}` : ''}
        </p>
        <div className="trace-badges">
          {flow.door.guards.length > 0 ? (
            <span className="trace-badge is-guarded" title={guardEvidence(flow.door)}>
              {guardLabel(flow.door)}
            </span>
          ) : flow.door.answered ? (
            <span className="trace-badge is-open">No auth check found</span>
          ) : null}
          {flow.door.writes ? <span className="trace-badge is-writes">Writes data</span> : null}
        </div>
        <button className="trace-open" onClick={() => onReveal(flow.door.id)}>
          Show this door on the map →
        </button>
      </header>

      {!flow.door.answered ? (
        <div className="trace-note">
          <p>
            This door is real — the framework serves it — but no file in this repo was found on the other side of
            it. Routes published straight from a database schema or declared in a routing table away from their
            handler land here.
          </p>
          <p className="trace-note-quiet">
            So this is not “nothing happens”. It is App Atlas saying it could not follow the way in, which is a
            different thing and the only honest one to show.
          </p>
        </div>
      ) : null}

      {hops.length > 0 ? (
        <ol className="trace-layers">
          {hops.map(({ hop, stops }) => (
            <li key={hop} className="trace-layer">
              <p className="trace-layer-label">
                {hop === 1 ? 'Your code answers' : 'which can reach'}
                <span className="trace-layer-count">
                  {stops.length} {stops.length === 1 ? 'piece' : 'pieces'}
                </span>
              </p>
              <div className="trace-chips">
                {stops.map((stop) => (
                  <Chip
                    key={stop.id}
                    stop={stop}
                    dim={onBranch !== null && !onBranch.has(stop.id)}
                    following={stop.id === branchFrom}
                    selected={stop.id === selectedId}
                    onFollow={() => setBranchFrom(branchFrom === stop.id ? null : stop.id)}
                    onSelect={() => onSelect(stop.id)}
                  />
                ))}
              </div>
            </li>
          ))}
        </ol>
      ) : null}

      {flow.exits.length > 0 ? (
        <section className="trace-exits">
          <p className="trace-layer-label">and can leave through</p>
          <div className="trace-exit-cards">
            {flow.exits.map((exit) => (
              <Exit
                key={exit.id}
                exit={exit}
                dim={onBranch !== null && !exit.reachedBy.some((id) => onBranch.has(id))}
                onSelect={() => onSelect(exit.id)}
              />
            ))}
          </div>
        </section>
      ) : flow.door.answered ? (
        <p className="trace-nowhere">
          Nothing on this path reaches a database or another company’s API. Whatever it does, it keeps to itself.
        </p>
      ) : null}

      <Limits flow={flow} />
    </>
  );
}

function Chip({
  stop,
  dim,
  following,
  selected,
  onFollow,
  onSelect,
}: {
  stop: FlowStop;
  dim: boolean;
  following: boolean;
  selected: boolean;
  onFollow: () => void;
  onSelect: () => void;
}) {
  const classes = ['trace-chip', `zone-${stop.zone}`];
  if (dim) classes.push('is-dim');
  if (following) classes.push('is-following');
  if (selected) classes.push('is-selected');

  return (
    <span className={classes.join(' ')}>
      <button className="trace-chip-main" onClick={onSelect} title={stop.path ?? undefined}>
        <span className="trace-chip-name">{stop.name}</span>
        {stop.path ? <span className="trace-chip-path">{stop.path}</span> : null}
      </button>
      <button
        className="trace-chip-follow"
        onClick={onFollow}
        aria-pressed={following}
        aria-label={following ? `Stop following ${stop.name}` : `Follow the branch through ${stop.name}`}
        title={following ? 'Show everything again' : 'Show only what this touches'}
      >
        {following ? '×' : '⌥'}
      </button>
    </span>
  );
}

function Exit({ exit, dim, onSelect }: { exit: FlowExit; dim: boolean; onSelect: () => void }) {
  return (
    <button className={dim ? 'trace-exit is-dim' : 'trace-exit'} onClick={onSelect}>
      <span className="trace-exit-name">{exit.name}</span>
      {exit.detail ? <span className="trace-exit-detail">{exit.detail}</span> : null}
      <span className={exit.writes ? 'trace-mark is-writes' : 'trace-mark'}>
        {exit.writes ? 'writes' : 'reads'}
      </span>
    </button>
  );
}

/**
 * Where the walk stopped, on the page.
 *
 * A bounded traversal that renders exactly like a complete one is the failure this
 * whole screen is most exposed to: the reader's next move is to conclude their data
 * goes nowhere else, and they would be concluding it from a list that was cut off.
 */
function Limits({ flow }: { flow: FlowView }) {
  const said: string[] = [];
  if (flow.limits.hitDepth) {
    said.push(
      `This stops ${flow.maxHop} steps out from the door, and the code at that edge names more that is not drawn here.`,
    );
  }
  if (flow.limits.hitStops) said.push('The path is wider than this screen will draw; some of it is not shown.');
  if (flow.limits.exitsHidden > 0) {
    said.push(
      `${flow.limits.exitsHidden} more ${flow.limits.exitsHidden === 1 ? 'place' : 'places'} data leaves through ${
        flow.limits.exitsHidden === 1 ? 'is' : 'are'
      } not listed.`,
    );
  }

  return (
    <footer className="trace-foot">
      {said.length > 0 ? <p className="trace-cut">{said.join(' ')}</p> : null}
      <p>
        Every line here comes from the compiler. A link means one piece of code names another — so this is
        everywhere control <em>can</em> go from this door, not a recording of a run.
      </p>
    </footer>
  );
}

// ---------------------------------------------------------------------------

function byHop(stops: FlowStop[]): { hop: number; stops: FlowStop[] }[] {
  const layers = new Map<number, FlowStop[]>();
  for (const stop of stops) {
    const layer = layers.get(stop.hop);
    if (layer) layer.push(stop);
    else layers.set(stop.hop, [stop]);
  }
  return [...layers.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hop, found]) => ({ hop, stops: found.sort((a, b) => a.name.localeCompare(b.name)) }));
}

/**
 * Everything one stop touches, in both directions — what it can reach, and what had to
 * run for it to be reached at all. Both halves matter: following a branch is as often
 * "how does anything even get here" as "where does this end up".
 */
function branchOf(flow: FlowView | null, from: string | null): Set<string> | null {
  if (!flow || !from) return null;
  const forward = new Map<string, string[]>();
  const backward = new Map<string, string[]>();
  for (const link of flow.links) {
    pushTo(forward, link.fromId, link.toId);
    pushTo(backward, link.toId, link.fromId);
  }

  const found = new Set<string>([from]);
  for (const graph of [forward, backward]) {
    const queue = [from];
    while (queue.length > 0) {
      const at = queue.shift() as string;
      for (const next of graph.get(at) ?? []) {
        if (found.has(next)) continue;
        found.add(next);
        queue.push(next);
      }
    }
  }
  return found;
}

function pushTo(map: Map<string, string[]>, key: string, value: string): void {
  const already = map.get(key);
  if (already) already.push(value);
  else map.set(key, [value]);
}

function filterDoors(doors: DoorList | null, query: string): DoorList['groups'] {
  if (!doors) return [];
  const needle = query.trim().toLowerCase();
  if (!needle) return doors.groups;
  return doors.groups
    .map((group) => ({
      ...group,
      doors: group.doors.filter((door) =>
        `${door.method ?? ''} ${door.route ?? ''} ${door.name} ${door.framework}`.toLowerCase().includes(needle),
      ),
    }))
    .filter((group) => group.doors.length > 0);
}

/**
 * The call that does the checking, pulled out of the chain that found it.
 *
 * A guard found several hops from the door carries the whole route to it as its name —
 * `CellarBottleForm → suggest → sendMessage → supabase.auth.getSession`. That chain is
 * the evidence and is worth keeping, but as a badge it is a sentence pretending to be
 * a label, so the badge takes the check at the end of it and the chain becomes the
 * tooltip.
 */
function checkName(guard: DoorSummary['guards'][number]): string {
  const written = guard.provider === 'custom' ? guard.name : guard.provider;
  const last = written.split('→').pop()?.trim();
  return last && last.length > 0 ? last : written;
}

/**
 * What is checking this door, and how many places do it.
 *
 * The count is on the badge because one check and five checks are different facts
 * about a door, and showing the first of five said the smaller one.
 */
function guardLabel(door: DoorSummary): string {
  const names = [...new Set(door.guards.map(checkName))];
  const hedged = door.guards.some((guard) => guard.confidence !== 'certain');
  const verb = hedged ? 'probably checks' : 'checks';

  if (door.guards.length === 1) return `${names[0]} ${verb} the caller`;

  const shown = names.slice(0, 2).join(', ');
  const rest = names.length > 2 ? `, +${names.length - 2} more` : '';
  return `Checked in ${door.guards.length} places · ${shown}${rest}${hedged ? ' · likely' : ''}`;
}

/** The full chains, kept where a reader can reach them without being shown a paragraph. */
function guardEvidence(door: DoorSummary): string {
  return door.guards
    .map((guard) => `${guard.provider === 'custom' ? guard.name : guard.provider}${guard.path ? ` (${guard.path}:${guard.line ?? '?'})` : ''}`)
    .join('\n');
}
