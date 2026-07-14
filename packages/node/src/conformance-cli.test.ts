// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cliPath, mettaFixture } from "./cli-test-utils";

const CLI = cliPath(import.meta.url);
const fixture = (content: string): string => mettaFixture("conformance-cli-", content);

describe("metta-ts --conformance", () => {
  it("prints one bracketed result list per top-level directive", () => {
    const out = execFileSync(
      process.execPath,
      [
        CLI,
        "--conformance",
        fixture(`
          (foo 1 2)
          !(match &self (foo $x $y) ($x $y))
        `),
      ],
      { timeout: 60_000 },
    ).toString();

    expect(out).toBe("[]\n[(1 2)]\n");
  });

  it("leaves normal CLI output query-only", () => {
    const file = fixture(`
      (foo 1 2)
      !(match &self (foo $x $y) ($x $y))
    `);

    const out = execFileSync(process.execPath, [CLI, file], { timeout: 60_000 }).toString();

    expect(out).toBe("[(1 2)]\n");
  });

  it("reports type declarations and equations as empty directives", () => {
    const out = execFileSync(
      process.execPath,
      [
        CLI,
        "--conformance",
        fixture(`
          (: f (-> Number Number))
          (= (f $x) (+ $x 1))
          !(f 2)
        `),
      ],
      { timeout: 60_000 },
    ).toString();

    expect(out).toBe("[]\n[]\n[3]\n");
  });

  it("keeps literal Error atoms in the harness result bucket", () => {
    const out = execFileSync(
      process.execPath,
      [CLI, "--conformance", fixture("!(Error foo BadType)")],
      { timeout: 60_000 },
    ).toString();

    expect(out).toBe("[( Error foo BadType)]\n");
  });

  it("leaves normal CLI Error formatting canonical", () => {
    const out = execFileSync(process.execPath, [CLI, fixture("!(Error foo BadType)")], {
      timeout: 60_000,
    }).toString();

    expect(out).toBe("[(Error foo BadType)]\n");
  });

  it("runs literal hyperpose through the worker-backed path", () => {
    const out = execFileSync(
      process.execPath,
      [CLI, fixture("!(once (hyperpose ((+ 1 1) (* 1 2))))")],
      { timeout: 60_000 },
    ).toString();

    expect(out).toBe("[2]\n");
  });

  it("loads the worker-backed path when hyperpose is used by an imported rule", () => {
    const file = fixture("!(import! &self lib)\n!(run-hyperpose)");
    writeFileSync(
      join(dirname(file), "lib.metta"),
      "(= (run-hyperpose) (once (hyperpose ((+ 1 1) (* 1 2)))))",
    );

    const out = execFileSync(process.execPath, [CLI, file], { timeout: 60_000 }).toString();

    expect(out).toBe("[()]\n[2]\n");
  });

  it("runs a dynamically constructed hyperpose head through workers", () => {
    const out = execFileSync(
      process.execPath,
      [
        CLI,
        fixture(`
          (= (find-divisor $n $test-divisor)
             (if (> (* $test-divisor $test-divisor) $n)
                 $n
                 (if (== 0 (% $n $test-divisor))
                     $test-divisor
                     (find-divisor $n (+ $test-divisor 1)))))
          (= (prime? $n) (== $n (find-divisor $n 2)))
          !(let $h (atom_concat hyper pose)
             (once ($h ((prime? 535372570000000063)
                        (prime? 537818110000000001)
                        (prime? 5421844300001)
                        (prime? 547344310000000013)))))
        `),
      ],
      { timeout: 30_000 },
    ).toString();

    expect(out).toBe("[True]\n");
  });
});
