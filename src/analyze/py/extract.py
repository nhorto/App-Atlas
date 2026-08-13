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
import re
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
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Mod):
        # `URL % account_id` — printf formatting, still the oldest way to build a URL in
        # Python. The left operand carries the address; the right carries the part that
        # varies, which was never going to be readable anyway.
        left = value_of(node.left)
        if left.get("t") == "str":
            return {"t": "str", "v": left["v"], "partial": True}
        return left
    if isinstance(node, ast.Call):
        text = call_text(node)
        return {"t": "name", "v": text} if text else {"t": "other"}
    name = dotted(node)
    if name:
        return {"t": "name", "v": name}
    return {"t": "other"}


def call_text(node):
    """A call written as an argument, with the names it was handed.

    `dotted` reduces one to `Depends()`, which is the right answer for a *callee* —
    `get_db().query` is a query however the handle was made — and the wrong one for an
    argument. `dependencies=[Depends(get_current_user)]` says nothing at all without the
    name in the parentheses, and on a large service that one line is where every route's
    auth is written down."""
    callee = dotted(node.func)
    if not callee:
        return None
    given = [dotted(arg) for arg in node.args]
    return "%s(%s)" % (callee, ", ".join(name for name in given if name))


def call_info(node):
    """The callee and arguments of a call, in the shape the Node side reads.

    `method` is the last segment on its own, because `dotted` cannot always reach it.
    `Path(out).write_text(text)` has a call in the middle of the chain, so its dotted
    form is `Path()` and the part that says what happened to the file is gone.
    """
    func = node.func
    method = None
    if isinstance(func, ast.Attribute):
        method = func.attr
    elif isinstance(func, ast.Name):
        method = func.id
    return {
        "callee": dotted(func) or "",
        "method": method,
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


# The two HTTP statuses that mean "I do not accept who you are". Every framework
# spells the rejection differently, but all of them end up naming one of these.
REJECT_STATUS = re.compile(r"\b(401|403|HTTP_401\w*|HTTP_403\w*|UNAUTHORIZED|FORBIDDEN)\b")


def rejection_line(node):
    """The line where this function turns an unauthenticated caller away, if it does.

    This is what makes a dependency a *check* rather than a fetch, and it is a fact
    about the code instead of a fact about the name — so a project whose guard is
    called `verify_api_key` or `tenant_from_header` is read as correctly as one that
    calls it `get_current_user`. Names are a weak second signal, applied elsewhere;
    this is the strong one."""
    for child in ast.walk(node):
        if isinstance(child, ast.Raise) and child.exc is not None:
            if REJECT_STATUS.search(unparse(child.exc) or ""):
                return child.lineno
        # Flask's `abort(401)` and Starlette's `return Response(status_code=403)`
        # reject without raising anything the AST calls an exception.
        elif isinstance(child, ast.Call):
            if _rejecting_call(child):
                return child.lineno
    return None


# Responses that are a refusal by their own name, whatever arguments they carry.
REJECT_CALLS = ("HttpResponseForbidden", "PermissionDenied", "NotAuthenticated", "AuthenticationFailed")

# Ways to build a response that *may* be a refusal, decided by the status in it.
RESPONSE_CALLS = ("abort", "Response", "JSONResponse", "JsonResponse", "HttpResponse", "HTTPException")


def _rejecting_call(node):
    """Whether this call turns an unauthenticated caller away.

    Two readings, because a refusal is written two ways. A framework's own refusal is
    known by name. Everything else is known by the *status*, and only when it was passed
    as a number rather than mentioned in a sentence: healthchecks rejects with
    `error("missing api key", 401)` through a helper it wrote itself, which no list of
    framework names will ever contain, while `log("got a 401 back")` is a sentence about
    a refusal and not one."""
    callee = dotted(node.func) or ""
    last = callee.split(".")[-1]
    if last in REJECT_CALLS:
        return True
    if last in RESPONSE_CALLS and REJECT_STATUS.search(unparse(node) or ""):
        return True
    for arg in list(node.args) + [kw.value for kw in node.keywords]:
        # `401` as an argument is a status code; "401" inside a message is not.
        if isinstance(arg, ast.Constant) and arg.value in (401, 403) and isinstance(arg.value, int):
            return True
        # `status.HTTP_403_FORBIDDEN` — a name whose whole content is the status.
        if isinstance(arg, (ast.Attribute, ast.Name)) and REJECT_STATUS.search(unparse(arg) or ""):
            return True
    return False


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
        "rejects": rejection_line(node),
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


def declared_table_name(node):
    """The table an ORM model maps to, when the class says so outright.

    `__tablename__ = "users"` is how SQLAlchemy spells it, and the same attribute is
    read by several other declarative ORMs, so this is a fact about the class rather
    than a guess about a framework. Only a plain string literal counts: a name built
    at run time out of a variable is a name we do not know.

    `class_fields` skips dunder attributes, and rightly — `__tablename__` is not a
    column. It is the join between the model class and the table the queries name.
    """
    for stmt in node.body:
        if not isinstance(stmt, ast.Assign):
            continue
        for target in stmt.targets:
            if isinstance(target, ast.Name) and target.id == "__tablename__":
                if isinstance(stmt.value, ast.Constant) and isinstance(stmt.value.value, str):
                    return stmt.value.value
    return None


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
        "depends": class_dependencies(node),
        "fields": class_fields(node),
        "tableName": declared_table_name(node),
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


def depends_targets(node):
    """Every name handed to a `Depends(...)` anywhere inside this piece of syntax."""
    out = []
    for child in ast.walk(node):
        if not isinstance(child, ast.Call):
            continue
        if (dotted(child.func) or "").split(".")[-1] != "Depends":
            continue
        for arg in child.args:
            name = dotted(arg)
            if name:
                out.append(name)
    return out


def class_dependencies(node):
    """What a class body hands to `Depends(...)`, in its own right.

    The class-based-view idiom puts a route's auth on the *class*:
    `class BaseUserController: user: PrivateUser = Depends(get_current_user)`, and every
    controller that inherits from it three levels down declares routes that mention no
    caller at all. Read together with `bases`, this is the only record that they are
    guarded — mealie writes a hundred and thirty of its routes this way.

    Only the class's own body counts. What its parents contribute is a fact about them,
    joined where the whole project is in view."""
    out = []
    for stmt in node.body:
        if isinstance(stmt, (ast.Assign, ast.AnnAssign)) and stmt.value is not None:
            out.extend(depends_targets(stmt.value))
        # `class UserAPIRouter(APIRouter)` bakes its dependency into the constructor.
        elif isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)) and stmt.name == "__init__":
            out.extend(depends_targets(stmt))
    return out


