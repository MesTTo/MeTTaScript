// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Scale gate for real MeTTa programs. The generated cases exercise large static spaces, runtime-added
// spaces, named spaces, count aggregation, conjunctive joins, removals, automatic moded tabling, and the
// Hyperon-valid corpus workloads touched by the audit fixes.

import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "../../core/dist/index.js";
import { runFile, runSource } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = resolve(here, "corpus-mettats");
const FUEL = 100_000_000;
const sizeArg = process.argv.find((a) => a.startsWith("--size="));
const SIZE = sizeArg === undefined ? 30_000 : Number(sizeArg.slice("--size=".length));
if (!Number.isInteger(SIZE) || SIZE < 1) {
  console.error("--size must be a positive integer");
  process.exit(2);
}

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const fmtMs = (n) => n.toFixed(1);
const rows = [];

function runCase(name, src, expected, limitMs) {
  const t0 = performance.now();
  const out = runSource(src, FUEL);
  const ms = performance.now() - t0;
  const got = out.at(-1)?.results.map(format) ?? [];
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  rows.push({ name, ms, limitMs, got: got.join(" "), ok });
  if (!ok) throw new Error(`${name}: expected ${expected.join(" ")} got ${got.join(" ")}`);
  if (ms > limitMs) throw new Error(`${name}: ${fmtMs(ms)}ms exceeded ${limitMs}ms`);
}

function runCorpusCase(file, expected, limitMs) {
  const path = resolve(corpus, file);
  const t0 = performance.now();
  const out = runFile(path, FUEL);
  const ms = performance.now() - t0;
  const got = out.at(-1)?.results.map(format) ?? [];
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  rows.push({ name: basename(file, ".metta"), ms, limitMs, got: got.join(" "), ok });
  if (!ok) throw new Error(`${file}: expected ${expected.join(" ")} got ${got.join(" ")}`);
  if (ms > limitMs) throw new Error(`${file}: ${fmtMs(ms)}ms exceeded ${limitMs}ms`);
}

function bagPayload(out, name) {
  const results = out.at(-1)?.results ?? [];
  const bag = results.length === 1 ? results[0] : undefined;
  if (bag?.kind !== "expr" || bag.items[0]?.kind !== "sym" || bag.items[0].name !== ",")
    throw new Error(`${name}: expected one collapsed result bag`);
  return bag.items.slice(1);
}

function runBagCountCase(name, src, expectedCount, limitMs) {
  const t0 = performance.now();
  const out = runSource(src, FUEL);
  const ms = performance.now() - t0;
  const payload = bagPayload(out, name);
  const ok = payload.length === expectedCount;
  rows.push({ name, ms, limitMs, got: `${payload.length} items`, ok });
  if (!ok) throw new Error(`${name}: expected ${expectedCount} items, got ${payload.length}`);
  if (ms > limitMs) throw new Error(`${name}: ${fmtMs(ms)}ms exceeded ${limitMs}ms`);
}

function runBagValuesCase(name, src, expected, limitMs) {
  const t0 = performance.now();
  const out = runSource(src, FUEL);
  const ms = performance.now() - t0;
  const got = bagPayload(out, name).map(format);
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  rows.push({ name, ms, limitMs, got: `${got.length} checked items`, ok });
  if (!ok)
    throw new Error(
      `${name}: expected ${expected.slice(0, 20).join(" ")}, got ${got.slice(0, 20).join(" ")}`,
    );
  if (ms > limitMs) throw new Error(`${name}: ${fmtMs(ms)}ms exceeded ${limitMs}ms`);
}

function facts(n, f) {
  let out = "";
  for (let i = 0; i < n; i++) out += f(i) + "\n";
  return out;
}

const choiceWidth = 24;
const choiceTuple = Array.from({ length: choiceWidth }, (_, index) => index + 1).join(" ");
runBagCountCase(
  "choice product 24^4",
  `!(collapse
      (let* (($T (${choiceTuple}))
              ($X (superpose $T))
              ($Y (superpose $T))
              ($Z (superpose $T))
              ($W (superpose $T)))
        (+ $W (* (* $X $Y) $Z))))`,
  choiceWidth ** 4,
  8_000,
);

const tupleDistinct = 50;
const tupleRepeats = 10;
const duplicateTuple = Array.from({ length: tupleRepeats }, () =>
  Array.from({ length: tupleDistinct }, (_, index) => index + 1),
)
  .flat()
  .join(" ");
runBagValuesCase(
  "unique tuple product",
  `(= (TupleConcat $left $right)
      (unique-atom
        (collapse (superpose ((superpose $left) (superpose $right))))))
    !(TupleConcat (${duplicateTuple}) (${duplicateTuple}))`,
  Array.from({ length: tupleDistinct }, (_, index) => String(index + 1)),
  8_000,
);

