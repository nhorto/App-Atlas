/**
 * @fileoverview Paste an error, and see where it came from.
 *
 * The other half of the Trace tab. Forward you pick a door and follow it out; here you
 * arrive holding a stack trace and the app works backwards to the ways in that can
 * reach whatever broke.
 *
 * Nothing on this screen is generated. Frames are read with per-language patterns,
 * matched to files by path and line, and the doors come out of the graph — so the
 * things it must keep saying are the things it cannot know: which frames it failed to
 * place and why, and that several doors reaching the failure is an answer rather than
 * a list to pick from. Somebody reading this is already frustrated enough to be
 * pasting an error, and an hour spent in the wrong file is the worst thing this could
 * do to them.
 */
import { useState } from 'react';
import { explainTrace, suggestStart, traceError } from '../api';
import type {
  DoorReach,
  ErrorTraceResult,
  ErrorWords,
  PlacedFrame,
  StartingPoints,
  UnplacedReason,
} from '../types';

interface Props {
  /** Select something, which fills the detail panel beside this screen. */
  onSelect: (id: string) => void;
  /** Follow one of the doors that can reach the failure, forward, on the same tab. */
  onFollowDoor: (id: string) => void;
  /** False under --no-ai, which hides the one button here that costs anything. */
  aiEnabled: boolean;
}

/** Past this many doors the list stops being an answer and becomes a directory. */
const DOORS_SHOWN = 6;