def dependency_aliases(tree):
    """Module-level `CurrentUser = Annotated[User, Depends(get_current_user)]`.

    FastAPI's own project template writes every route's auth this way, and a handler
    whose signature reads `current_user: CurrentUser` contains no visible check at
    all. The alias *is* the check. Without reading it, twenty-one guarded routes are
    reported as twenty-one open ones — which is not an imprecise answer, it is the
    opposite of the true one."""
    out = []
    for stmt in tree.body:
        if not isinstance(stmt, (ast.Assign, ast.AnnAssign)):
            continue
        targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
        if len(targets) != 1 or not isinstance(targets[0], ast.Name) or stmt.value is None:
            continue

        depends = depends_targets(stmt.value)
        if depends:
            out.append({"name": targets[0].id, "depends": depends, "line": stmt.lineno})
    return out


def call_bindings(tree):
    """Every `name = some_call(...)`, including `with some_call(...) as name`.

    What a name was built from is the difference between a database read and a
    coincidence. `conn.execute(sql)` is a query when `conn = pymysql.connect(...)`;
    `os.environ.get("DB_HOST")` is the same shape and touches no database at all.
    Guessing from the method name alone gave one repo a MySQL box whose evidence was a
    list of environment lines — the right conclusion citing the wrong code, which a
    reader checks once and then stops trusting.

    Nested scopes count: connections are opened inside the function that uses them far
    more often than at module level."""
    out = []

    def take(target, value):
        if not isinstance(target, ast.Name) or not isinstance(value, ast.Call):
            return
        callee = dotted(value.func)
        if not callee:
            return
        # The first literal string, which for a connection is either the database file
        # or the URL that names the engine.
        arg = None
        for node in list(value.args) + [kw.value for kw in value.keywords]:
            found = value_of(node)
            if found.get("t") == "str" and not found.get("partial"):
                arg = found["v"]
                break
        out.append({"name": target.id, "callee": callee, "arg": arg, "line": getattr(value, "lineno", 0)})

    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            take(node.targets[0], node.value)
        elif isinstance(node, ast.AnnAssign):
            take(node.target, node.value)
        elif isinstance(node, (ast.With, ast.AsyncWith)):
            for item in node.items:
                take(item.optional_vars, item.context_expr)
    return out


