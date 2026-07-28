// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { registerBuiltinModule } from "@mettascript/core";
import { FUZZ_MODULE_SRC } from "./generated/module.js";
import { registerFuzzKernel } from "./kernel.js";

let registered = false;

/** Register the `fuzz` module and its private deterministic grounded operations. */
export function registerFuzz(): void {
  if (registered) return;
  registerFuzzKernel();
  registerBuiltinModule("fuzz", FUZZ_MODULE_SRC);
  registered = true;
}

registerFuzz();

export { FUZZ_MODULE_SRC };
export { FUZZ_ATOM_KEY_ALGORITHM, FUZZ_RNG_ALGORITHM } from "./kernel.js";
