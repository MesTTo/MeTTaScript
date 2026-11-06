// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: a call's arguments on the cell engine as swi-index.ts's clause selection reads them (ArgVector): argument
// i's key equal to the key the same object term has, and a compound argument's own arguments, so one selection
// algorithm serves both engines and leaves choicepoints where SWI does (c-cell-select-shared-1106).
// am[implements a-petta-cell-store.select]

import { Float, Str } from "../terms";
import { LIST_KEY, NIL_KEY, functorKey, type ArgVector, type Key } from "../swi-index";
import { ATM, ATV, BOX, INT, LIS, REF, STR, type Heap } from "./heap";

/** Arguments at cells[base], cells[base + 1], ...: the argument registers, or a compound's arguments on the heap. */
export class CellArgs implements ArgVector {
  constructor(
    readonly hp: Heap,
    readonly cells: Int32Array,
    readonly base: number,
  ) {}

  key(i: number): Key | null {
    const hp = this.hp;
    const c = hp.deref(this.cells[this.base + i]!);
    switch (c & 7) {
      case REF:
      case ATV:
        return null;
      case ATM:
        return c === hp.NIL ? NIL_KEY : hp.atomNames[c >> 3]!;
      case INT:
        return c >> 3;
      case STR: {
        const f = hp.h[c >> 3]! >> 3;
        return functorKey(hp.funNames[f]!, hp.funArity[f]!);
      }
      case LIS:
        return LIST_KEY;
      case BOX: {
        const v = hp.boxes[c >> 3];
        if (typeof v === "number" || typeof v === "bigint") return v;
        if (v instanceof Float) return "\u0001f" + (Object.is(v.v, -0) ? "-0" : String(v.v));
        if (v instanceof Str) return "\u0001s" + v.s;
        return null;
      }
    }
    return null;
  }

  sub(i: number): ArgVector | null {
    const hp = this.hp;
    const c = hp.deref(this.cells[this.base + i]!);
    if ((c & 7) === STR) return new CellArgs(hp, hp.h, (c >> 3) + 1);
    if ((c & 7) === LIS) return new CellArgs(hp, hp.h, c >> 3);
    return null;
  }
}