# The calls that make something routes can be hung off. Apps are here as well as
# routers because an app is what a router is finally mounted *on*, and Starlette's
# `app.mount("/api/v1", app=api)` is how a whole FastAPI app becomes a prefix.
ROUTER_CALLS = {"FastAPI", "Flask", "Starlette", "Quart", "Sanic", "Blueprint"}


def is_router_call(callee):
    last = callee.split(".")[-1]
    return last.endswith("Router") or last in ROUTER_CALLS


def router_variables(tree):
    """Module-level `locked = LockedRouter(prefix="/admin")`.

    Which router a route hangs off decides whether that router's dependencies apply to
    it. Two routers in one file is normal — one locked, one deliberately open — so
    knowing only the file would turn a correct claim about four routes into a false one
    about two of them.

    The `prefix` is the other half of the route's real address. `@router.get("/{id}")`
    on this router answers at `/admin/{id}`, and the decorator alone never says so."""
    out = []
    for stmt in tree.body:
        if not isinstance(stmt, ast.Assign) or len(stmt.targets) != 1:
            continue
        target = stmt.targets[0]
        if not isinstance(target, ast.Name) or not isinstance(stmt.value, ast.Call):
            continue
        callee = dotted(stmt.value.func) or ""
        if not is_router_call(callee):
            continue
        router = {"var": target.id, "callee": callee, "line": stmt.lineno}
        router.update(prefix_of(stmt.value.keywords))
        out.append(router)
    return out


def prefix_of(keywords):
    """The `prefix=` of a router call, split by whether we can read it.

    A literal is the address. A name — `prefix=settings.API_V1_STR` — is a promise that
    there *is* an address we have not read yet, and that is worth keeping: a route shown
    at `/items/{id}` when it answers at `/api/v1/items/{id}` is a wrong address given
    confidently, which costs the reader more than an honest gap."""
    for kw in keywords:
        # Flask spells it `url_prefix`; the meaning is identical.
        if kw.arg not in ("prefix", "url_prefix"):
            continue
        value = value_of(kw.value)
        if value.get("t") == "str" and not value.get("partial"):
            return {"hasPrefix": True, "prefix": value["v"], "prefixName": None}
        # There is a prefix; we just cannot read it here. `prefixName` is the one lead
        # worth following — a name might be declared somewhere we *can* read.
        return {
            "hasPrefix": True,
            "prefix": None,
            "prefixName": value["v"] if value.get("t") == "name" else None,
        }
    return {"hasPrefix": False, "prefix": None, "prefixName": None}


# An f-string that got as far as a whole hostname before its first placeholder.
# `f"https://api.telegram.org/bot{token}/sendMessage"` leaves
# `https://api.telegram.org/bot/sendMessage`, whose host is exactly right; a
# `f"https://{host}/x"` leaves `https:///x` and is refused by the same pattern.
WHOLE_HOST = re.compile(r"^https?://[^/\s{}:]+\.[^/\s{}:]+", re.I)


