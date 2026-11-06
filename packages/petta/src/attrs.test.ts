// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: the object machine's attributed variables against SWI-Prolog's answers (attr-fixture.ts): each program's
// answers from its clauses' first tries and again once rep has had them compiled, and a fact tried past the cell
// engine's inline-head threshold.
// am[verifies a-petta-cell-store.runtime.attrs.obj-age] am[verifies a-petta-cell-store.runtime.attrs.obj-copy]

import { describe, expect, it } from "vitest";
import { ATTR_PROGRAMS, ATTR_SWI } from "./attr-fixture";
import { installBuiltins } from "./builtins";
import { installClpfd } from "./clpfd";
import { installConsult } from "./consult";
import { installLibrary } from "./library";
import { Machine } from "./machine";
import { readClauses } from "./prolog-reader";
import type { Struct } from "./terms";

/** Whether goal text `goal` succeeds on a fresh object machine holding the attribute programs. */
function holds(goal: string): boolean {
  const m = new Machine();
  installBuiltins(m);
  installLibrary(m);
  installConsult(m);
  installClpfd(m);
  for (const c of readClauses(ATTR_PROGRAMS)) m.addClause(c, true);
  const q = (readClauses(`q :- ${goal}.`)[0] as Struct).args[1]!;
  let ok = false;
  m.solveAll(q, () => {
    ok = true;
    return false;
  });
  return ok;
}

describe("the object machine's attributed variables", () => {
  // am[verifies i-obj-head-wake-1106]
  it("give SWI-Prolog's answers, from interpreted and compiled clauses alike", () => {
    for (const [name, text] of Object.entries(ATTR_SWI)) {
      expect(holds(`findall(X, ${name}(X), L), L =@= ${text}`), name).toBe(true);
      expect(holds(`rep(${name}, L), findall(X, (between(1, 40, _), mem(X, ${text})), W), L =@= W`), `${name} compiled`).toBe(true);
    }
    expect(holds("hot(2200)")).toBe(true);
  });
});
