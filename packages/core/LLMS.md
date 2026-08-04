# @mettascript/core
MeTTa (OpenCog Hyperon) interpreter, pure TS. Source text in → result atoms out. No native addons/WASM. Exports **no atom constructors**. All examples below are executed by tests; outputs real.
**Pick** run source→`core` · build atoms, JS↔MeTTa→`hyperon` (`E S V G MeTTa`) · typed JS surface→`edsl` · `.metta` files/CLI/filesystem `import!`→`node` · property tests→`fuzz` · browser→`browser`. `npm i @mettascript/core`
**Model** Two mechanisms; picking wrong = empty results. *Rewrite*: `(= (fact $n) …)` defines fn, evaluating `(fact 5)` rewrites. *Match*: atoms are data, `(match &self (Likes Ada $x) $x)` searches. Stored `(Likes Ada Coffee)` is NOT reachable by evaluating `(Likes Ada $x)` (no `=` rule → expression returned unchanged); use `match`. Results always arrays (evaluation is nondeterministic); `[]` = legitimate "no results", not an error. `!`line = query; every other top-level atom → space. One `QueryResult` per `!`, in order.
**API** `runProgram(src, fuel=100000, imports?: ImportMap, opts?: RunOptions): QueryResult[]` · `QueryResult {query: Atom; results: Atom[]}` · `format(a: Atom): string`
```ts
import { runProgram, format } from "@mettascript/core";
const out = runProgram(`(= (fact $n) (if (> $n 0) (* $n (fact (- $n 1))) 1))\n!(fact 5)`);
out[0].results.map(format);                          // ["120"]
```
`runProgramAllDirectives(…)` same args, non-`!` atoms also returned as empty groups · `runProgramAsync(src, asyncOps?, fuel?, imports?, opts?)` only if you registered an I/O op, else identical · `evalSequential(atoms, fuel?, imports?, opts?)` for parsed/transformed atoms · `parseAll(src, standardTokenizer()) → {atom,bang}[]` (bare `new Tokenizer()` loses number + `True`/`False` literals) · `InMemorySpace`, `PersistentSpace`, `Trail`, `unifyTop`, `matchAtoms`, `alphaEq` for lower-level work. `Space` is add/remove/query/atoms (+optional `clear`), and `opts.spaces` (a `Map<name, Space>`) serves NAMED spaces from your own backend — registered nothing, nothing changes. `PersistentSpace` versions are values: `snapshot`/`restore`/`fork` are pointer moves, built on the CHAMP trie `PMap`/`PTable`. `ptDiff(before, after)` says what changed between two versions by skipping subtrees that are the same object — 0.10ms against 31ms for an array diff over 100k, and flat in the size rather than linear. `opts.onSpaceChange(op, space, atom)` reports each write as it happens.
**RunOptions** `tabling?` memoisation, on · `maxStackDepth?` user-equation call bound, 0=unbounded · `maxSteps?` work budget/query · `experimental?` engine A/B switches — answers don't depend on them, leave alone.
**Atoms are opaque** `format`→MeTTa text · `atomToJs` (from `hyperon`)→JS value. Neither automatic.
**Analysis** `analyzeSource(src, {undefinedSymbols}): Diagnostic[]` + `renderAll(src, file, diags)`→rustc-style frames. Reports exactly 2 codes: `arity-mismatch` (Error, always) · `unknown-symbol` (Warning, opt-in; off by default because an unknown head is legal MeTTa data, not a typo). Does **not** check argument types — `!(foo "x")` vs `(-> Number Bool)` analyses clean, fails at runtime `(Error (foo "x") (BadArgType 1 Number String))`. Static type verdict: evaluate `(check-types <atom>)` → `()` when well typed.
```ts
analyzeSource(`(: foo (-> Number Bool))\n!(foo 1 2)`, { undefinedSymbols: false });
// [{ code: "arity-mismatch", message: "foo expects 1 argument, got 2" }]
```
**Recipes**
```ts
runProgram(`(Likes Ada Coffee) (Likes Ada Chocolate) (Likes Turing Tea)
  !(match &self (Likes Ada $w) $w)`);                // ["Coffee","Chocolate"]   stored data → match
runProgram(`(Likes Ada Coffee) (Likes Ada Chocolate)
  !(collapse (match &self (Likes Ada $w) $w))`);     // ["(Coffee Chocolate)"]   many results → one tuple
runProgram(`(= (colour) red) (= (colour) blue) !(colour)`);   // ["red","blue"]  every definition fires
const lib = parseAll("(= (double $x) (* 2 $x))", standardTokenizer()).filter(t=>!t.bang).map(t=>t.atom);
runProgram(`!(import! &self lib)\n!(double 21)`, 100000, new Map([["lib", lib]]))[1];  // ["42"]
```
**Traps** *Options are the FOURTH arg* — `runProgram(src,fuel,imports,opts)`; passing 3rd silently reads options as an import map: `runProgram(src,100000,new Map(),{tabling:false})` ✓ / `runProgram(src,100000,{tabling:false})` ✗. · *`[]` is an answer* (no match / `case` with no clause / fn undefined at that input) — check `.length`, don't throw. · *`Empty` = no results, not a symbol*: `!(case (A 1) ((B no)))`→`[]`, `!(collapse (case (A 1) ((B no))))`→`["()"]` not `(Empty)`. · *`add-atom` stores literally, `add-reduct` evaluates first*: with `(= (g) 7)`, `(add-atom &s (foo (g)))` then `(match &s (foo (g)) yes)` hits but `(match &s (foo 7) …)`→`[]`; `add-reduct` is the mirror image. · *`Atom` ≠ JS value.* · *Fuel is not a timeout* — `fuel`/`maxSteps` bound inference work, not wall-clock.
**Next** `hyperon` atoms+runner · `edsl` typed JS · `node` files/CLI · `libraries` MeTTa stdlib · `fuzz` property tests.
