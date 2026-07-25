"""Reads Python source with Python's own parser and prints what App Atlas needs.

Python's `ast` module is the only thing that can be trusted to agree with the
interpreter about what a Python file says, so the analyzer shells out to whatever
interpreter the project already uses rather than reimplementing the grammar in
JavaScript. This script is the whole of that conversation: a list of files arrives
as JSON on stdin, a description of them leaves as JSON on stdout.

It reports *what is written*, never what it means. No import is followed, no name is
resolved across files, no path is guessed at — that all happens on the Node side,
where the whole project is in view. Deciding here would mean deciding twice.

Nothing in here may raise. A file that will not parse comes back marked `ok: false`
with its error, because one syntax error in one file must not cost the user their map.
"""

import ast
import builtins
import json
import sys

SCHEMA_VERSION = 1
MAX_TYPE_TEXT = 180
BUILTIN_NAMES = frozenset(dir(builtins))


def unparse(node):
    """Source text for an annotation or default. Long unions get cut, not dropped."""
    if node is None:
        return None
    try:
        text = ast.unparse(node)
    except Exception:
        return None
    text = " ".join(text.split())
    return text if len(text) <= MAX_TYPE_TEXT else text[: MAX_TYPE_TEXT - 1] + "…"


def dotted(node):
    """`a.b.c` for an attribute chain or plain name, else None.

    Route decorators, ORM calls and HTTP clients are all recognised by their dotted
    name, so this is the single most load-bearing helper in the file.
    """
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return ".".join(reversed(parts))
    if isinstance(node, ast.Call):
        # `get_db().query` — the call is not a name, but its callee tells us enough.
        inner = dotted(node.func)
        return inner + "()" if inner else None
    return None


def value_of(node):
    """One argument, tagged with what kind of thing it is.

    A route path and a view function look identical once both are strings, and
    confusing them would invent endpoints. So the tag travels with the value.
    """
    if isinstance(node, ast.Constant):
        if isinstance(node.value, str):
            return {"t": "str", "v": node.value}
        if isinstance(node.value, bool) or node.value is None:
            return {"t": "other"}
        if isinstance(node.value, (int, float)):
            return {"t": "num", "v": str(node.value)}
        return {"t": "other"}
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        items = [value_of(e) for e in node.elts]
        return {"t": "list", "items": items}
    if isinstance(node, ast.JoinedStr):
        # An f-string: the literal parts are still the useful half of a URL.
        literal = "".join(p.value for p in node.values if isinstance(p, ast.Constant) and isinstance(p.value, str))
        return {"t": "str", "v": literal, "partial": True} if literal else {"t": "other"}
    name = dotted(node)
    if name:
        return {"t": "name", "v": name}
    return {"t": "other"}


def call_info(node):
    """The callee and arguments of a call, in the shape the Node side reads."""
    return {
        "callee": dotted(node.func) or "",
        "args": [value_of(a) for a in node.args],
        "kwargs": {kw.arg: value_of(kw.value) for kw in node.keywords if kw.arg},
        "line": getattr(node, "lineno", 0),
    }


def decorator_info(node):
    """A decorator, whether or not it was called: `@app.get('/x')` and `@task` both."""
    if isinstance(node, ast.Call):
        info = call_info(node)
    else:
        info = {"callee": dotted(node) or "", "args": [], "kwargs": {}, "line": getattr(node, "lineno", 0)}
    info["text"] = unparse(node) or info["callee"]
    return info


def names_used(node):
    """Every identifier mentioned inside, for the Node side to resolve into edges.

    Attribute chains contribute their root *and* their full dotted form, because
    `models.User` and `User` are both names a reader would recognise.

    Builtins and anything with a call in the middle of it (`session.query()().all`)
    are dropped: neither can ever name something declared in the project, so keeping
    them would only make the payload bigger.
    """
    found = set()
    for child in ast.walk(node):
        if isinstance(child, ast.Name):
            found.add(child.id)
        elif isinstance(child, ast.Attribute):
            whole = dotted(child)
            if whole:
                found.add(whole)
    return sorted(n for n in found if "(" not in n and n.split(".")[0] not in BUILTIN_NAMES)


def span(node):
    """First line to last, decorators included — what a reader would call the body."""
    start = getattr(node, "lineno", 1)
    for dec in getattr(node, "decorator_list", []):
        start = min(start, getattr(dec, "lineno", start))
    return start, getattr(node, "end_lineno", None) or start


def params_of(node):
    """Parameters with their annotations and defaults. `self` is never information.

    The default matters as much as the annotation here: FastAPI spells an injected
    dependency `user=Depends(get_current_user)`, which is a default value and not a
    type at all. Dropping it would lose every auth check in a FastAPI app.
    """
    args = node.args
    positional = list(args.posonlyargs) + list(args.args)
    defaults = list(args.defaults)
    first_default = len(positional) - len(defaults)
    out = []

    for index, arg in enumerate(positional):
        if index == 0 and arg.arg in ("self", "cls"):
            continue
        default = defaults[index - first_default] if index >= first_default else None
        out.append(
            {
                "name": arg.arg,
                "type": unparse(arg.annotation) or "",
                "default": unparse(default) or "",
                "optional": index >= first_default,
                "rest": False,
            }
        )
    if args.vararg:
        out.append({"name": args.vararg.arg, "type": unparse(args.vararg.annotation) or "", "default": "", "optional": True, "rest": True})
    for index, arg in enumerate(args.kwonlyargs):
        default = args.kw_defaults[index]
        out.append(
            {
                "name": arg.arg,
                "type": unparse(arg.annotation) or "",
                "default": unparse(default) or "",
                "optional": default is not None,
                "rest": False,
            }
        )
    if args.kwarg:
        out.append({"name": args.kwarg.arg, "type": unparse(args.kwarg.annotation) or "", "default": "", "optional": True, "rest": True})
    return out


