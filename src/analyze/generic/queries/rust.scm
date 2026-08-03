; What to pull out of a Rust file.
;
; The capture names here are the contract every language in this tier has to meet — see
; `extract.ts`. Nothing in this file is about Rust's *libraries*; it is entirely about
; Rust's grammar. Which attributes mean a door and which calls mean a database is decided
; in `rust/boundaries.ts`, against what Cargo.toml actually declares.
;
; Two things Rust says are deliberately not asked for here, because the flat capture
; vocabulary cannot express them and `finish` in `rust/dialect.ts` reads them off the
; tree instead: `use` declarations (a recursive tree of groups, globs and aliases, not a
; path and an alias) and `mod foo;` (an import whose target is spelled by the module
; system rather than written down).

; --- functions and methods -------------------------------------------------
; Free functions: at the top of the file, and inside an inline `mod` one level down —
; which is where every `#[cfg(test)] mod tests` keeps its tests. Written per container
; rather than as a bare `(function_item)` so that a method never matches twice.
(source_file
  (function_item
    name: (identifier) @def.func.name
    return_type: (_)? @def.func.returns) @def.func)

(mod_item
  body: (declaration_list
    (function_item
      name: (identifier) @def.func.name
      return_type: (_)? @def.func.returns) @def.func))

; A method hangs off the type its `impl` block names — `impl EstimateRow { fn total() }`
; — and in a trait impl the `type:` field is still the type, not the trait.
(impl_item
  type: [(type_identifier) @def.func.owner
         (generic_type type: (type_identifier) @def.func.owner)
         (scoped_type_identifier name: (type_identifier) @def.func.owner)]
  body: (declaration_list
    (function_item
      name: (identifier) @def.func.name
      return_type: (_)? @def.func.returns) @def.func))

; A trait's default methods belong to the trait.
(trait_item
  name: (type_identifier) @def.func.owner
  body: (declaration_list
    (function_item
      name: (identifier) @def.func.name
      return_type: (_)? @def.func.returns) @def.func))

; --- parameters ------------------------------------------------------------
; Simple named parameters only. `&self` is a self_parameter and a receiver, not an
; argument, and a destructuring pattern has no one name to show.
(parameter
  pattern: (identifier) @def.param.name
  type: (_) @def.param.type) @def.param

; --- types -----------------------------------------------------------------
(struct_item name: (type_identifier) @def.type.name) @def.type
(enum_item name: (type_identifier) @def.type.name) @def.type
(trait_item name: (type_identifier) @def.type.name) @def.type
(union_item name: (type_identifier) @def.type.name) @def.type
(type_item name: (type_identifier) @def.type.name) @def.type

; Struct members. A variant's own `{ fields }` attach to the enum the same way.
(field_declaration
  name: (field_identifier) @def.field.name
  type: (_) @def.field.type) @def.field

; An enum's variants are its shape, the way an interface's methods are Go's.
(enum_variant name: (identifier) @def.field.name) @def.field

; The methods a trait requires — a signature with no body.
(function_signature_item
  name: (identifier) @def.field.name
  parameters: (parameters) @def.field.type) @def.field

; --- calls -----------------------------------------------------------------
(call_expression
  function: (_) @call.fn
  arguments: (arguments) @call.args) @call

; A macro invocation, read as the call it is spelled like: `sqlx::query!("…")` and
; `env!("KEY")` carry their evidence in the token tree exactly where arguments would be.
(macro_invocation
  macro: (_) @call.fn
  (token_tree) @call.args) @call

; --- names bound to values -------------------------------------------------
; `let pool = MySqlPool::connect(url)` is the only record that `pool` is a database.
(let_declaration
  pattern: (identifier) @bind.name
  value: (_) @bind.value) @bind

; --- string constants ------------------------------------------------------
; Only so that a route prefix written as a name can be turned back into the address it
; stands for.
(const_item
  name: (identifier) @const.name
  value: (string_literal) @const.value)

(static_item
  name: (identifier) @const.name
  value: (string_literal) @const.value)
