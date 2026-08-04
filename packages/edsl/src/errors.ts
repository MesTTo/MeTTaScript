// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// MeTTa reports failure as a VALUE. `(* "no" 2)` does not throw, it reduces to
// `(Error (* "no" 2) (BadArgType 1 Number String))`, and that atom arrives in the ordinary results
// alongside anything that did work. Reading the result length or mapping it to JS therefore says a
// program succeeded when it failed:
//
//     db.evalJs(mul("not-a-number", 2));
//     // [["Error", ["*","not-a-number",2], ["BadArgType",1,"Number","String"]]]   length 1, looks fine
//
// That is MeTTa's semantics and it is not changed here: an error is a value, errors compose, and
// `if-error` can branch on one. What is added is the ability to SEE it — a predicate, a reader for the
// message, and evaluating forms that raise instead of handing back a disguised failure.
import { ExpressionAtom, SymbolAtom, type Atom } from "@mettascript/hyperon";

/** Whether an atom is an `(Error <subject> <description>)`. */
export function isErrorAtom(atom: Atom): boolean {
  if (!(atom instanceof ExpressionAtom)) return false;
  const head = atom.children()[0];
  return head instanceof SymbolAtom && head.name() === "Error";
}

/** Just the error atoms among some results. Empty when nothing failed. */
export function errorAtoms(results: readonly Atom[]): Atom[] {
  return results.filter(isErrorAtom);
}

/** The subject and description of an error atom, as MeTTa source, or `undefined` for a non-error.
 *  The subject is the expression that failed; the description is why. */
export function errorParts(atom: Atom): { subject: string; description: string } | undefined {
  if (!isErrorAtom(atom)) return undefined;
  const [, subject, description] = (atom as ExpressionAtom).children();
  return {
    subject: subject === undefined ? "" : String(subject),
    description: description === undefined ? "" : String(description),
  };
}

/** A one-line reading of an error atom, or `undefined` for a non-error. */
export function errorText(atom: Atom): string | undefined {
  const parts = errorParts(atom);
  return parts === undefined ? undefined : `${parts.description} in ${parts.subject}`;
}

/** Thrown by the `*OrThrow` forms. Carries the error atoms themselves, so a caller that wants to
 *  inspect or re-raise them in MeTTa still can. */
export class MettaError extends Error {
  constructor(readonly errors: readonly Atom[]) {
    const lines = errors.map((a) => errorText(a) ?? String(a));
    super(
      lines.length === 1
        ? `MeTTa evaluation failed: ${lines[0]}`
        : `MeTTa evaluation failed with ${lines.length} errors:\n  ${lines.join("\n  ")}`,
    );
    this.name = "MettaError";
  }
}

/** Hand back the results, unless any of them is an error. */
export function raiseErrors(results: readonly Atom[]): Atom[] {
  const errors = errorAtoms(results);
  if (errors.length > 0) throw new MettaError(errors);
  return [...results];
}