const distinctFibMemo = new Map();
function distinctFibAnswers(n) {
  const known = distinctFibMemo.get(n);
  if (known !== undefined) return known;
  const out = [];
  const seen = new Set();
  const add = (value) => {
    if (seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };
  if (n < 2) add(n);
  else
    for (const left of distinctFibAnswers(n - 1))
      for (const right of distinctFibAnswers(n - 2)) add(left + right);
  add(42);
  distinctFibMemo.set(n, out);
  return out;
}

const distinctFibN = 10;
runBagValuesCase(
  "distinct fib(10)",
  `(= (fib $n)
      (if (< $n 2)
          $n
          (+ (fib (- $n 1)) (fib (- $n 2)))))
    (= (fib $n) 42)
    !(unique-atom (collapse (fib ${distinctFibN})))`,
  distinctFibAnswers(distinctFibN).map(String),
  8_000,
);

runCase(
  "moded relational fib(90)",
  `(= (rel-fib 0 $out) 0)
   (= (rel-fib 1 $out) 1)
   (= (rel-fib $n $out)
      (if (> $n 1)
          (let* (($a (rel-fib (- $n 1) $left))
                  ($b (rel-fib (- $n 2) $right)))
                 (+ $a $b))
          (empty)))
   !(rel-fib 90 $result)`,
  ["2880067194370816120"],
  8_000,
);

const mid = Math.floor(SIZE / 2);
const staticSpace =
  facts(SIZE, (i) => `(edge ${i} ${i + 1})`) +
  `!(collapse (match &self (edge ${mid} $y) $y))\n` +
  `!(collapse (match &self (edge $x ${mid}) $x))`;
runCase("static arg-index", staticSpace, [`(, ${mid - 1})`], 8_000);

const nestedStaticSpace =
  facts(SIZE, (i) => `(nested-static (${i === mid ? "M" : "W"} ${i}))`) +
  `!(collapse (match &self (nested-static (M $x)) $x))`;
runCase("static nested-head-index", nestedStaticSpace, [`(, ${mid})`], 8_000);

const runtimeSpace =
  facts(SIZE, (i) => `!(add-atom &self (rt ${i} ${i + 1}))`) +
  `!(collapse (match &self (rt ${mid} $y) $y))`;
runCase("runtime arg-index", runtimeSpace, [`(, ${mid + 1})`], 12_000);

// The result is consumed, so this measures nested-head candidate selection rather than dead-result removal.
const nestedRuntimeSpace =
  facts(SIZE, (i) => `!(add-atom &self (nested (M ${i})))`) +
  facts(SIZE, (i) => `!(add-atom &self (nested (W ${i})))`) +
  `!(length (collapse (match &self (nested (M $x)) $x)))`;
runCase("runtime nested-head-index", nestedRuntimeSpace, [String(SIZE)], 15_000);

const countAggregate =
  facts(SIZE, (i) => `(num ${i})`) + `!(length (collapse (match &self (num $x) $x)))`;
runCase("collapse count", countAggregate, [String(SIZE)], 8_000);

const namedSpace =
  `!(bind! &s (new-space))\n` +
  facts(SIZE, (i) => `!(add-atom &s (seen ${i}))`) +
  `!(collapse (match &s (seen ${mid}) ok))`;
runCase("named exact-space", namedSpace, ["(, ok)"], 12_000);

const tri = Math.min(180, Math.max(60, Math.floor(SIZE / 200)));
const triangles =
  facts(tri, (i) => `(e a${i} b${i})\n(e b${i} c${i})\n(e c${i} a${i})`) +
  `!(length (collapse (match &self (, (e $x $y) (e $y $z) (e $z $x)) ($x $y $z))))`;
runCase("conjunctive count", triangles, [String(tri * 3)], 8_000);

const staticRemoval =
  facts(SIZE, (i) => `(gone ${i} ${i + 1})`) +
  `!(remove-atom &self (gone ${mid} ${mid + 1}))\n` +
  `!(test (collapse (match &self (gone ${mid} $y) $y)) (,))\n` +
  `!(test (collapse (match &self (gone ${mid - 1} $y) $y)) (, ${mid}))`;
runCase("static removal-index", staticRemoval, ["()"], 8_000);

const runtimeRemoval =
  facts(SIZE, (i) => `!(add-atom &self (keep ${i} ${i + 1}))`) +
  `!(add-atom &self (= (dyn) old))\n` +
  `!(remove-atom &self (= (dyn) old))\n` +
  `!(test (dyn) (dyn))\n` +
  `!(collapse (match &self (keep ${mid} $y) $y))`;
runCase("runtime removal-index", runtimeRemoval, [`(, ${mid + 1})`], 15_000);

const CORPUS_PROOF_CASES = [
  "foldall.metta",
  "foldallmatch.metta",
  "foldallspacecount.metta",
  "forall.metta",
  "streamops.metta",
  "parse.metta",
  "hyperpose_primes.metta",
  "matchnested.metta",
  "matchnested2.metta",
  "spaces2.metta",
  "spaces3.metta",
  "supercollapse.metta",
  "superpose_nested.metta",
  "tests.metta",
  "selfprog.metta",
  "multiset_operations.metta",
  "permutations.metta",
  "peano.metta",
  "matespacefast.metta",
  "tilepuzzle.metta",
];

for (const file of CORPUS_PROOF_CASES) {
  runCorpusCase(file, ["()"], file === "matespacefast.metta" ? 12_000 : 8_000);
}

console.log(`MeTTa-TS scale proof, size=${SIZE}`);
console.log(pad("case", 24), padL("ms", 10), padL("limit", 10), " result");
console.log("-".repeat(66));
for (const r of rows)
  console.log(
    pad(r.name, 24),
    padL(fmtMs(r.ms), 10),
    padL(String(r.limitMs), 10),
    ` ${r.ok ? "pass" : "fail"} ${r.got}`,
  );
