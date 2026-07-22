// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// The unified `metta` CLI (metta-cli.ts). Spawns the built bin like the other CLI tests and checks that
// each subcommand dispatches, that the `metta-ts`/`metta-debug` aliases stay byte-identical, that the
// bare-file shorthand equals `run`, and that `graph` renders a GIF.

import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mettaFixture } from "./cli-test-utils";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const METTA = join(dist, "metta-cli.js");
const METTA_TS = join(dist, "cli.js");
const METTA_DEBUG = join(dist, "debug-cli.js");

const run = (bin: string, args: string[]): string =>
  execFileSync(process.execPath, [bin, ...args], { timeout: 120_000 }).toString();
const status = (bin: string, args: string[]): number =>
  spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", timeout: 120_000 }).status ?? -1;

describe("unified metta CLI", () => {
  it("run evaluates a program", () => {
    expect(run(METTA, ["run", mettaFixture("metta-run-", "!(+ 1 2)\n")])).toContain("3");
  });

  it("the bare-file shorthand equals `run`", () => {
    const file = mettaFixture("metta-short-", "!(* 6 7)\n");
    expect(run(METTA, [file])).toBe(run(METTA, ["run", file]));
  });

  it("run is byte-identical to the metta-ts alias", () => {
    const file = mettaFixture("metta-alias-", "(= (double $x) (* $x 2))\n!(double 21)\n");
    expect(run(METTA, ["run", file])).toBe(run(METTA_TS, [file]));
  });

  it("--max-steps sets the per-query inference budget", () => {
    const file = mettaFixture(
      "metta-work-budget-",
      `(= (choose) first)\n(= (choose) second)\n!(choose)\n`,
    );
    expect(run(METTA, ["run", "--max-steps=1", file])).toContain(
      "[first, (Error (choose) ResourceLimit)]",
    );
  });

  it("check passes a clean program and fails an arity error", () => {
    expect(status(METTA, ["check", mettaFixture("metta-ok-", "!(car-atom (a b))\n")])).toBe(0);
    expect(status(METTA, ["check", mettaFixture("metta-bad-", "!(car-atom 1 2)\n")])).toBe(1);
  });

  it("debug eval evaluates one expression", () => {
    expect(
      run(METTA, ["debug", "--source", "(= (double $x) (* $x 2))", "eval", "(double 21)"]),
    ).toContain("42");
  });

  it("debug is byte-identical to the metta-debug alias", () => {
    const args = ["--source", "!(+ 1 2)", "run"];
    expect(run(METTA, ["debug", ...args])).toBe(run(METTA_DEBUG, args));
  });

  it("--version prints the package version", () => {
    expect(run(METTA, ["--version"]).trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("--help and no args print usage", () => {
    expect(run(METTA, ["--help"])).toContain("metta");
    expect(run(METTA, [])).toContain("usage");
  });

  it("graph renders a reduction to a GIF file", () => {
    const file = mettaFixture("metta-graph-", "!(+ 10 (* 25 2))\n");
    const out = `${file}.gif`;
    run(METTA, ["graph", file, "-o", out, "--width", "240", "--max-steps", "60"]);
    expect(existsSync(out)).toBe(true);
    const bytes = readFileSync(out);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(bytes.subarray(0, 3).toString("latin1")).toBe("GIF");
    rmSync(out, { force: true });
  });
});
