// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Telling MeTTa what TypeScript already knows.
//
// A schema passed to `mettaDB<S>()` is a TypeScript type, and TypeScript types are erased: nothing about
// it ever reaches the engine. So `(get-type Likes)` answers `%Undefined%` even though you wrote the
// columns down, and `(pragma! type-check auto)` has no contract to enforce.
//
// That matters for everything TypeScript cannot see. Your schema protects `db.add([Likes, "Ada", 42])`
// because the compiler reads that line. It does nothing for an atom arriving from `db.run("...")`, an
// `import!`ed `.metta` file, a runtime `add-atom`, a `json-decode`d payload, or a query against a remote
// space. All of that is runtime data. Emitting the declarations extends the identical check to it:
//
//     (: Likes (-> String String Type))
//     !(add-atom &self (Likes "Ada" 42))   ->  (Error (Likes "Ada" 42) (BadArgType 2 String Number))
//     !(add-atom &self (Likes "Ada"))      ->  (Error (Likes "Ada") IncorrectNumberOfArguments)
//
// Both verified on this engine, with `type-check auto` on.
//
// It is OPT-IN, for two honest reasons. Declaring changes runtime behaviour: with checking enabled the
// engine will reject programs that previously ran. And the mapping is LOSSY — TypeScript has unions,
// optionals, interfaces and generics that MeTTa has no equivalent for, and those emit `%Undefined%`,
// which is permissive rather than wrong but is weaker than the TypeScript side. Turning on enforcement
// stays a separate, deliberate line: this only declares.
import { E, S, type Atom } from "@mettascript/hyperon";

/** A column's declared TypeScript type, as a runtime witness. A schema is erased, so the caller hands
 *  over the shape at runtime — the same list, spelled once as a value. */
export type TypeName = "String" | "Number" | "Bool" | "Atom" | "%Undefined%" | readonly TypeName[];

/** One relation's columns, as MeTTa type names. */
export type ColumnTypes = readonly TypeName[];

/** The relation declarations to emit, keyed by head symbol:
 *  `{ Likes: ["String", "String"] }` becomes `(: Likes (-> String String Type))`. */
export type Declarations = Readonly<Record<string, ColumnTypes>>;

/** A column type as an atom: a plain name is its symbol, a nested tuple is a nested arrow type ending in
 *  `Type`, matching how a tuple column declares a nested expression everywhere else in this eDSL. */
function columnAtom(t: TypeName): Atom {
  return Array.isArray(t) ? arrowAtom(t) : S(t as string);
}

/** `(-> A B ... Type)`: the constructor type of an expression with those arguments. */
function arrowAtom(cols: ColumnTypes): Atom {
  return E(S("->"), ...cols.map(columnAtom), S("Type"));
}

/** `(: Head (-> Cols... Type))` for one relation. */
export function relationDecl(head: string, cols: ColumnTypes): Atom {
  return E(S(":"), S(head), arrowAtom(cols));
}

/** Every declaration for a set of relations, in declaration order. */
export function relationDecls(decls: Declarations): Atom[] {
  return Object.entries(decls).map(([head, cols]) => relationDecl(head, cols));
}

/** `(: name (-> Args... Ret))` for a function, which is the ordinary arrow type rather than a
 *  constructor's. */
export function functionDecl(name: string, args: ColumnTypes, ret: TypeName): Atom {
  return E(S(":"), S(name), E(S("->"), ...args.map(columnAtom), columnAtom(ret)));
}

/** The MeTTa type name for a JS `typeof` tag, for callers deriving declarations from sample data rather
 *  than writing them out. Anything without an equivalent is `%Undefined%`, which admits everything. */
export function typeNameOf(value: unknown): TypeName {
  if (Array.isArray(value)) return value.map(typeNameOf);
  switch (typeof value) {
    case "string":
      return "String";
    case "number":
      return "Number";
    case "boolean":
      return "Bool";
    default:
      return "%Undefined%";
  }
}

/** The TypeScript type a declared MeTTa column holds.
 *
 *  A module declares its columns by MeTTa type NAME, because that is what has to reach the engine. The
 *  query typing needs the TypeScript type instead, so one declaration serves both: `"String"` is the
 *  name that gets emitted and `string` is the type a variable in that column takes. A name with no
 *  TypeScript equivalent is `unknown`, which is permissive and honest rather than wrong. */
export type TsTypeOf<C, D extends readonly unknown[] = []> = C extends "String"
  ? string
  : C extends "Number"
    ? number
    : C extends "Bool"
      ? boolean
      : C extends readonly unknown[]
        ? // Bounded: a nested shape is a nested expression, and six levels is far past anything a schema
          // spells by hand. Without the bound the checker walks `TypeName`'s own recursion and reports
          // "type instantiation is excessively deep".
          D["length"] extends 6
          ? unknown
          : { [I in keyof C]: TsTypeOf<C[I], [...D, unknown]> }
        : unknown;

/** One relation's columns, as TypeScript types. */
export type TsColumnsOf<C extends readonly unknown[]> = { [I in keyof C]: TsTypeOf<C[I]> };
