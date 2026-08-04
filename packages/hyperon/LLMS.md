# @mettascript/hyperon
Class API over `@mettascript/core`: build atoms from TS, hold them in spaces, run a stateful MeTTa runner, cross JS↔MeTTa both ways. Modeled on Python `hyperon`; every Python name survives as an alias (`get_name()`≡`name()`, `add_atom()`≡`addAtom()`, `get_children()`≡`children()`). Examples executed by tests.
**Pick** need to *construct atoms* or *cross the JS boundary*→here · raw source text→`core` (exports no constructors) · terser typed layer→`edsl`. `npm i @mettascript/hyperon`
**Atoms** `S("parent")`→symbol `parent` · `V("x")`→variable `$x` · `E(S("parent"),S("tom"),V("c"))`→`(parent tom $c)` · `ValueAtom(42)`→`42` · `ValueAtom("hi")`→grounded string `"hi"` · `G(obj)` wraps any object. Kinds `SymbolAtom` `VariableAtom` `ExpressionAtom` `GroundedAtom`. Every atom: `metatype()` `equals(o)` `toString()` `iterate()` (depth-first) `matchAtom(o)`. Read parts: `SymbolAtom.name()` `ExpressionAtom.children()`. `atomToJs(a)`→JS value (grounded→value, symbol→name, expression→array). `GroundedAtom` payload at `.object().content`.
**Match** `matchAtom`→`BindingsSet`; empty set = no match.
```ts
const set = E(S("point"),V("x"),V("y")).matchAtom(E(S("point"),ValueAtom(1),ValueAtom(2)));
set.frames[0].resolve(V("x"))?.toString();           // "1"
```
`Bindings` frame: `addVarBinding(v,atom)` `resolve(v)` `pairs()` `merge(other)`.
**Spaces**
```ts
const sp = new GroundingSpace();
sp.addAtom(E(S("parent"),S("tom"),S("bob"))); sp.addAtom(E(S("parent"),S("tom"),S("liz")));
sp.subst(E(S("parent"),S("tom"),V("c")), V("c")).map(String);   // ["bob","liz"]
```
Remote/distributed backend → `das-client` (`DasLiveSpace`, async: a query is a network round-trip). `metta.registerSpace("&shelf", backend)` serves a NAMED space from any `Space` (add/remove/query/atoms) — `new PersistentSpace()` gives versions that are values (`snapshot`/`restore` are pointer moves, `fork` shares structure), ~13% slower on writes than the interpreter's own store and faster on reads. `&self` is NOT registrable (it is the KB and the World read as one). `metta.watchSpaceChanges(fn)` reports every `(op, space, atom)`, covering an `add-atom` MeTTa made mid-evaluation as well as a host write; `undefined` stops it. `space().removeAtoms(xs)` removes a batch with ONE env rebuild where `removeAtom` pays one per atom (50 of 10k: 358ms → 7ms); `space().clear()` empties in one pass.
**Runner** state persists across `run`; non-`!` atoms extend the KB, each `!` returns its results. `run` → `Atom[][]`, **one inner array per `!` query**.
```ts
const m = new MeTTa();
m.run("(= (color) red)\n(= (color) green)");
m.run("!(color)")[0].map(String);                    // ["red","green"]
```
`run(prog, fuel?): Atom[][]` · `runAsync(prog, fuel?)` awaits async ops · `evaluateAtom(atom, fuel?): Atom[]` / `evaluateAtomAsync` · `parseAll(prog): Atom[]` / `parseSingle(prog)` · `space(): SpaceRef` · `tokenizer()` · `getAtomTypes(atom)` · `registerOperation(name, fn)` · `registerAsyncOperation(name, fn, effect?)` · `registerToken(regex, constr)`.
**TS→MeTTa** fn takes argument **atoms**, returns result **atoms**; nothing unwrapped for you. Array of several = nondeterministic; `[]` = no result.
```ts
m.registerOperation("double", (args) => [ValueAtom(args[0].object().content * 2)]);
m.run("!(double 21)")[0].map(String);                // ["42"]
```
Prefer `atomToJs(args[0])` over a `GroundedAtom` cast when the argument may not be grounded.
**Traps** *`run` returns `Atom[][]` not `Atom[]`* — `m.run("!(+ 1 2)")[0][0]` is the atom; a missing index yields an array where you expect a value. · *Atoms ≠ JS values* — `toString()`=MeTTa text, `atomToJs`=value. · *`ValueAtom("hi")` ≠ `S("hi")`* — grounded string (prints `"hi"`) vs symbol (prints `hi`); they never match. · *Data is not a function* — `sp.addAtom(E(S("Likes"),S("Ada"),S("Coffee")))` is reachable by `subst`/query, NOT by evaluating `(Likes Ada $x)` (no `=` rule → expression unchanged). · *`[]` is normal* — no match and no rule both give it. · *A registered op must return an array* — a bare atom or `undefined` is a bug; use `[]` for "no result".
**Next** `core` engine · `edsl` typed terser surface · `das-client` remote space · `node` files/CLI · `py`/`prolog` register onto this runner.