export function ErrorPaste({ onSelect, onFollowDoor, aiEnabled }: Props) {
  const [pasted, setPasted] = useState('');
  const [result, setResult] = useState<ErrorTraceResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!pasted.trim()) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await traceError(pasted));
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="paste">
      <header className="paste-head">
        <h2>Paste an error</h2>
        <p>
          A stack trace from anywhere — your terminal, the browser console, a log. App Atlas reads the file and line
          out of each frame, finds them in your code, and works back to the ways in that can reach them.
        </p>
      </header>

      <textarea
        className="paste-box"
        value={pasted}
        onChange={(event) => setPasted(event.target.value)}
        placeholder={'TypeError: Cannot read properties of undefined\n    at addBottle (lib/cellar.js:203:18)\n    at AddBottleScreen (app/cellar/add.js:64:5)'}
        spellCheck={false}
        rows={8}
        aria-label="Paste a stack trace"
      />

      <div className="paste-actions">
        <button className="paste-go" onClick={() => void run()} disabled={busy || !pasted.trim()}>
          {busy ? 'Reading it…' : 'Trace it'}
        </button>
        {result || error ? (
          <button
            className="paste-clear"
            onClick={() => {
              setPasted('');
              setResult(null);
              setError(null);
            }}
          >
            Clear
          </button>
        ) : null}
        <span className="paste-privacy">Stays on this machine — nothing is sent anywhere.</span>
      </div>

      {error ? <p className="paste-error">{error}</p> : null}
      {result ? (
        <Result
          result={result}
          pasted={pasted}
          aiEnabled={aiEnabled}
          onSelect={onSelect}
          onFollowDoor={onFollowDoor}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Result({
  result,
  pasted,
  aiEnabled,
  onSelect,
  onFollowDoor,
}: {
  result: ErrorTraceResult;
  pasted: string;
  aiEnabled: boolean;
  onSelect: (id: string) => void;
  onFollowDoor: (id: string) => void;
}) {
  if (result.parsedNothing) {
    return <NoFrames described={pasted} aiEnabled={aiEnabled} onSelect={onSelect} />;
  }

  return (
    <div className="paste-result">
      <Frames frames={result.frames} onSelect={onSelect} />
      {result.origin ? (
        <>
          <Doors result={result} onFollowDoor={onFollowDoor} />
          {aiEnabled ? <Explanation pasted={pasted} /> : null}
        </>
      ) : (
        <div className="paste-note">
          <p>None of those frames is code in this project.</p>
          <p className="paste-note-quiet">
            The failure surfaced entirely inside dependencies or the runtime, so there is nothing here to trace back
            to a way in. The question worth asking next is which of your own code calls into that library.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * The one generated thing on this screen, and the last thing on it.
 *
 * It comes after the path rather than instead of it, and it is asked for rather than
 * offered: the compiler's answer is complete without this, and a paragraph that
 * appeared automatically above the evidence would read as the finding rather than a
 * comment on it. The label says a model wrote it, in the same register the rest of the
 * tool uses for generated text.
 */
function Explanation({ pasted }: { pasted: string }) {
  const [words, setWords] = useState<ErrorWords | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  if (words) {
    return (
      <section className="paste-said">
        <p className="paste-label">
          What this could be
          <span className="paste-said-mark">
            written by {words.cached ? 'a model, from an earlier run' : (words.backend ?? 'a model')}
          </span>
        </p>
        <p className="paste-said-text">{words.text}</p>
        {words.dropped.length > 0 ? (
          <p className="paste-said-dropped">
            Part of the answer named {words.dropped.join(', ')}, which is not on this path, so that sentence was
            dropped.
          </p>
        ) : null}
        <p className="paste-said-caveat">
          A guess about the path above, not a finding. Everything before this line came from your code; this line
          did not.
        </p>
      </section>
    );
  }

  return (
    <section className="paste-said is-offer">
      <button
        className="paste-explain"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setFailed(null);
          explainTrace(pasted)
            .then(setWords)
            .catch((problem: Error) => setFailed(problem.message))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? 'Thinking…' : 'Ask what this could be'}
      </button>
      <span className="paste-said-mark">
        Sends this trace and the code it points at to your AI backend. Everything above was worked out without one.
      </span>
      {failed ? <p className="paste-error">{failed}</p> : null}
    </section>
  );
}

/**
 * The lane for a paste with no frames in it — somebody describing a symptom.
 *
 * There is no path to compute here, so the honest move is to say that first and then
 * offer something visibly weaker. What the model gets is a shortlist searched out of
 * the atlas, and every id it picks is checked against the graph before it reaches this
 * screen, so the worst case is an unhelpful suggestion rather than a file that does
 * not exist.
 */
function NoFrames({
  described,
  aiEnabled,
  onSelect,
}: {
  described: string;
  aiEnabled: boolean;
  onSelect: (id: string) => void;
}) {
  const [found, setFound] = useState<StartingPoints | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  return (
    <div className="paste-result">
      <div className="paste-note">
        <p>Nothing in that paste looked like a stack frame, so there is no file or line to start from.</p>
        <p className="paste-note-quiet">
          With a trace, everything on this screen is worked out from your code. Without one there is nothing to
          work from — so App Atlas will not turn a description into a location and call it the same thing.
        </p>
      </div>

      {aiEnabled && !found ? (
        <section className="paste-said is-offer">
          <button
            className="paste-explain"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setFailed(null);
              suggestStart(described)
                .then(setFound)
                .catch((problem: Error) => setFailed(problem.message))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? 'Looking…' : 'Suggest where to start anyway'}
          </button>
          <span className="paste-said-mark">
            Searches your codebase for what you described and asks a model which of the matches to open. A guess
            from names, not from a trace.
          </span>
          {failed ? <p className="paste-error">{failed}</p> : null}
        </section>
      ) : null}

      {found ? (
        <section className="paste-said">
          <p className="paste-label">
            Places worth opening
            <span className="paste-said-mark">chosen by {found.backend ?? 'a model'}, from a search of your code</span>
          </p>
          {found.picks.length === 0 ? (
            <p className="paste-said-text">
              Nothing in your codebase looked like a match for that, so there is no honest suggestion to make.
              {found.because ? ` ${found.because}` : ''}
            </p>
          ) : (
            <>
              {found.because ? <p className="paste-said-text">{found.because}</p> : null}
              <ul className="paste-picks">
                {found.picks.map((pick) => (
                  <li key={pick.nodeId}>
                    <button className="paste-pick" onClick={() => onSelect(pick.nodeId)}>
                      <span className="paste-frame-name">{pick.name}</span>
                      <span className="paste-frame-where">{pick.path}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="paste-said-caveat">
            These were picked from names and descriptions, not from a stack trace. If you can get one, paste it —
            it will beat this by a mile.
          </p>
        </section>
      ) : null}
    </div>
  );
}

function Frames({ frames, onSelect }: { frames: PlacedFrame[]; onSelect: (id: string) => void }) {
  const placed = frames.filter((found) => found.nodeId).length;

  return (
    <section className="paste-frames">
      <p className="paste-label">
        {frames.length} {frames.length === 1 ? 'frame' : 'frames'} read
        <span className="paste-label-count">{placed} in your code</span>
      </p>
      <ol className="paste-frame-list">
        {frames.map((found, index) => (
          <li key={`${found.frame.rawPath}:${found.frame.line}:${index}`}>
            {found.nodeId ? (
              <button className="paste-frame is-placed" onClick={() => onSelect(found.nodeId as string)}>
                <span className="paste-frame-name">{found.nodeName}</span>
                <span className="paste-frame-where">
                  {found.path}:{found.frame.line}
                </span>
                {found.nameDrifted ? (
                  <span
                    className="paste-drift"
                    title={`The trace called this ${found.frame.functionName}. The file is right; the exact function may have moved since the trace was taken.`}
                  >
                    named {found.frame.functionName} in the trace
                  </span>
                ) : null}
              </button>
            ) : (
              <div className="paste-frame is-unplaced">
                <span className="paste-frame-name">{found.frame.functionName ?? found.frame.rawPath}</span>
                <span className="paste-frame-where">
                  {found.frame.rawPath}:{found.frame.line}
                </span>
                <span className="paste-why">{whyUnplaced(found.reason, found.candidates)}</span>
              </div>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function Doors({ result, onFollowDoor }: { result: ErrorTraceResult; onFollowDoor: (id: string) => void }) {
  const [showAll, setShowAll] = useState(false);
  const origin = result.origin as PlacedFrame;
  const shown = showAll ? result.doors : result.doors.slice(0, DOORS_SHOWN);
  const hidden = result.doors.length - shown.length;

  return (
    <section className="paste-doors">
      <p className="paste-label">
        The error happened in <strong>{origin.nodeName}</strong>
        <span className="paste-label-count">
          {origin.path}:{origin.frame.line}
        </span>
      </p>

      {result.doors.length === 0 ? (
        <div className="paste-note">
          <p>No way into the app reaches that code by any reference App Atlas can follow.</p>
          <p className="paste-note-quiet">
            That is “none found”, not “none exists”. Code called through a dynamic lookup, a string name or
            reflection leaves no link behind for this to follow.
          </p>
        </div>
      ) : (
        <>
          <p className="paste-lede">
            {result.doors.length === 1
              ? 'One way in can reach it:'
              : `${result.doors.length} ways in can reach it. Any of them could be the one that ran — the code does not say which.`}
          </p>
          <ul className="paste-door-list">
            {shown.map((reach) => (
              <Door key={reach.door.id} reach={reach} onFollow={() => onFollowDoor(reach.door.id)} />
            ))}
          </ul>
          {hidden > 0 ? (
            <button className="paste-more" onClick={() => setShowAll(true)}>
              Show {hidden} more {hidden === 1 ? 'way' : 'ways'} in
            </button>
          ) : null}
        </>
      )}

      <footer className="paste-foot">
        {result.searchTruncated ? (
          <p className="paste-cut">
            The search back through your code hit its ceiling before running out of places to look, so this list may
            be short.
          </p>
        ) : null}
        <p>
          These are ways in that <em>can</em> reach the failing code, found by following references backwards. A
          stack trace says where the program was; these links say where control can go. Neither says which door was
          used on the run that broke.
        </p>
      </footer>
    </section>
  );
}

function Door({ reach, onFollow }: { reach: DoorReach; onFollow: () => void }) {
  return (
    <li className="paste-door">
      <button className="paste-door-main" onClick={onFollow} title="Follow this way in, forwards">
        <span className="paste-door-name">
          {reach.door.method && reach.door.method !== 'SCREEN' ? (
            <span className="trace-method">{reach.door.method}</span>
          ) : null}
          {reach.door.route ?? reach.door.name}
        </span>
        <span className="paste-door-chain">{reach.viaNames.join(' → ')}</span>
      </button>
      <span className="paste-door-marks">
        <span className="trace-mark">
          {reach.hops} {reach.hops === 1 ? 'hop' : 'hops'}
        </span>
        {reach.confidence !== 'certain' ? <span className="trace-mark is-open">{reach.confidence}</span> : null}
        {reach.door.guards.length === 0 ? <span className="trace-mark is-open">no check</span> : null}
      </span>
    </li>
  );
}

function whyUnplaced(reason: UnplacedReason | null, candidates: string[]): string {
  switch (reason) {
    case 'dependency':
      return 'a dependency, not your code';
    case 'runtime':
      return 'the runtime itself';
    case 'ambiguous':
      return `${candidates.length} files here could be this one — the trace does not say which`;
    default:
      return 'no file here matches that path';
  }
}
