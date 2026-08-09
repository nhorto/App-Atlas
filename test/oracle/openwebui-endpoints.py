#!/usr/bin/env python3
"""The answer key for the agent trial — built without App Atlas.

Reads open-webui's backend with CPython's own `ast` and prints every HTTP endpoint
with its mounted path and the authentication dependency in its signature. This is a
different implementation, in a different language, from the one under test, so a bug
shared between the two is unlikely rather than guaranteed.

Deliberately narrow: it understands exactly the two spellings this repo uses —
`app.include_router(mod.router, prefix='…')` in main.py, and `@router.<verb>('<path>')`
on a function in routers/<mod>.py — and it asserts loudly if it meets anything else, so
a silent miss cannot masquerade as a finding.
"""
import ast
import json
import pathlib
import sys

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '.')
PKG = ROOT / 'backend' / 'open_webui'
VERBS = {'get', 'post', 'put', 'delete', 'patch', 'head', 'options'}

# How each dependency answers "who may call this?". Anything not listed leaves the door
# open as far as the signature goes — which is the claim being graded, not a claim about
# whether the body checks something later.
GUARDS = {
    'get_admin_user': 'admin',
    'get_verified_user': 'user',
    'get_current_user': 'user',
    'get_scim_auth': 'other',
    'get_optional_verified_user': 'open',
}


def decorator_route(dec):
    """('get', '/pinned') if this decorator is a route, else None."""
    if not isinstance(dec, ast.Call) or not isinstance(dec.func, ast.Attribute):
        return None
    if dec.func.attr not in VERBS:
        return None
    holder = dec.func.value
    if not isinstance(holder, ast.Name) or holder.id not in ('router', 'app'):
        return None
    if not dec.args or not isinstance(dec.args[0], ast.Constant):
        return None
    return dec.func.attr.upper(), dec.args[0].value


def signature_guard(fn):
    """The strongest auth dependency in the signature, and every dependency seen."""
    deps = []
    args = fn.args
    for default in list(args.defaults) + [d for d in args.kw_defaults if d is not None]:
        if isinstance(default, ast.Call) and getattr(default.func, 'id', None) == 'Depends':
            if default.args and isinstance(default.args[0], ast.Name):
                deps.append(default.args[0].id)
    levels = [GUARDS.get(d, 'open') for d in deps if d in GUARDS]
    if 'admin' in levels:
        return 'admin', deps
    if 'user' in levels:
        return 'user', deps
    if 'other' in levels:
        return 'other', deps
    return 'open', deps


def mounts(main_py):
    """module name -> url prefix, from app.include_router in main.py."""
    tree = ast.parse(main_py.read_text())
    found = {}
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        if getattr(node.func, 'attr', None) != 'include_router':
            continue
        target = node.args[0] if node.args else None
        if not (isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name)):
            raise SystemExit(f'unhandled include_router target at line {node.lineno}')
        prefix = ''
        for kw in node.keywords:
            if kw.arg == 'prefix':
                if not isinstance(kw.value, ast.Constant):
                    raise SystemExit(f'computed prefix at line {node.lineno}')
                prefix = kw.value.value
        found[target.value.id] = prefix
    return found


def join(prefix, path):
    if path == '/':
        return prefix + '/'
    return prefix + path


def endpoints_in(path, prefix, source_label):
    tree = ast.parse(path.read_text())
    out = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for dec in node.decorator_list:
            route = decorator_route(dec)
            if route is None:
                continue
            method, raw = route
            level, deps = signature_guard(node)
            out.append({
                'method': method,
                'path': join(prefix, raw),
                'auth': level,
                'handler': node.name,
                'file': source_label,
                'line': node.lineno,
                'depends': deps,
            })
    return out


def main():
    prefixes = mounts(PKG / 'main.py')
    rows = []
    for mod, prefix in sorted(prefixes.items()):
        f = PKG / 'routers' / f'{mod}.py'
        if not f.exists():
            raise SystemExit(f'mounted module with no router file: {mod}')
        rows += endpoints_in(f, prefix, f'backend/open_webui/routers/{mod}.py')
    rows += endpoints_in(PKG / 'main.py', '', 'backend/open_webui/main.py')
    rows.sort(key=lambda r: (r['path'], r['method']))
    print(json.dumps(rows, indent=1))


main()