def path_constants(tree, spans=None):
    """Assignments of a string naming a path or a whole address.

    `API_V1_STR: str = "/api/v1"` on a settings class is how the most-used FastAPI
    template in existence writes its API prefix, and nothing else in the repo spells the
    address out. `STATUS_FEED = "https://…"` at the top of a module is the same habit
    pointed outwards, and a `requests.get(STATUS_FEED)` further down is an outside
    service the map used to miss entirely (#89).

    Nothing else is collected. A name that was never an address is noise, and noise here
    turns into a collision that makes a real prefix unreadable — which is also why the
    two kinds stay distinguishable by their own text, and why each consumer filters for
    the one it wants rather than trusting the list to hold only its own kind.

    URLs are also collected *inside* functions, carrying the scope they were written in.
    A route prefix is never local — it is module or class configuration — but an address
    very often is: healthchecks reaches Opsgenie, Pushbullet and ntfy through a plain
    `url = "https://…"` on the line above the request. The scope is what keeps two
    functions that both spell it `url` from lending each other their addresses."""
    out = []

    def take(stmt, scope=None, urls_only=False):
        targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
        if len(targets) != 1 or not isinstance(targets[0], ast.Name) or stmt.value is None:
            return
        value = value_of(stmt.value)
        # `url = self.URL % settings.TWILIO_ACCOUNT` — a local name standing in for an
        # address declared a few lines up. Recorded as the link it is, for the Node side
        # to follow once; the alternative is a whole constant-folding pass for a shape
        # that only ever needs one hop.
        if urls_only and value.get("t") == "name":
            out.append({"name": targets[0].id, "value": "", "alias": value["v"], "line": stmt.lineno, "scope": scope})
            return
        if value.get("t") != "str":
            return
        text = value["v"]
        is_url = text[:8].lower().startswith(("http://", "https://"))
        if value.get("partial") and not (is_url and WHOLE_HOST.match(text)):
            return
        if urls_only and not is_url:
            return
        if text.startswith("/") or is_url:
            out.append({"name": targets[0].id, "value": text, "line": stmt.lineno, "scope": scope})

    for stmt in tree.body:
        if isinstance(stmt, (ast.Assign, ast.AnnAssign)):
            take(stmt)
        elif isinstance(stmt, ast.ClassDef):
            for member in stmt.body:
                if isinstance(member, (ast.Assign, ast.AnnAssign)):
                    # Scoped to the class. Four transports in one module each calling
                    # their address `URL` is ordinary, and a flat namespace would hand
                    # the first one's company to all four — a wrong name on a boundary
                    # card, stated as a fact.
                    take(member, stmt.name)

    if spans is None:
        return out
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Assign, ast.AnnAssign)):
            continue
        scope = scope_at(spans, getattr(node, "lineno", 0))
        if scope is not None:
            take(node, scope, urls_only=True)
    return out


URLCONF_CALLS = ("path", "re_path", "url")


def url_lists(tree):
    """Django's URLconf, as a tree rather than a pile of `path()` calls.

    Django assembles an address out of one segment per nesting level, and the nesting is
    a *list literal*: `urlpatterns` holds `path("api/v1/", include(api_urls))`, and
    `api_urls` holds `path("checks/", views.checks)`. Read flat, the second line says the
    address is `/checks/` — which is not an address this app answers at, and reading it
    out to somebody is worse than saying nothing.

    So the shape is what gets recorded: which list an entry sits in, and for an
    `include()`, which list or module it hands off to. `healthchecks` mounts one
    fifteen-route list three times, under `api/v1/`, `api/v2/` and `api/v3/`; nothing in
    the file holding those routes mentions any of it.

    `urlpatterns += [...]` counts, because Django's own docs use it to bolt debug or
    media routes onto a list already built.
    """
    out = []
    by_var = {}

    def entries_of(elts):
        found = []
        for element in elts:
            if not isinstance(element, ast.Call):
                continue
            if not isinstance(element.func, ast.Name) or element.func.id not in URLCONF_CALLS:
                continue
            if not element.args:
                continue
            route = value_of(element.args[0])
            entry = {
                "line": getattr(element, "lineno", 0),
                "call": element.func.id,
                "route": route["v"] if route.get("t") == "str" else None,
                # `path(prefix, include(...))` — the segment is a name. Worth carrying:
                # the repo may declare it as a path constant somewhere we can read.
                "routeName": route["v"] if route.get("t") == "name" else None,
                # An f-string prefix gave us its literal half and hid the rest. Saying so
                # keeps the gap visible instead of composing a confident wrong address.
                "partial": bool(route.get("partial")),
                "includeList": None,
                "includeModule": None,
                "isInclude": False,
                # `views.checks` — the one lead from a URLconf to the code that answers,
                # and the only way a decorator two files away can ever be read.
                "view": None,
            }
            target = element.args[1] if len(element.args) > 1 else None
            if target is not None and not isinstance(target, ast.Call):
                entry["view"] = dotted(target)
            if isinstance(target, ast.Call) and (dotted(target.func) or "").split(".")[-1] == "include":
                entry["isInclude"] = True
                if target.args:
                    inner = target.args[0]
                    if isinstance(inner, ast.Constant) and isinstance(inner.value, str):
                        entry["includeModule"] = inner.value
                    elif isinstance(inner, ast.Name):
                        entry["includeList"] = inner.id
            found.append(entry)
        return found

    def take(name, line, value):
        if not isinstance(value, (ast.List, ast.Tuple)):
            return
        found = entries_of(value.elts)
        if not found:
            return
        if name in by_var:
            by_var[name]["entries"].extend(found)
            return
        record = {"var": name, "line": line, "entries": found}
        by_var[name] = record
        out.append(record)

    for stmt in tree.body:
        if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
            take(stmt.targets[0].id, stmt.lineno, stmt.value)
        elif isinstance(stmt, ast.AugAssign) and isinstance(stmt.target, ast.Name):
            take(stmt.target.id, stmt.lineno, stmt.value)
    return out


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
        "aliases": dependency_aliases(tree),
        "bindings": call_bindings(tree),
        "routers": router_variables(tree),
        "urlLists": url_lists(tree),
        "constants": path_constants(tree, spans),
        "uses": sorted(module_uses),
        "main": main_guard_line(tree),
        "loc": text.count("\n") + (0 if text.endswith("\n") or not text else 1),
    }


