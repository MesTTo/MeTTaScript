// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Writes that happen together, or not at all — and a record of what happened.
//
// A space is mutable and a batch of writes is not atomic: build half a graph, hit a bad row, and the
// half is already stored.
//
//     db.transaction((tx) => {
//       tx.add([Likes, "Ada", "Coffee"]);
//       if (bad) throw new Error("no");   // nothing above survives
//     });
//
//     const report = db.dryRun((tx) => tx.add(...many));   // what WOULD this do?
//     report.changes;                                      // and the space is untouched
//
// The report is DataScript's: `before`, `after`, and the changes between them, which is its `:tx-data`
// over atoms rather than datoms. `dryRun` is its `with` — the same work against a value that is thrown
// away, so a caller can look before committing.
//
// The changes are RECORDED as they happen rather than computed by comparing the space before and after.
// Comparing cost 34.5ms to discover a single insertion in a space of 100k, because it is linear in what
// is stored while the answer is the size of what changed; the runner reports each write as it occurs, so
// the same list costs what it contains. The shape follows the MeTTa debugger protocol's
// `SpaceChangedEvent`: which space, added or removed, and the atom.
//
// Recording it also covers a store that can never be compared — a remote atomspace has no before to hold
// on to — which a diff cannot reach at all.
//
// What rolls back is the SPACE. A grounded function that wrote a file, a `bind!` token, a registered
// operation: none of those are atoms, so none of them come back. Say so plainly rather than implying a
// transaction is more than it is.
import { type Atom } from "@mettascript/hyperon";

/** One change to a space, in the order it happened. */
export interface Change {
  readonly op: "add" | "remove";
  /** Which space, so a transaction that touches more than `&self` still reads unambiguously. */
  readonly space: string;
  readonly atom: Atom;
}

/** What a transaction did: DataScript's transaction report, over atoms. */
export interface TxReport<T> {
  /** Whatever the body returned. */
  readonly value: T;
  /** Every write the body made, in order, across every space it touched. */
  readonly changes: readonly Change[];
  /** The atoms `&self` held before the body ran. Restoring this is what a rollback does, and what
   *  {@link MettaDB.undo} replays. */
  readonly before: readonly Atom[];
  /** The atoms `&self` holds now. Computed on demand, since a report is usually read for its changes and
   *  materialising a large space costs more than the transaction did. */
  readonly after: readonly Atom[];
  /** False when the body threw. {@link MettaDB.transaction} rethrows, so a report you receive from it is
   *  always `true`; {@link MettaDB.dryRun} reports either way, since rolling back is the point there. */
  readonly committed: boolean;
}

/** Renders a change list the way the MeTTa debugger shows one, for a log line or a test. */
export function formatChanges(changes: readonly Change[]): string {
  return changes.map((c) => `${c.op} ${c.space} ${String(c.atom)}`).join("\n");
}
