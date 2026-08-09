#!/usr/bin/env python3
"""Score each run against the oracle, by the rules fixed in docs/agent-trial.md.

No judgment is exercised here. Q4 is counted by hand elsewhere.
"""
import json
import pathlib
import re
import sys

RUNS = pathlib.Path(__file__).parent
TRUTH = json.load(open(pathlib.Path(__file__).parent / 'truth.json'))

# Pre-registered as neither right nor wrong: registered only under a config flag or
# ENV == 'dev', so including or omitting them decides nothing.
EXCUSED = re.compile(r'^/api/v1/(scim|analytics)/|^/api/v1/retrieval/ef/')


def norm(method, path):
    """Trailing slash and parameter names do not distinguish two endpoints."""
    p = re.sub(r'\{[^}]*\}', '{}', path or '')
    if len(p) > 1:
        p = p.rstrip('/')
    return (method.upper().strip(), p)


def truth_set(pred):
    return {norm(r['method'], r['path']) for r in TRUTH if pred(r)}


def truth_auth():
    return {norm(r['method'], r['path']): r['auth'] for r in TRUTH}


def prf(got, want):
    tp = len(got & want)
    p = tp / len(got) if got else 0.0
    r = tp / len(want) if want else 0.0
    f = 2 * p * r / (p + r) if p + r else 0.0
    return p, r, f, tp


def extract(result_text):
    """The first fenced json block that parses and has a q1."""
    for m in re.finditer(r'```(?:json)?\s*(\{.*?\})\s*```', result_text, re.S):
        try:
            d = json.loads(m.group(1))
        except json.JSONDecodeError:
            continue
        if 'q1' in d or 'q3' in d:
            return d
    return None


Q12_PREFIXES = ('/api/v1/notes', '/api/v1/folders')
WANT_Q1 = truth_set(lambda r: r['path'].startswith(Q12_PREFIXES))
WANT_Q3 = {k for k in truth_set(lambda r: r['auth'] == 'open') if not EXCUSED.match(k[1] + '/')}
AUTH = truth_auth()

print(f'answer key: Q1 {len(WANT_Q1)} endpoints, Q3 {len(WANT_Q3)} open endpoints (excused ones removed)\n')

rows = []
for arm in ('control', 'atlas'):
    for i in (1, 2, 3):
        f = RUNS / f'{arm}-{i}.json'
        if not f.exists() or f.stat().st_size == 0:
            continue
        blob = json.load(open(f))
        d = extract(blob.get('result') or '')
        if d is None:
            print(f'{arm}-{i}: NO PARSEABLE JSON BLOCK')
            continue

        got1 = {norm(e['method'], e['path']) for e in d.get('q1', [])}
        p1, r1, f1, _ = prf(got1, WANT_Q1)

        correct_auth = shared = 0
        for e in d.get('q2', []):
            k = norm(e['method'], e['path'])
            if k in WANT_Q1 and k in AUTH:
                shared += 1
                if (e.get('auth') or '').strip().lower() == AUTH[k]:
                    correct_auth += 1
        q2 = correct_auth / shared if shared else 0.0

        got3 = {norm(e['method'], e['path']) for e in d.get('q3', [])}
        got3 = {k for k in got3 if not EXCUSED.match(k[1] + '/')}
        p3, r3, f3, tp3 = prf(got3, WANT_Q3)

        secs = blob.get('duration_ms', 0) / 1000
        analyze = 0.0
        af = RUNS / f'{arm}-{i}.analyze_seconds'
        if af.exists():
            analyze = float(af.read_text().strip())
        u = blob.get('usage', {})
        tok = u.get('output_tokens', 0)
        cin = u.get('input_tokens', 0) + u.get('cache_creation_input_tokens', 0) + u.get('cache_read_input_tokens', 0)

        rows.append(dict(arm=arm, i=i, f1=f1, p1=p1, r1=r1, q2=q2, shared=shared,
                         p3=p3, r3=r3, f3=f3, tp3=tp3, got3=len(got3),
                         secs=secs + analyze, turns=blob.get('num_turns', 0),
                         out=tok, inp=cin, cost=blob.get('total_cost_usd', 0),
                         missed=sorted(WANT_Q3 - got3), spurious=sorted(got3 - WANT_Q3)))

hdr = f'{"run":10} {"Q1 F1":>6} {"Q2 acc":>7} {"Q3 P":>6} {"Q3 R":>6} {"Q3 F1":>6} {"found":>6} {"secs":>7} {"turns":>6} {"out tok":>8} {"$":>7}'
print(hdr)
print('-' * len(hdr))
for r in rows:
    print(f'{r["arm"]+"-"+str(r["i"]):10} {r["f1"]:6.2f} {r["q2"]:7.2f} {r["p3"]:6.2f} {r["r3"]:6.2f} {r["f3"]:6.2f} '
          f'{r["tp3"]:>3}/{r["got3"]:<2} {r["secs"]:7.1f} {r["turns"]:6} {r["out"]:8} {r["cost"]:7.3f}')

print()
for arm in ('control', 'atlas'):
    a = [r for r in rows if r['arm'] == arm]
    if not a:
        continue
    m = lambda k: sum(r[k] for r in a) / len(a)
    print(f'{arm:8} mean  Q1 F1 {m("f1"):.2f}  Q2 {m("q2"):.2f}  Q3 P {m("p3"):.2f} R {m("r3"):.2f} F1 {m("f3"):.2f}  '
          f'{m("secs"):.0f}s  {m("turns"):.0f} turns  ${m("cost"):.2f}')

if len(rows) == 6:
    c = [r for r in rows if r['arm'] == 'control']
    a = [r for r in rows if r['arm'] == 'atlas']
    mc = sum(r['f3'] for r in c) / 3
    ma = sum(r['f3'] for r in a) / 3
    pc = sum(r['p3'] for r in c) / 3
    pa = sum(r['p3'] for r in a) / 3
    print(f'\nFALSIFICATION CHECK (pre-registered)')
    print(f'  Q3 F1 lift {ma - mc:+.2f} — needs >= +0.15 : {"PASS" if ma - mc >= 0.15 else "FAIL"}')
    print(f'  Q3 precision atlas {pa:.2f} vs control {pc:.2f} : {"PASS" if pa >= pc else "FAIL — the map hurt"}')

print('\n--- per-run Q3 detail ---')
for r in rows:
    print(f'\n{r["arm"]}-{r["i"]}: {len(r["spurious"])} invented, {len(r["missed"])} missed')
    for s in r['spurious']:
        print(f'   INVENTED {s[0]:6} {s[1]}')
    for s in r['missed']:
        print(f'   missed   {s[0]:6} {s[1]}')
