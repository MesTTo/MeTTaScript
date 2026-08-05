// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// The differential comparator for the compliance bar: two result sets agree when their canonicalized
// forms agree as sorted multisets — same atoms up to alpha-renaming, same multiplicity, order free
// (MOPS carries the workspace as a multiset). Shared by the conjunction, chain, and variable-head
// differentials; test-only, tree-shaken out of the published package.
import { type Atom } from "./atom";
import { canonicalize } from "./alpha";
import { format } from "./parser";

export function canonicalMultiset(atoms: readonly Atom[]): string[] {
  return atoms.map((a) => format(canonicalize(a, new Map()))).sort();
}
