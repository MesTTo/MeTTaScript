// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// The symbols MeTTa already has names for.
//
// These are ordinary atoms with fixed spellings, so minting them through `names()` every time is
// ceremony that says nothing: `names("&self")["&self"]` appeared five times in this package's own tests
// before they were exported, which is the clearest possible argument for exporting them.
//
// Grouped rather than dumped: spaces, the booleans, the metatypes `get-metatype` answers with, and the
// type names a declaration uses.
import { S, type SymbolAtom } from "@mettascript/hyperon";

/** The program's own space, as `add-atom`, `match` and friends expect it. */
export const Self: SymbolAtom = S("&self");

/** MeTTa's booleans. `True`/`False` are symbols, not JavaScript booleans: a JS `true` grounds to a
 *  grounded boolean, which is a different atom and does not match these. */
export const True: SymbolAtom = S("True");
export const False: SymbolAtom = S("False");

/** The metatypes `(get-metatype x)` answers with, and which a parameter declared with one enforces. */
export const SymbolType: SymbolAtom = S("Symbol");
export const ExpressionType: SymbolAtom = S("Expression");
export const VariableType: SymbolAtom = S("Variable");
export const GroundedType: SymbolAtom = S("Grounded");

/** The type names a declaration uses. `Undefined` is `%Undefined%`, which admits anything. */
export const AtomType: SymbolAtom = S("Atom");
export const TypeType: SymbolAtom = S("Type");
export const NumberType: SymbolAtom = S("Number");
export const StringType: SymbolAtom = S("String");
export const BoolType: SymbolAtom = S("Bool");
export const Undefined: SymbolAtom = S("%Undefined%");

/** The error type and its two reserved descriptions. */
export const ErrorType: SymbolAtom = S("ErrorType");
export const BadType: SymbolAtom = S("BadType");
export const IncorrectNumberOfArguments: SymbolAtom = S("IncorrectNumberOfArguments");
