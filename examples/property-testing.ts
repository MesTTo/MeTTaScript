// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Property testing: state what should hold for every input, let the library find and shrink a
// counterexample, and read the result from TypeScript.
//
// Run it (after `pnpm build`): npx tsx examples/property-testing.ts
import { MeTTa } from "@mettascript/hyperon";
import { decodeFuzzOutcome, renderOutcomeLine } from "@mettascript/fuzz";
import { format, parseAll, standardTokenizer } from "@mettascript/core";

const m = new MeTTa();

// A property takes one generated value and returns a FuzzProperty. Declare a concrete return type, not
// Atom, or the call is left unreduced.
m.run(`
  !(import! &self fuzz)

  (: reverse-involution (-> Atom FuzzProperty))
  (= (reverse-involution $xs) (expect-atom-equal (reverse (reverse $xs)) $xs))

  (: sum-nonnegative (-> Atom FuzzProperty))
  (= (sum-nonnegative $xs)
     (expect-true (>= (foldl-atom $xs 0 $a $b (+ $a $b)) 0) (Sum $xs)))
`);

/** One result atom, decoded and rendered the way `metta fuzz` renders it. */
function check(query: string): string {
  const printed = m.run(`!${query}`).at(-1)![0]!.toString();
  const [atom] = parseAll(printed, standardTokenizer());
  return renderOutcomeLine(decodeFuzzOutcome(atom!.atom));
}

// True for every list, so this passes and reports how many cases it took.
console.log(
  check(`(fuzz-check reverse-involution (gen-list (gen-int -100 100) 0 40) reverse-involution
           (fuzz-config (Runs 100)))`),
); // ok       reverse-involution 113 cases, seed 0

// Not true: the elements can be negative. Generation finds (4 -5), and shrinking reduces it to (-1),
// the smallest list that still fails.
console.log(
  check(`(fuzz-check sum-nonnegative (gen-list (gen-int -10 10) 1 6) sum-nonnegative
           (fuzz-config (Seed 1) (Runs 50) (EdgeCases 0)))`),
); // FAILED   sum-nonnegative ExpectedTrue (-1)

// A small domain can be enumerated instead of sampled, which covers it rather than testing it.
m.run(`
  (: bool-involution (-> Atom FuzzProperty))
  (= (bool-involution $b) (expect-atom-equal (not (not $b)) $b))
`);
console.log(
  check(`(fuzz-check-exhaustive bool-involution (gen-bool) bool-involution
           (fuzz-config (MaxEnumerated 10)))`),
); // ok       bool-involution exhaustive, 2 trees

// The typed view carries the whole result, so a harness can act on the parts it cares about.
const printed = m
  .run(
    `!(fuzz-check sum-nonnegative (gen-list (gen-int -10 10) 1 6) sum-nonnegative
        (fuzz-config (Seed 1) (Runs 50) (EdgeCases 0)))`,
  )
  .at(-1)![0]!
  .toString();
const outcome = decodeFuzzOutcome(parseAll(printed, standardTokenizer())[0]!.atom);
if (outcome.kind === "failed") {
  console.log("failure tag:", outcome.failureTag); // ExpectedTrue
  console.log("original:", format(outcome.originalValue!)); // (4 -5)
  console.log("shrunk to:", format(outcome.smallestValue!)); // (-1)
  // The shrink report stays an atom: it says whether the value is locally minimal under the named order,
  // and how many candidates were tried to get there.
  console.log("shrink:", format(outcome.shrink!));
}