def main_guard_line(tree):
    """The line of a module-level `if __name__ == "__main__":`, or None.

    This is how a Python file says "you run me" — far more common than argparse, and
    the only such declaration in a script that reads its input from prompts. Only the
    module level counts: the same test nested inside a function is not an entry point.
    """
    for node in tree.body:
        if not isinstance(node, ast.If):
            continue
        test = node.test
        if not isinstance(test, ast.Compare) or len(test.ops) != 1:
            continue
        if not isinstance(test.ops[0], ast.Eq):
            continue
        left, right = test.left, test.comparators[0]
        names = {
            n.id for n in (left, right) if isinstance(n, ast.Name)
        }
        strings = {
            n.value for n in (left, right) if isinstance(n, ast.Constant) and isinstance(n.value, str)
        }
        if "__name__" in names and "__main__" in strings:
            return node.lineno
    return None


def notebook_source(raw):
    """A Jupyter notebook, flattened into the Python it actually is.

    Returns (source, cells, doc). `source` is every code cell joined in order, so the
    line numbers in it are line numbers in one consistent space that the whole rest of
    the analyzer can use unchanged. `cells` maps a range of those lines back to the
    cell it came from, which is the only address that means anything in a notebook —
    "line 412" is useless to someone looking at a stack of cells.

    Line magics are blanked on the way through — `%matplotlib inline` and `!pip install`
    are not Python and never were — and blanking rather than deleting keeps every line
    after them exactly where its author left it.

    Nothing here is parsed. A cell that is not Python in some way no prefix gives away
    is dealt with afterwards, by `blank_unparsed_cells`, and only if the whole actually
    fails to parse.
    """
    try:
        nb = json.loads(raw)
    except Exception:
        return "", [], None

    lines = []
    cells = []
    doc = None

    for index, cell in enumerate(nb.get("cells") or []):
        source = cell.get("source")
        if isinstance(source, list):
            source = "".join(source)
        elif not isinstance(source, str):
            continue

        if cell.get("cell_type") == "markdown":
            # The first markdown cell, before any code, is the notebook's title block.
            if doc is None and not any(c["type"] == "code" for c in cells):
                doc = markdown_summary(source)
            continue
        if cell.get("cell_type") != "code":
            continue

        body = [strip_magic(line) for line in source.split("\n")]
        start = len(lines) + 1
        lines.extend(body)
        # One blank line between cells so the last statement of one cell and the first
        # of the next are never read as a continuation of each other.
        lines.append("")
        cells.append({"type": "code", "index": index, "startLine": start, "endLine": len(lines) - 1})

    return "\n".join(lines), cells, doc


