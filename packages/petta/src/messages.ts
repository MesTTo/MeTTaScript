// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: the text of an uncaught error as PeTTa reports it: main.pl's prolog:error_message//1 phrasings for
// type and determinism errors (test.sh greps fail_* output for them) and SWI-Prolog's default messages.
// am[implements a-pe-loader-cli]

import { Struct, deref, listToArray, type Term } from "./terms";
import { writeTerm } from "./writer";

const p = (t: Term): string => writeTerm(t, { quoted: true, numbervars: true });
const w = (t: Term): string => writeTerm(t, { numbervars: true });

/** Message text for error(Formal, Context), without the "ERROR: " prefix. */
export function errorMessage(ball: Term, file: string): string {
  const b = deref(ball);
  if (!(b instanceof Struct) || b.name !== "error" || b.args.length !== 2) return "Unknown message: " + p(b);
  const formal = deref(b.args[0]!);
  const ctx = deref(b.args[1]!);
  const where = ctx instanceof Struct && ctx.name === "context" && deref(ctx.args[1]!) === "while loading MeTTa file" ? ` (while loading MeTTa file ${file})` : "";
  return formalText(formal) + where;
}

function formalText(f: Term): string {
  if (typeof f === "string") {
    switch (f) {
      case "instantiation_error":
        return "Arguments are not sufficiently instantiated";
      case "car_atom_empty":
        return "car-atom expects a non-empty expression";
    }
    return "Unknown error term: " + p(f);
  }
  if (!(f instanceof Struct)) return "Unknown error term: " + p(f);
  const a = f.args.map(deref);
  switch (f.name + "/" + a.length) {
    case "literal_type_mismatch/2":
      return `Type mismatch: got ${p(a[0]!)} but expected ${p(a[1]!)}`;
    case "type_conflict/2": {
      const ex = deref(a[0]!) as Struct;
      const rq = deref(a[1]!) as Struct;
      return `Type conflict: value is constrained as ${p(ex.args[0]!)} but also required as ${p(rq.args[0]!)}`;
    }
    case "determinism_conflict/2":
      return `Determinism check failed for ${p(a[0]!)}: ${p(a[1]!)}`;
    case "no_matching_overload/1":
      return `No matching typed overload for ${p(a[0]!)}`;
    case "non_parametric_output/1":
      return `Declared output type variable of ${p(a[0]!)} requires a parametric (bottom) implementation`;
    case "non_parametric_param/2":
      return `Declared parametric parameter of ${p(a[0]!)} is used as ${p(a[1]!)} by its implementation; declare the concrete type instead`;
    case "infix_arrow_syntax/2":
      return `Arrows are prefix - write (-[det]-> A B), not (A -[det]-> B) - in the declaration of ${p(a[0]!)}: ${p(a[1]!)}`;
    case "strict_runtime_typecheck/2":
      return `Strict mode rejected residual runtime type goal in ${p(a[0]!)}: ${p(a[1]!)}`;
    case "space_schema_row_mismatch/3":
      return `SpaceOf declaration for ${p(a[0]!)} rejects existing row ${p(a[1]!)}: it definitely contradicts schema ${p(a[2]!)}`;
    case "unbound_det_argument/2":
      return `Argument of ${p(a[0]!)} is unbound: a -[${w(a[1]!)}]-> function requires bound arguments`;
    case "det_argument_not_proper_list/2":
      return `Argument of ${p(a[0]!)} is not a proper list: its -[${w(a[1]!)}]-> proof requires a bound proper list`;
    case "strict_missing_function_type/2":
      return `Strict mode requires a declared or inferable type for ${p(a[0]!)}/${p(a[1]!)}`;
    case "type_error/2":
      return `Type error: \`${w(a[0]!)}' expected, found \`${p(a[1]!)}'`;
    case "domain_error/2":
      return `Domain error: \`${w(a[0]!)}' expected, found \`${p(a[1]!)}'`;
    case "existence_error/2": {
      const kind = deref(a[0]!);
      if (kind === "procedure") return `Unknown procedure: ${p(a[1]!)}`;
      if (kind === "source_sink") return `source_sink \`${w(a[1]!)}' does not exist`;
      return `${w(kind)} \`${w(a[1]!)}' does not exist`;
    }
    case "evaluation_error/1":
      return `Arithmetic: evaluation error: ${p(a[0]!)}`;
    case "syntax_error/1":
      return `Syntax error: ${w(a[0]!)}`;
    case "permission_error/3":
      return `No permission to ${w(a[0]!)} ${w(a[1]!)} \`${p(a[2]!)}'`;
    case "representation_error/1":
      return `Cannot represent due to \`${w(a[0]!)}'`;
  }
  const items = listToArray(f);
  return "Unknown error term: " + p(items === null ? f : f);
}
