; What to pull out of a Go file.
;
; The capture names here are the contract every language in this tier has to meet — see
; `extract.ts`. Nothing in this file is about Go's *libraries*; it is entirely about Go's
; grammar. Which packages mean a route, a guard or a database is decided in
; `go/boundaries.ts`, against what `go.mod` actually declares, and none of it is here.

; --- functions and methods -------------------------------------------------
(function_declaration
  name: (identifier) @def.func.name
  result: (_)? @def.func.returns) @def.func

; A method's receiver is the type it hangs off. `*Server` and `Server` are the same
; owner as far as a reader is concerned, so both spellings capture the bare name.
(method_declaration
  receiver: (parameter_list
    (parameter_declaration
      type: [(pointer_type (type_identifier) @def.func.owner)
             (type_identifier) @def.func.owner]))
  name: (field_identifier) @def.func.name
  result: (_)? @def.func.returns) @def.func

; Scoped to the `parameters:` field on purpose: a receiver is spelled exactly like a
; parameter, and listing `(s *Server)` as an argument of every method is a lie the
; signature line would then repeat on screen.
(function_declaration
  parameters: (parameter_list
    (parameter_declaration
      name: (identifier) @def.param.name
      type: (_) @def.param.type) @def.param))

(method_declaration
  parameters: (parameter_list
    (parameter_declaration
      name: (identifier) @def.param.name
      type: (_) @def.param.type) @def.param))

; --- types -----------------------------------------------------------------
(type_declaration
  (type_spec name: (type_identifier) @def.type.name)) @def.type

; Struct members and the methods an interface requires. Both are the shape of the type,
; and both are attached to whichever type declaration contains them.
(field_declaration
  name: (field_identifier) @def.field.name
  type: (_) @def.field.type) @def.field

(method_elem
  name: (field_identifier) @def.field.name
  parameters: (parameter_list) @def.field.type) @def.field

; --- imports ---------------------------------------------------------------
(import_spec
  name: (package_identifier)? @import.alias
  path: (_) @import.path) @import

; --- calls -----------------------------------------------------------------
(call_expression
  function: (_) @call.fn
  arguments: (argument_list) @call.args) @call

; --- names bound to values -------------------------------------------------
; `r := chi.NewRouter()` is the only record that `r` is a router, and every route
; registered on it afterwards says only `r`.
(short_var_declaration
  left: (expression_list) @bind.name
  right: (expression_list) @bind.value) @bind

(var_spec
  name: (identifier) @bind.name
  value: (expression_list) @bind.value) @bind

(const_spec
  name: (identifier) @bind.name
  value: (expression_list) @bind.value) @bind

; --- string constants ------------------------------------------------------
; Only so that a route prefix written as a name can be turned back into the address it
; stands for.
(const_spec
  name: (identifier) @const.name
  value: (expression_list [(interpreted_string_literal) (raw_string_literal)] @const.value))

(var_spec
  name: (identifier) @const.name
  value: (expression_list [(interpreted_string_literal) (raw_string_literal)] @const.value))

; --- the package this file belongs to --------------------------------------
(package_clause (package_identifier) @namespace)
