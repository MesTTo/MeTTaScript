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
export {
  decodeFuzzOutcome,
  exitCodeForOutcome,
  exitCodeForOutcomes,
  renderOutcomeLine,
  FUZZ_EXIT_OK,
  FUZZ_EXIT_PROPERTY_FAILURE,
  FUZZ_EXIT_INVALID,
  FUZZ_EXIT_INCOMPLETE,
  type FuzzOutcome,
  type FuzzExitCode,
  type FuzzCounts,
  type FuzzStatistics,
  type ReachCounts,
  type ReachStep,
} from "./decode.js";
export {
  corpusRegressionFact,
  parseCorpusEntries,
  renderCorpusEntry,
  FUZZ_CORPUS_FORMAT,
  type FuzzCorpusEntry,
  type FuzzCorpusFailure,
  type FuzzCorpusResult,
} from "./corpus.js";
export {
  FUZZ_ALPHA_REPLAY_KEY_ALGORITHM,
  FUZZ_ATOM_CODEC_VERSION,
  FUZZ_ATOM_KEY_ALGORITHM,
  FUZZ_REPLAY_KEY_ALGORITHM,
  FUZZ_RNG_ALGORITHM,
} from "./kernel.js";