def blank_unparsed_cells(source, cells):
    """The cells of a notebook that will not parse, blanked so the rest still can.

    This is the second try, for a notebook that already failed to parse in one piece.
    A cell is the unit the kernel itself compiles, so a cell that Python cannot read is
    a cell the author never ran as Python — a `%%bash` body, a stray SQL query, a
    `pip install` written without its `!`. The test is only ever "would this parse",
    never the name of any particular command, because the next repo's unreadable line
    will be one nobody has thought of.

    Blanked cells keep their exact line count, so every range in `cells` and every line
    number the analyzer goes on to report still points at the code the author wrote.
    Each one is marked `unread` with the reason, so the map can say a cell went dark
    instead of quietly showing a shorter notebook.

    Returns the rebuilt source, unchanged if every cell parsed on its own.
    """
    lines = source.split("\n")

    for cell in cells:
        if cell.get("type") != "code":
            continue
        body = lines[cell["startLine"] - 1 : cell["endLine"]]
        try:
            ast.parse("\n".join(body))
        except SyntaxError as err:
            # Counted from the top of the cell, which is the only address a reader
            # looking at a stack of cells can use.
            cell["unread"] = "line %s of the cell: %s" % (err.lineno, err.msg)
        except ValueError as err:  # a null byte, which ast reports as a ValueError
            cell["unread"] = str(err)
        else:
            continue
        lines[cell["startLine"] - 1 : cell["endLine"]] = [""] * len(body)

    return "\n".join(lines)


def strip_magic(line):
    """IPython's own syntax, blanked so the rest of the cell still parses.

    `%timeit`, `!pip install`, and `??name` are not Python and never were — the kernel
    rewrites them before execution. Blanking rather than deleting keeps every line
    number in the cell exactly where the author left it.
    """
    stripped = line.lstrip()
    if not stripped:
        return line
    if stripped[0] in "!%?":
        return ""
    # `foo?` and `foo??` — IPython's help syntax, legal nowhere else.
    if stripped.endswith("?") and not stripped.endswith("??="):
        return ""
    return line


def markdown_summary(text):
    """The first real sentence of a markdown cell, with its heading marks removed."""
    for line in text.split("\n"):
        clean = line.strip().lstrip("#").strip()
        if clean and not clean.startswith("!["):
            return clean[:300]
    return None


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
            # utf-8-sig, not utf-8: a leading BOM is legal in a Python file and common in
            # anything that has been through a Windows editor, but ast.parse rejects it as
            # an invalid non-printable character. Reading it off is the whole fix.
            with open(entry.get("abs") or "", "r", encoding="utf-8-sig", errors="replace") as handle:
                text = handle.read()
            cells = None
            if rel.endswith(".ipynb"):
                text, cells, doc = notebook_source(text)
            try:
                record.update(analyze_source(text))
            except (SyntaxError, ValueError):
                # The overwhelming majority of notebooks parse the first time and never
                # reach this. Only one that has already failed pays for a second pass.
                if cells is None:
                    raise
                retry = blank_unparsed_cells(text, cells)
                # Every cell parsed alone but the whole did not, so the fault is in how
                # they join rather than in any one of them. There is nothing to blank
                # that would not be a guess, and blanking everything would hand the
                # reader an empty notebook that claims to declare nothing — worse than
                # saying plainly that this file could not be read.
                if retry == text:
                    raise
                text = retry
                # Still broken after the retry: let it raise, and the file is reported
                # unread. That is the honest answer, and it is the one this tool prefers.
                record.update(analyze_source(text))
            if cells is not None:
                record["cells"] = cells
                # The code, not the JSON envelope it arrived in. Everything downstream
                # slices this to hash bodies and show snippets, and a snippet of raw
                # notebook JSON would be worse than no snippet at all.
                record["source"] = text
                # A notebook rarely opens with a docstring, but it very often opens with
                # a markdown title. That is the author describing their own work, which
                # is the top rung of the explanation ladder — not something to generate.
                if not record.get("doc") and doc:
                    record["doc"] = doc
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
