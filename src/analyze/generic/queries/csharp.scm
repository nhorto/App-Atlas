; What to pull out of a C# file.
;
; The capture names here are the contract every language in this tier has to meet — see
; `extract.ts`. Nothing in this file is about .NET's *libraries*; it is entirely about
; C#'s grammar. Which attributes mean a route, a guard or a database is decided in
; `csharp/boundaries.ts`, against what the project file actually references.
;
; One thing here is not like Go. C# says most of what a reader needs in *attributes* —
; `[HttpGet("{id}")]`, `[Authorize]`, `[Route("api/v1/orders")]` — and an attribute is
; spelled exactly like a call: a name, and an argument list that is usually one string.
; So attributes are captured as calls. They land in `file.calls` with the enclosing
; method or class as their scope, which is precisely what a detector needs, and the whole
; shared machinery for calls works on them without knowing they are not calls.

; --- methods ---------------------------------------------------------------
; C# has no free-standing methods: every one lives in a type, and the type is the owner
; a reader thinks in. Written out per container rather than as a bare
; `(method_declaration)` so that no method matches twice — a duplicate here would be
; counted twice in every total on the screen.
(class_declaration
  name: (identifier) @def.func.owner
  body: (declaration_list
    (method_declaration
      returns: (_)? @def.func.returns
      name: (identifier) @def.func.name) @def.func))

(class_declaration
  name: (identifier) @def.func.owner
  body: (declaration_list
    (constructor_declaration
      name: (identifier) @def.func.name) @def.func))

(interface_declaration
  name: (identifier) @def.func.owner
  body: (declaration_list
    (method_declaration
      returns: (_)? @def.func.returns
      name: (identifier) @def.func.name) @def.func))

(record_declaration
  name: (identifier) @def.func.owner
  body: (declaration_list
    (method_declaration
      returns: (_)? @def.func.returns
      name: (identifier) @def.func.name) @def.func))

(struct_declaration
  name: (identifier) @def.func.owner
  body: (declaration_list
    (method_declaration
      returns: (_)? @def.func.returns
      name: (identifier) @def.func.name) @def.func))

; A local function, and the top-level statements a `Program.cs` is now written as. Both
; are real code somebody reads, and neither has an owner.
(local_function_statement
  name: (identifier) @def.func.name) @def.func

; --- types -----------------------------------------------------------------
(class_declaration name: (identifier) @def.type.name) @def.type
(interface_declaration name: (identifier) @def.type.name) @def.type
(record_declaration name: (identifier) @def.type.name) @def.type
(struct_declaration name: (identifier) @def.type.name) @def.type
(enum_declaration name: (identifier) @def.type.name) @def.type

; --- parameters ------------------------------------------------------------
; Scoped to the `parameters:` field of things that take parameters, on purpose. A
; positional record spells its *shape* in a parameter list — `record OrderRequest(string
; Sku, int Quantity)` — and a bare `(parameter)` pattern lists those as arguments of the
; type as well as fields of it, so the same two names arrive twice wearing different hats.
(method_declaration
  parameters: (parameter_list
    (parameter
      type: (_) @def.param.type
      name: (identifier) @def.param.name) @def.param))

(constructor_declaration
  parameters: (parameter_list
    (parameter
      type: (_) @def.param.type
      name: (identifier) @def.param.name) @def.param))

(local_function_statement
  parameters: (parameter_list
    (parameter
      type: (_) @def.param.type
      name: (identifier) @def.param.name) @def.param))

; --- fields and properties -------------------------------------------------
; Properties matter more than fields in C# and far more than they do in Go: a record's
; shape, a DTO's shape, and every `DbSet<Order> Orders { get; set; }` on a DbContext are
; all properties.
(property_declaration
  type: (_) @def.field.type
  name: (identifier) @def.field.name) @def.field

(field_declaration
  (variable_declaration
    type: (_) @def.field.type
    (variable_declarator name: (identifier) @def.field.name))) @def.field

; A positional record — `record OrderRequest(string Sku, int Quantity)` — declares its
; shape in its parameter list, and that shape is the whole of what the type is.
(record_declaration
  (parameter_list
    (parameter
      type: (_) @def.field.type
      name: (identifier) @def.field.name) @def.field))

; --- usings ----------------------------------------------------------------
; The aliased form binds the name to the `name:` field and leaves the namespace as an
; ordinary child, so the two spellings need separate patterns or an alias is read as
; the namespace it stands for.
(using_directive
  name: (identifier) @import.alias
  [(qualified_name) (identifier)] @import.path) @import

(using_directive
  !name
  [(qualified_name) (identifier)] @import.path) @import

; --- calls -----------------------------------------------------------------
(invocation_expression
  function: (_) @call.fn
  arguments: (argument_list) @call.args) @call

; An attribute, read as the call it is spelled like. See the note at the top.
(attribute
  name: (_) @call.fn
  (attribute_argument_list)? @call.args) @call

; A constructor is a call whose callee is the type: `new PeriodicTimer(…)` is where a
; worker declares its interval, and `new Uri("https://…")` is where a typed client
; declares its base address. Without this pattern neither exists to any detector.
(object_creation_expression
  type: (_) @call.fn
  arguments: (argument_list) @call.args) @call

; --- names bound to values -------------------------------------------------
; `var app = builder.Build();` is the only record that `app` is a web application, and
; every route mapped on it afterwards says only `app`.
(variable_declarator
  name: (identifier) @bind.name
  (_) @bind.value) @bind

; An assignment is a binding too, and in .NET it is where the SQL lives: raw ADO.NET
; writes `cmd.CommandText = "SELECT … FROM punches"` and then calls `ExecuteReaderAsync()`
; with no arguments at all. Read only as a declaration, the query is invisible and the
; most common data access in .NET after EF goes unreported.
(assignment_expression
  left: (_) @bind.name
  right: (_) @bind.value) @bind

; --- string constants ------------------------------------------------------
; Only so that a route prefix written as a name can be turned back into the address it
; stands for.
(variable_declarator
  name: (identifier) @const.name
  (string_literal) @const.value)

; --- the namespace this file belongs to ------------------------------------
(namespace_declaration name: (_) @namespace)
(file_scoped_namespace_declaration name: (_) @namespace)