def function_def(node, owner=None):
    start, end = span(node)
    return {
        "kind": "function",
        "name": node.name,
        "owner": owner,
        "line": start,
        "endLine": end,
        "doc": ast.get_docstring(node),
        "isAsync": isinstance(node, ast.AsyncFunctionDef),
        "params": params_of(node),
        "returns": unparse(node.returns) or "",
        "decorators": [decorator_info(d) for d in node.decorator_list],
        "uses": names_used(node),
    }


def class_fields(node):
    """Annotated class attributes — how a dataclass, a Pydantic model or a Django
    model declares its shape. An assignment with no annotation still counts, because
    `name = models.CharField(...)` is exactly how Django spells a column."""
    fields = []
    for stmt in node.body:
        if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
            fields.append(
                {
                    "name": stmt.target.id,
                    "type": unparse(stmt.annotation) or "",
                    "optional": stmt.value is not None,
                }
            )
        elif isinstance(stmt, ast.Assign):
            for target in stmt.targets:
                if isinstance(target, ast.Name) and not target.id.startswith("__"):
                    fields.append(
                        {
                            "name": target.id,
                            "type": unparse(stmt.value) or "",
                            "optional": False,
                        }
                    )
    return fields


def class_def(node):
    start, end = span(node)
    methods = [function_def(m, owner=node.name) for m in node.body if isinstance(m, (ast.FunctionDef, ast.AsyncFunctionDef))]
    return {
        "kind": "class",
        "name": node.name,
        "line": start,
        "endLine": end,
        "doc": ast.get_docstring(node),
        "bases": [unparse(b) or "" for b in node.bases],
        "fields": class_fields(node),
        "decorators": [decorator_info(d) for d in node.decorator_list],
        "methods": methods,
        "uses": names_used(node),
    }


def imports_of(tree):
    out = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                out.append({"module": alias.name, "level": 0, "names": [], "alias": alias.asname, "line": node.lineno})
        elif isinstance(node, ast.ImportFrom):
            out.append(
                {
                    "module": node.module or "",
                    "level": node.level or 0,
                    "names": [[a.name, a.asname or a.name] for a in node.names],
                    "alias": None,
                    "line": node.lineno,
                }
            )
    return out


def scope_index(tree):
    """Line number → the top-level definition that owns it.

    The Node side attributes every call to the function it sits in, and a line number
    is the only thing both sides can agree on without shipping the syntax tree.
    """
    spans = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            start, end = span(node)
            spans.append((start, end, node.name))
        elif isinstance(node, ast.ClassDef):
            for member in node.body:
                if isinstance(member, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    start, end = span(member)
                    spans.append((start, end, node.name + "." + member.name))
    return spans


def scope_at(spans, line):
    for start, end, name in spans:
        if start <= line <= end:
            return name
    return None


def analyze_source(text):
    tree = ast.parse(text)
    spans = scope_index(tree)

    calls = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            info = call_info(node)
            if not info["callee"]:
                continue
            info["scope"] = scope_at(spans, info["line"])
            calls.append(info)

    # `os.environ["KEY"]` is a subscript, not a call, and it is the most common way an
    # environment variable is read. Missing it would leave holes in the secrets list.
    subscripts = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Subscript):
            base = dotted(node.value)
            key = value_of(node.slice)
            if base and key.get("t") == "str":
                subscripts.append({"base": base, "key": key["v"], "line": node.lineno, "scope": scope_at(spans, node.lineno)})

    defs = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            defs.append(function_def(node))
        elif isinstance(node, ast.ClassDef):
            defs.append(class_def(node))

    # What names are used outside any definition, so module-level code still shows up.
    module_uses = set()
    for node in tree.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            module_uses.update(names_used(node))

    return {
        "doc": ast.get_docstring(tree),
        "imports": imports_of(tree),
        "defs": defs,
        "calls": calls,
        "subscripts": subscripts,
        "uses": sorted(module_uses),
        "loc": text.count("\n") + (0 if text.endswith("\n") or not text else 1),
    }


def main():
    try:
        request = json.loads(sys.stdin.read() or "{}")
    except Exception as err:  # a malformed request is our bug, but say so plainly
        sys.stdout.write(json.dumps({"version": SCHEMA_VERSION, "error": str(err), "files": []}))
        return

    files = []
    for entry in request.get("files", []):
        rel = entry.get("rel") or ""
        record = {"path": rel, "ok": False, "error": None}
        try:
            with open(entry.get("abs") or "", "r", encoding="utf-8", errors="replace") as handle:
                text = handle.read()
            record.update(analyze_source(text))
            record["ok"] = True
        except SyntaxError as err:
            record["error"] = "line %s: %s" % (err.lineno, err.msg)
        except Exception as err:
            record["error"] = str(err)
        files.append(record)

    payload = {"version": SCHEMA_VERSION, "python": "%d.%d" % sys.version_info[:2], "files": files}
    sys.stdout.buffer.write(json.dumps(payload).encode("utf-8"))


if __name__ == "__main__":
    main()
