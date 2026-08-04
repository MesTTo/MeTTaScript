<!--
SPDX-FileCopyrightText: 2026 MesTTo
SPDX-License-Identifier: MIT
-->

# The space, as a collection

`db.space` is the program's atoms read as an ordinary TypeScript collection. It has `size`, `add`, `delete`, `deleteAll`, `has`, `clear`, iteration, and the array methods over plain TypeScript functions.

```ts twoslash
import { mettaDB, names } from "@mettascript/edsl";

const db = mettaDB();
const { Likes } = names("Likes");
db.add([Likes, "Ada", "Coffee"], [Likes, "Bob", "Tea"]);

db.space.size; // 2
[...db.space].map(String); // ['(Likes "Ada" "Coffee")', '(Likes "Bob" "Tea")']
db.space.filter((a) => String(a).includes("Ada")).length; // 1
```

`of(Likes)` gives one relation's facts as tuples typed from the schema, ready to go straight back in with `db.add([Likes, ...row])`. `byHead()` groups them into a `Map`, and `toJS()` gives nested arrays.

It reads atoms **as stored**, where `(get-atoms sp)` reduces them on the way out. That difference matters more often than it sounds: a stored `(fact 5)` stays `(fact 5)` here and becomes `120` there.

`deleteAll(atoms)` is not a loop over `delete`. Removing an atom from `&self` rebuilds the interpreter's derived rule and type indexes, so removing them one at a time pays that rebuild per atom: 50 removals from a 10k space take 358 ms one by one and 7 ms together.

## Writes that happen together

A space is mutable and a batch of writes is not atomic on its own: build half a graph, hit a bad row, and the half is already stored.

```ts twoslash
import { mettaDB, names } from "@mettascript/edsl";
const db = mettaDB();
const { Likes } = names("Likes");
db.add([Likes, "Ada", "Coffee"], [Likes, "Bob", "Tea"]);
const somethingWrong = false;
// ---cut---
db.transaction((tx) => {
  tx.add([Likes, "Ada", "Coffee"]);
  tx.add([Likes, "Bob", "Tea"]);
  if (somethingWrong) throw new Error("no"); // neither atom survives
});
```

The body gets the same runner, so everything you already write against `db` works inside one. A throw restores the space and rethrows; a return answers a report with what was held `before`, what is held `after`, and the `changes` between, which is [DataScript](https://github.com/tonsky/datascript)'s `:tx-data` over atoms rather than datoms.

`db.dryRun(body)` is DataScript's `with`: the same work, reported, then put back either way. It is how you ask what a batch _would_ do, including whether it would fail, since a throw there is reported as `committed: false` rather than raised.

`db.undo(report)` puts the space back the way the report found it. That is a return to a point in time rather than a selective replay, and deliberately so: replaying the changes backwards would re-add a removed atom at the _end_ of the space, and the order atoms are stored in is the order a match answers in.

Rollback works by snapshotting rather than by replaying, for that reason and one more: a body can perform an `(add-atom ...)` _during_ an evaluation, which is an interpreter effect and not a call on the space object at all.

What comes back is the **space**. A file a grounded function wrote, a `bind!` token, a registered operation: none of those are atoms, and none of them are restored.

## The change log

The `changes` in a report are recorded as they happen, not worked out by comparing the space before and after. Comparing is linear in what is _stored_ while the answer is the size of what _changed_, and finding a single insertion among 100k atoms took 34.5 ms, more than the transaction itself.

The same record is available with no transaction in sight:

```ts twoslash
import { mettaDB, names } from "@mettascript/edsl";
const db = mettaDB();
const { Likes } = names("Likes");
db.add([Likes, "Ada", "Coffee"], [Likes, "Bob", "Tea"]);
// ---cut---
const stop = db.onChange((c) => console.log(c.op, c.space, String(c.atom)));
```

Each change is `{ op, space, atom }`: which space, added or removed, and the atom. It covers writes MeTTa itself made while evaluating, not only calls on the space object, and `formatChanges` renders a list the way a debugger shows one. Nothing is installed until something asks, so a program that never listens pays nothing.

Recording also reaches a store that could never be compared. A remote atomspace has no _before_ to hold on to, so a diff cannot see it at all, while a log only needs the write.

## Serving a space from your own backend

A named space can be stored somewhere other than the interpreter's own store. `Space` is four methods, add, remove, query and atoms, and anything implementing it can back one.

```ts twoslash
import { mettaDB, PersistentSpace } from "@mettascript/edsl";

const shelf = new PersistentSpace();
const db = mettaDB().useSpace("&shelf", shelf);
db.run("!(add-atom &shelf (Likes Ada Coffee))");

const v = shelf.snapshot(); // a value, unaffected by anything after it
db.run("!(add-atom &shelf (Likes Bob Tea))");
shelf.restore(v); // and going back is a pointer move, not a rebuild
```

The name is the one a program writes. A bare symbol resolves to itself, so `&shelf` reaches the backend directly, and `(bind! &alias &shelf)` reaches it through the token. Pass `undefined` to unregister.

`PersistentSpace` keeps every version, so `snapshot`, `restore` and `fork` are constant time and a version stays valid however the space changes afterwards. That split is DataScript's again: a mutable handle over an immutable value. It is built on a CHAMP trie, so two versions of a large space share everything they have in common, and `ptDiff` says what changed between them by skipping subtrees that are the same object, in 0.10 ms where an array diff over 100k atoms took 31 ms.

It is a trade, not a free win. Against the interpreter's own store it measures about 13% slower on a write-heavy program, all of it in the write path, because persistence buys versioning with several trie writes per atom. Reads go the other way, since the head index is memoised per version and a version never changes. Reach for it where you want history or branching; the default store is the right choice otherwise.

`&self` cannot be served this way. It is the knowledge base and the evaluator's World read as one, and neither is a `Space`.

## Live queries

```ts twoslash
import { mettaDB, names } from "@mettascript/edsl";
const db = mettaDB();
const { Likes } = names("Likes");
db.add([Likes, "Ada", "Coffee"], [Likes, "Bob", "Tea"]);
const pattern = [Likes, "Ada", "Coffee"] as const;
const render = (rows: unknown[]): void => void rows;
// ---cut---
const stop = db.watch(pattern, (rows) => render(rows));
```

Runs immediately, then again whenever those rows change, including after an `(add-atom ...)` performed during an evaluation. Rows are compared rather than a dirty flag being set, so an unrelated write does not wake a watcher, and nothing costs anything while nobody is watching.
