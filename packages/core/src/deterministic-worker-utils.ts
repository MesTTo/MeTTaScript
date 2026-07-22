// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import type { Atom } from "./atom";
import type { Bindings } from "./bindings";
import { format } from "./parser";

export function formatWorkerPairs(pairs: readonly (readonly [Atom, Bindings])[]) {
  return pairs.map(([atom, bindings]) => ({
    atom: format(atom),
    bindings: bindings.map((binding) =>
      binding.tag === "val" ? `${binding.x}=${format(binding.a)}` : `${binding.x}=${binding.y}`,
    ),
  }));
}
