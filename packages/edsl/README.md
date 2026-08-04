# @mettascript/edsl

A typed TypeScript eDSL for [MeTTaScript](https://github.com/MesTTo/MeTTaScript). Mint symbols, functors, and logic variables from proxies, build MeTTa with combinators or a tagged template, and run it on the real interpreter. Any TypeScript value drops in as a grounded atom automatically, and TypeScript functions bridge in both directions.

It is a thin layer over [`@mettascript/hyperon`](https://github.com/MesTTo/MeTTaScript/tree/main/packages/hyperon): every builder produces an ordinary atom that runs on the existing engine, so you get MeTTa's full semantics: rewrite rules, nondeterminism, pattern matching, and types.

## Install

```bash
npm install @mettascript/edsl
```

## Usage

```ts
import { mettaDB, names, vars, If, gt, lt, mul, sub, m } from "@mettascript/edsl";

const db = mettaDB();

// `names()` mints symbols and functors on demand; `vars()` mints logic variables. No name is written
// twice: the JS binding IS the name. A bare name grounds to its symbol; a called name applies it.
const { Likes, fact, Ada, Coffee, Chocolate } = names();
const { thing, x } = vars();

// Facts + a match query. With no explicit vars, the row keys are inferred from the pattern.
db.add(Likes(Ada, Coffee), Likes(Ada, Chocolate));
db.query(Likes(Ada, thing)); // [{ thing: "Coffee" }, { thing: "Chocolate" }]

// Rewrite rules + grounded arithmetic, recursion, nondeterminism.
db.rule(fact(x), If(gt(x, 0), mul(x, fact(sub(x, 1))), 1));
db.evalJs(fact(5)); // [120]

// Grounded functions: a plain typed function, args auto-unwrapped, result auto-grounded.
db.fn("balance-of", (a: { balance: number }) => a.balance);
db.evalJs(m`(balance-of ${{ owner: "Tom", balance: 100 }})`); // [100]

// Call MeTTa functions from TypeScript, quick or typed.
db.call.fact(5); // [120]
const factorial = db.import("fact");
factorial(6); // 720
```

## Arrays are expressions

An array in term position is a MeTTa expression. `[parent, Tom, Bob]` is `(parent Tom Bob)`, nesting costs nothing, and a program becomes ordinary data you can build with the array methods you already use.

```ts
const { parent, grandparent, Tom, Bob, Ann } = names("parent", "grandparent", "Tom", "Bob", "Ann");
const { x, y, z } = vars("x", "y", "z");

db.add([parent, Tom, Bob], [parent, Bob, Ann]);
db.query([parent, Tom, y]); // [{ y: "Bob" }]

// an array of patterns is a conjunction, so this joins on $y
db.query([
  [parent, Tom, y],
  [parent, y, z],
]); // [{ y: "Bob", z: "Ann" }]
```

MeTTa has no array type of its own: `(1 2 3)` is an expression there too. When the array itself is the value you want, `val([1, 2, 3])` grounds it as one. The one shape the array spelling cannot express is an expression whose every element is an expression, since that array reads as a conjunction; write that with `e(...)`, which has no second reading.

Because a program is data, you can build one with `Array.prototype`:

```ts
const goals = [
  [parent, Tom, y],
  [parent, y, z],
];
db.rule(grandparent(x, z), Match(All(...goals), z));
```

Spell your names as literals (`names("parent", "Tom")`) when you want a relation schema to type the result rows. The no-argument `names()` still mints any key you ask for, it simply cannot tell the type system which name you meant.

## The three term surfaces

- **Arrays.** `[parent, Tom, Bob]`, as above. The closest spelling to MeTTa source, and the one that composes with ordinary array code.
- **Builders.** `names()` and `vars()` mint names and variables (`const { parent, x } = ...`), and the capitalized combinators build the special forms: `If`, `Case`, `Switch`, `Let`, `LetStar`, `Chain`, `Match`, `All`, `Superpose`, `Collapse`, `Empty`, `Unify`, `Sealed`, `Quote`. Lowercase builders cover the grounded ops: `add`/`sub`/`mul`/`div`/`mod`, `eq`/`gt`/`lt`/`ge`/`le`, `and`/`or`/`not`, `carAtom`/`cdrAtom`/`consAtom`/`deconsAtom`, `mapAtom`/`filterAtom`/`foldlAtom`, `list`/`nil`/`e`, and the rest of the standard library. Builders compose, so nested patterns and repeated variables are just nested calls.
- **The tagged template.** ``m`...` `` (and `mAll` for several atoms) runs the real parser, so it expresses every MeTTa form, and `${value}` auto-grounds, which is the easiest way to drop a TS object in.

## The fluent chain

MeTTa's list operations have the same shape as `Array.prototype`, so `M(x)` gives them the names you already know. Nothing runs until a terminal.

```ts
M([1, 2, 3, 4])
  .map((x: number) => x * 10)
  .filter((x: number) => x > 15)
  .reduce((a: number, x: number) => a + x, 0)
  .js(db); // [90]
```

There are two flavours, and the difference is where your code runs. `.map`, `.filter`, `.reduce`, and `.forEach` take a plain TypeScript function: it is registered as a grounded operation under a private token, so `x * 10` is JavaScript arithmetic over JavaScript numbers and nothing about it is defined in the space. `.mapAtom`, `.filterAtom`, and `.foldAtom` take a MeTTa template instead, for when the body should be MeTTa: nondeterminism, matching, rules.

Any method name the chain does not define becomes `(name self ...args)`, so an operation you registered yourself is a method with no wiring at all:

```ts
db.fn("double", (n: number) => n * 2);
M(21).double().js(db); // [42]
M(x)["my-op"](1, 2); // (my-op $x 1 2) — brackets for a hyphenated name
```

An async body is awaited through `.jsAsync(db)` / `.runAsync(db)`.

## The space as a collection

`db.space` is the program's space with the interface a collection has in JavaScript: `size`, `add`, `delete`, `has`, `clear`, iteration, and the array methods over plain functions.

```ts
for (const atom of db.space) console.log(String(atom));
db.space.filter((a) => String(a).startsWith("(Likes"));
db.space.byHead(); // Map { "Likes" => [...], "Age" => [...] }
db.space.of(Likes); // [["Ada", "Coffee"]] — typed from the schema, ready to add back
```

It reads atoms as they are stored. MeTTa's own `(get-atoms space)` reduces what it hands back, so a stored rule would come out through its own rewrite rather than as itself.

## Defining a function

Two ways, and both hand back the atom so nothing is spelled twice. `db.define` writes the function in MeTTa; `db.grounded`, below, writes it in TypeScript.

```ts
const fact = db.define<(n: number) => number>("fact", (self, n) =>
  If(gt(n, 0), mul(n, self(sub(n, 1))), 1),
);

db.evalJs(fact(5)); // [120], typed number[]
fact("not a number"); // compile error
```

The body receives the function itself first, so a recursive definition can name itself without the `const` being in its own temporal dead zone. The arity comes from the callback's own parameter list, so it is stated once, where a TypeScript reader already looks.

Several clauses mean nondeterminism, as they do in MeTTa, so a second literal-head rule does not override the first: `db.rule(fact(0), 1)` adds a base case that MeTTa tries _alongside_ the variable-head one. The way to mean "otherwise" is a guard inside the body, which is what the `If` above is.

The symbols MeTTa already names are exported rather than minted: `Self` for `&self`, `True` and `False`, the metatypes, and the type names a declaration uses.

## A TypeScript function as an atom

`db.fn` registers a function by name and hands back nothing, so the MeTTa side has to be spelled a second time. `db.grounded` returns the atom itself, and the function's own signature becomes the contract.

```ts
const double = db.grounded("double", (n: number) => n * 2);

db.evalJs(double(21)); // [42], typed number[] — no schema written anywhere
double("no"); // compile error, from the parameter list
db.add([Uses, double]); // bare, it is its symbol: ordinary data
```

It obeys MeTTa's rule for a grounded operation rather than working around it. Applied and evaluated it runs; quoted it stays `(quote (double 21))`; stored with `add-atom` it keeps the unevaluated `(double 21)`, which a pattern can then match as data. `asyncGrounded` is the awaiting form, and a body that throws arrives as an `(Error ...)` like any other grounded operation. Call one through `db.callAsync.name(...)`, which is `db.call`'s awaiting counterpart: evaluation cannot wait, so plain `call` would hand back the unresolved promise atom.

## Programs you can compose

MeTTa's own module system is file-based: `import!` resolves a path and binds the loaded space to a token. That is right for MeTTa source and the wrong shape for TypeScript, where the unit you want to pass around is a value.

```ts
const arith = mettaModule()
  .grounded("double", (n: number) => n * 2)
  .define("quad", ["Number"], "Number", (self, n) => mul(n, 4));

const data = mettaModule().relation("Likes", ["String", "String"]).atoms([Likes, "Ada", "Coffee"]);

const db = mettaDB().use(arith.use(data));
db.call.quad(3); // [12], number[]
db.query([Likes, "Ada", drink]); // [{ drink: "Coffee" }], { drink: string }[]
```

A module records what to add and carries the _type_ of what it declares, so using one teaches the runner about everything in it. `use` merges — a module can `use` another before any runner exists — and the shape is [tRPC](https://trpc.io)'s router merge, where sub-routers are built independently and the merged type carries every branch. Applying happens once per module per runner, tracked by identity, because a module applied twice would add its rules twice and MeTTa would then answer twice.

A signature is written as a value, `["Number"], "Number"`, rather than as a type argument. That is Zod's and tRPC's move, and here it pays three ways: TypeScript cannot infer one type argument while you supply another, so a type argument would make you spell the name twice; the same list emits `(: quad (-> Number Number))`, which teaches the _engine_ the type as well, something a TypeScript type can never do; and it is the vocabulary `relation` already uses.

`.source(src)` carries raw MeTTa text, which is what a module is in MeTTa. Its `!`-queries run when the module is used, and that is the only route by which `pragma!` or `bind!` can reach one, since neither is an atom to add. Pair it with `.declare(name, args, ret)`, which states a function's type without defining it — `define` would add a second clause, and in MeTTa two clauses means the call answers twice.

`m.declarations()` hands over `(: Name (-> ...))` for everything declared, relations ending in `Type` and functions in their return type. Nothing is emitted until you ask, for the same reason `declareRelations` is opt-in: declaring is safe, enforcing rejects programs that used to run.

## Errors, and catching them

MeTTa reports failure as a value rather than by throwing, so a failed evaluation arrives looking like a successful one. `isErrorAtom`, `errorText` and `errorAtoms` see one; `evalOrThrow`, `evalJsOrThrow` and `evalAsyncOrThrow` raise a `MettaError` carrying the error atoms.

`Try(body, handler)` catches one MeTTa-side, and `Catch(body, fallback)` is the form that only wants a value:

```ts
db.evalJs(Try(risky(x), (err) => Recovered(err)));
db.evalJs(Catch(risky(x), "fallback"));
```

`if-error` alone cannot do this. It takes an `Atom` parameter, so it inspects its argument unevaluated: `(if-error (boom) caught ok)` answers `ok`, because the literal expression `(boom)` is not an error atom and is never run. `Try` chains an `eval` in front. A TypeScript function that throws is already an `(Error ...)` here, so `Try` catches those too, and the round trip closes.

## Decoding results with a validator you already use

Results come from runtime rewriting, so `unknown` is the honest static type. Turning that into a checked one is what the JavaScript validation libraries already do, so `evalAs` takes a [Standard Schema](https://standardschema.dev) rather than a validator of its own.

```ts
import { z } from "zod";
db.evalAs(fetchUser(1), z.object({ name: z.string(), age: z.number() }));
```

That interface was co-authored by the Zod, Valibot and ArkType authors, and Zod, Valibot, ArkType, TypeBox, Yup and Joi all implement it, so one interface supports all of them. The spec's types are vendored rather than depended on, so this package gains no runtime dependency. A failure raises with the validator's own issues; `evalAsyncAs` awaits a schema that validates asynchronously.

## Taking a result apart

Building MeTTa from TypeScript is typed all the way down. Coming back used to mean `atomToJs` and index arithmetic, so this closes the loop:

```ts
matchAtom(atom)
  .with([Likes, P.str("who"), P.str("drink")], ({ who, drink }) => `${who} likes ${drink}`)
  .with([Age, P.str("who"), P.num("years")], ({ who, years }) => `${who} is ${years}`)
  .otherwise(() => "no idea");
```

The handler's argument is typed from the pattern, so `who` and `drink` are `string`, `years` is `number`, and asking for a name the pattern never bound does not compile. `.run()` answers `undefined` instead of taking a fallback.

The vocabulary: `P._` matches anything and binds nothing; `P.any`, `P.str`, `P.num`, `P.bool`, `P.sym`, `P.var` and `P.expr` guard the shape, and bind when given a name; `P.when(pred, name?)` guards with a predicate, for what a shape check cannot say; `P.union([...], name?)` takes any one of several patterns and `P.not(pat, name?)` takes whatever one refuses; `P.rest(name)` takes the remaining arguments. A bare literal compares by the atom it grounds to, and a nested array matches a nested expression. `.withAny([p1, p2], handler)` runs one handler off several whole shapes, and `.returnType<T>()` fixes what every arm must answer.

Sometimes you want the predicate rather than the branch. `isMatching(pattern, atom)` answers a boolean, and `matchBindings(pattern, atom)` answers the bindings or `undefined`:

```ts
results.filter((a) => isMatching([Likes, P._, P._], a));
```

The design is [ts-pattern](https://github.com/gvergnaud/ts-pattern)'s, which solved this for ordinary JavaScript values. The difference is the subject: ts-pattern would work on `atomToJs(atom)`, but unwrapping has already made a symbol and a grounded string both a JavaScript string, and that is the difference behind most MeTTa bugs. Matching the atom keeps it, which is why `P.sym` and `P.str` are separate patterns.

### Handling every head

`db.match(atom)` is the same matcher with one thing added: the runner knows which relation heads the schema declares, so it can insist that every one of them has an arm.

```ts
db.match(atom)
  .with([Likes, P.str("who"), P.str("drink")], ({ who, drink }) => `${who}: ${drink}`)
  .with([Age, P.str("who"), P.num("years")], ({ who, years }) => `${who}/${years}`)
  .exhaustive();
```

Delete the `Age` arm and it stops compiling: `.exhaustive` takes the type `NonExhaustive<"Age">`, which has no call signature, so the error names the head you forgot. This is ts-pattern's `.exhaustive()` again, but ts-pattern gets its universe from a discriminated union and MeTTa atoms have none — so the declaration supplies it instead.

It is deliberately conservative. Only a symbol from `names()` in head position counts as covering a head, because a matcher there accepts any head and its type does not say which, and an unsound check is worse than none. The arm that handles whatever is left is `.otherwise()`, which is the clearer spelling anyway. An atom from outside the declaration — from `run`, an `import!`, a decoded payload — still reaches a `NonExhaustiveError` throw, since no static check can rule that out.

## Why a query returned nothing

The commonest failure in a logic language, and a trace cannot answer it: `@mettascript/debug` reports what the evaluator did, which on an empty result is "one reduction, no results". The cause is almost never the evaluator.

```ts
db.explain([Likes, Ada, drink]);
// (Likes Ada $drink) matched nothing: argument 1 differs: you passed Symbol Ada
// and the space holds Grounded "Ada", which never match
//   near: (Likes "Ada" "Coffee")
//         argument 1: wanted Symbol Ada, found Grounded "Ada"
```

`db.why(pattern)` returns the same as data. It compares the pattern against what is stored, ranks the atoms sharing its head and arity, and names the first argument that differs, calling out a metatype difference specifically, since that is the likeliest cause and the one the printed form hides. It also covers a head that appears nowhere, a wrong arity, and an empty space. For the evaluator's side, `db.source()` hands the program to `explainCall` as the text it expects.

The head gets the same treatment, and that case needs no space to diagnose at all. MeTTa matches a functor and fires a rule by _symbol_ head, so a grounded one can never work:

```ts
db.explain(["Likes", "Ada", drink]);
// ("Likes" "Ada" $drink) matched nothing: the head is Grounded "Likes" and the space holds
// Symbol Likes, which never match — spell it sym("Likes") or names("Likes")
```

That is the same rule as everywhere else — a JavaScript string is a grounded string — applied to the one position where it is easy to forget. `sym(name)` is the single-name form of `names()`, and the one to reach for when a head is not a valid identifier: `sym("get-atoms")`, `sym("&limit")`, `sym("+")`.

## Writes that happen together

A space is mutable and a batch of writes is not atomic on its own: build half a graph, hit a bad row, and the half is already stored.

```ts
db.transaction((tx) => {
  tx.add([Likes, "Ada", "Coffee"]);
  tx.add([Likes, "Bob", "Tea"]);
  if (somethingWrong) throw new Error("no"); // neither atom survives
});
```

The body gets the same runner, so everything you already write against `db` works inside one. A throw restores the space and rethrows; a return answers a report — [DataScript](https://github.com/tonsky/datascript)'s, with what was held `before`, what is held `after`, and the `changes` between, which is its `:tx-data` over atoms rather than datoms.

`db.dryRun(body)` is DataScript's `with`: the same work, reported, and then put back either way. It is how you ask what a batch _would_ do, including whether it would fail — a throw there is reported as `committed: false` rather than raised, since that is the answer you asked for.

`db.undo(report)` puts the space back the way the report found it. That is a return to a point in time rather than a selective replay, and it is deliberate: replaying the changes backwards would re-add a removed atom at the _end_ of the space, and the order atoms are stored in is the order a match answers in.

Rollback snapshots the space rather than replaying the log, for the same two reasons: order is preserved, and a body can perform an `(add-atom ...)` _during_ an evaluation, which is an interpreter effect and not a call on the space object at all.

## Serving a space from a backend

A named space can be stored somewhere other than the interpreter's own store. `Space` is four methods — add, remove, query, atoms — and anything implementing it can back one.

```ts
const shelf = new PersistentSpace();
const db = mettaDB().useSpace("&shelf", shelf);
db.run("!(add-atom &shelf (Likes Ada Coffee))");

const v = shelf.snapshot(); // a value, unaffected by anything after it
db.run("!(add-atom &shelf (Likes Bob Tea))");
shelf.restore(v); // and going back is a pointer move, not a rebuild
```

`PersistentSpace` keeps every version, so `snapshot`, `restore` and `fork` are O(1) and a version stays valid however the space changes afterwards. That split is [DataScript](https://github.com/tonsky/datascript)'s: a mutable handle over an immutable value.

It is a trade, not a free win. Against the interpreter's own store it measures about 13% slower on a write-heavy program, all of it in the write path, because persistence buys versioning with several trie writes per atom. Reads are the other way — a query runs faster, since the head index is memoised per version and a version never changes. Use it where you want history or branching; the default store is the right choice otherwise.

`&self` cannot be served this way. It is the knowledge base and the evaluator's World read as one, and neither is a `Space`.

## The change log

The `changes` in a report are **recorded as they happen**, not worked out by comparing the space before and after. Comparing is linear in what is _stored_ while the answer is the size of what _changed_ — finding a single insertion among 100k atoms took 34.5 ms, more than the transaction itself.

The same record is available with no transaction in sight:

```ts
const stop = db.onChange((c) => console.log(c.op, c.space, String(c.atom)));
```

Each change is `{ op, space, atom }`: which space, added or removed, and the atom. It covers writes MeTTa itself made while evaluating, not only calls on the space object, and `formatChanges` renders a list the way a debugger shows one. Nothing is installed until something asks, so a program that never listens pays nothing.

Recording also reaches a store that could never be compared. A remote atomspace has no _before_ to hold on to, so a diff cannot see it at all, while a log can.

What comes back is the **space**. A file a grounded function wrote, a `bind!` token, a registered operation — none of those are atoms, and none of them are restored.

## Live queries

```ts
const stop = db.watch(pattern, (rows) => render(rows));
```

Runs immediately, then again whenever those rows change, including after an `(add-atom ...)` performed during an evaluation. Rows are compared rather than a dirty flag being set, so an unrelated write does not wake a watcher, and nothing costs anything while nobody is watching.

## Telling MeTTa what TypeScript knows

A schema is a TypeScript type and types are erased, so `(get-type Likes)` answers `%Undefined%` and `pragma! type-check auto` has no contract to enforce. Your schema protects the lines the compiler reads; it does nothing for an atom arriving from `run`, from an `import!`ed file, from a runtime `add-atom`, or from a decoded payload.

```ts
db.declareRelations({ Likes: ["String", "String"] }).typeCheck();
// (add-atom &self (Likes "Ada" 42)) -> (Error ... (BadArgType 2 String Number))
```

Two calls rather than one, and opt-in: declaring is safe, while enforcing will reject programs that previously ran. The mapping is also lossy, since unions, optionals, interfaces and generics have no MeTTa equivalent and emit `%Undefined%`, which is permissive rather than wrong.

## The runner and the host bridge

`mettaDB()` keeps MeTTa's two query mechanisms distinct: `query(pattern)` does `match &self` over stored atoms and returns binding rows (keys inferred from the pattern, or typed by an explicit `vars` map); `eval(atom)` (and `evalJs`, `evalAsync`, `evalJsAsync`) rewrites with the `=` rules and returns the nondeterministic results.

The host bridge runs both directions:

- Grounded functions bridge TypeScript into MeTTa. `db.fn("name", fn)` registers a plain typed function with arguments auto-unwrapped to JS and the result auto-grounded; `db.fns({ ... })` registers several at once keyed by name; `db.asyncFn` awaits an async function. The raw `db.op`/`db.asyncOp` stay for full atom control (multiple results, custom matching).
- A backward import bridges MeTTa into TypeScript. `db.call.<name>(...)` builds and evaluates `(<name> ...args)` and returns every result unwrapped to JS; use bracket access for hyphenated names (`db.call["is-even"](4)`). `db.import("name")` returns a callable.

### Typing the host bridge

Pass a schema to `mettaDB` and `call`, `import`, and `fn` become statically typed; with no schema they stay permissive. Both an `interface` and a `type` schema work.

```ts
interface Api {
  fact: (n: number) => number;
  isEven: (n: number) => boolean;
}
const db = mettaDB<Api>();
db.call.fact(5); // number[]
const factorial = db.import("fact"); // (n: number) => number | undefined
db.fn("fact", (n: number) => n + 1); // checked against the schema
// db.fn("fact", (s: string) => s)  // compile error: wrong signature
```

`ground(x)` is the primitive behind auto-grounding, and `patternVars(atom)` returns the free variables of a pattern (what `query` uses to infer row keys).

## Typed source queries

`db.q("...")` runs `match &self` from a plain MeTTa source string and types the result rows by the pattern's `$`-variables, extracted at compile time. The keys are known and autocompleted, and a key that is not a variable in the source is a compile error.

```ts
const rows = db.q("(Likes Ada $thing)"); // Array<{ thing: unknown }>
rows[0]!.thing; // ok, autocompleted
// rows[0]!.other  // compile error: not a variable in the source
```

It works on a plain string, not the ``m`...` `` tag: TypeScript widens a tagged template's text to `string`, which discards the literal the type-level parser needs. For a builder-form query with the same auto-inferred keys, use `db.query(pattern)`.

Declare relations and the _values_ are typed too, not only the keys. The source is parsed recursively at the type level, so a nested variable takes its type from whatever declares that position, a quoted string keeps its spaces, and an argument count that disagrees with the relation is a compile error rather than a row that could never match.

```ts
const db = mettaDB<{ relations: { Likes: [string, string]; Hot: [string] } }>();
db.q('(Likes "Ada" $drink)'); // Array<{ drink: string }>
db.q("(Likes $who (Hot $drink))"); // Array<{ who: string; drink: string }>
// db.q('(Likes "Ada")')            // compile error: QueryArityError<"Likes", 1, 2>
```

The same checks apply to an array pattern, `db.query([Likes, "Ada", drink])`, and to a fact you store with `db.add`. Only a head nothing declares gives `unknown` values, and even then the keys are exact.

Typed relations put the column types in one place instead of at every call site:

```ts
const Likes = rel<[person: string, drink: string]>("Likes");
const { drink } = vars("drink");
db.add(Likes("Ada", "Coffee")); // Likes("Ada", 42) is a compile error
db.query(Likes("Ada", drink)); // Array<{ drink: string }>, no second argument
```

A column that is itself a tuple declares a nested expression one level down, exactly as the relation's own column list does at the top, so a nested shape needs no name of its own. A variable standing in two columns whose types disagree can never bind, and that is a compile error as well.

## Errors are values

MeTTa reports failure as a value rather than by throwing. `(* "no" 2)` reduces to `(Error (* "no" 2) (BadArgType 1 Number String))`, and that atom arrives in the ordinary results next to anything that did work, so code that checks how many results came back is told a failed program succeeded.

That is MeTTa's semantics and `db.eval` keeps it. What is added is the ability to see it:

```ts
const [r] = db.eval(mul("not-a-number", 2));
isErrorAtom(r); // true
errorText(r); // "(BadArgType 1 Number String) in (* \"not-a-number\" 2)"

db.evalJsOrThrow(mul("not-a-number", 2)); // throws MettaError
db.evalJsOrThrow(mul(6, 7)); // [42], unchanged
```

`evalOrThrow`, `evalJsOrThrow`, and `evalAsyncOrThrow` raise a `MettaError` when any result is an error, and the chain has `runOrThrow(db)` and `jsOrThrow(db)`. The thrown error carries `.errors`, the error atoms themselves, so a caller that wants MeTTa's own `if-error` handling still has them.

An expression that did not reduce is not an error. An unknown head is ordinary data in MeTTa, so the raising forms leave it alone.

## JSON and dict-spaces

`db.useJson()` enables the JSON module, then the `jsonEncode`/`jsonDecode`/`dictSpace`/`getKeys`/`getValue` builders bridge JSON and MeTTa spaces. `json-decode` turns a JSON object into a dict-space of `(key value)` pairs, so a fetched payload becomes a queryable space.

```ts
const db = mettaDB().useJson();
db.evalJs(jsonEncode(42)); // ["42"]
const doc = jsonDecode('{"name": "Ada", "age": 36}'); // a dict-space
db.evalFirst(getValue(doc, "name")); // "Ada"  (JSON keys decode to strings)
```

## Optional host interop builders

The eDSL also has pure builder subpaths for optional host runtimes. They only
construct atoms. You still register the Python or Prolog runtime explicitly
through `@mettascript/py`, `@mettascript/prolog`, the Node CLI flags, or browser host
composition.

```ts
import { ground, vars } from "@mettascript/edsl";
import { pyCall } from "@mettascript/edsl/py";
import { prologCall, importPrologFunction } from "@mettascript/edsl/prolog";

const { x } = vars();

pyCall("math.add", 40, 2); // (py-call (math.add 40 2))
prologCall(["edge", "alice", x]); // (prolog-call (edge alice $x))
importPrologFunction("edge"); // (import_prolog_function edge)
```

Strings in `pyCall` arguments stay normal eDSL strings, which Python receives as
Python strings. Strings in Prolog goal arrays are Prolog atoms, so
`["edge", "alice", x]` builds `(edge alice $x)`. Use `ground("text")` inside a
Prolog goal when you need a Prolog string.

## For language models

[`LLMS.md`](./LLMS.md) is a one-page, high-density reference for this package: API surface, working
examples, and the mistakes that produce wrong code. The repository root carries an
[`llms.txt`](../../llms.txt) index of all of them.

## License

[MIT](https://github.com/MesTTo/MeTTaScript/blob/main/LICENSE).
