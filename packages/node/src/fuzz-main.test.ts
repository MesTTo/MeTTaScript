// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// `metta fuzz` and `metta reach`. Spawns the built bin like the other CLI tests, because the exit code
// is half of the contract: 0 pass or definitive answer, 1 property failure, 2 invalid input, 3
// incomplete run.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFuzzArgs } from "./fuzz-main";

const METTA = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "metta-cli.js");

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

function metta(args: readonly string[]): Run {
  const done = spawnSync(process.execPath, [METTA, ...args], {
    encoding: "utf8",
    timeout: 240_000,
  });
  return { code: done.status ?? -1, out: done.stdout ?? "", err: done.stderr ?? "" };
}

/** Write files into one fresh directory and return the path of the first. */
function fixture(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), "metta-fuzz-cli-"));
  const paths = Object.entries(files).map(([name, content]) => {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  });
  return paths[0]!;
}

// One passing declaration and one failing one. `always-small` fails for every value at or above five,
// so shrinking must land on exactly five.
const SUITE = `
(: reverse-involution (-> Atom FuzzProperty))
(= (reverse-involution $xs) (expect-atom-equal (reverse (reverse $xs)) $xs))
(: always-small (-> Atom FuzzProperty))
(= (always-small $n) (expect-true (< $n 5) (Saw $n)))

(FuzzTest involution (gen-list (gen-int -20 20) 0 6) reverse-involution
          (fuzz-config (Runs 20) (EdgeCases 2)))
(FuzzTest bounded (gen-int 0 9) always-small (fuzz-config (Seed 3) (Runs 30)))

!(println! "DIRECTIVE-RAN")
`;

const PASSING = `
(: always (-> Atom FuzzProperty))
(= (always $value) (fuzz-pass))
(FuzzTest fine (gen-int 0 9) always (fuzz-config (Runs 5) (EdgeCases 1)))
`;

const COUNTER = `
(= (counter-enumerate (Count $n)) (FiniteCommands up))
(= (counter-transition (Count $n) up) (Count (+ $n 1)))
(= (at-three (Count $n)) (== $n 3))
(= (at-ninety (Count $n)) (== $n 90))
(FuzzReachTest climb (Count 0) counter-enumerate counter-transition at-three
               (reach-config (MaxDepth 10)))
(FuzzReachTest far (Count 0) counter-enumerate counter-transition at-ninety
               (reach-config (MaxDepth 5)))
!(println! "DIRECTIVE-RAN")
`;

describe("metta fuzz", () => {
  it("runs every declaration and exits 1 on a property failure", () => {
    const run = metta(["fuzz", fixture({ "p.metta": SUITE })]);

    expect(run.out).toContain("ok       involution");
    // The counterexample is shrunk before it is reported, so the smallest failing value is shown.
    expect(run.out).toContain("FAILED   bounded ExpectedTrue 5");
    expect(run.code).toBe(1);
  });

  it("does not execute the file's own directives", () => {
    // Reading a suite must not be a side channel for running whatever else the file would have run.
    const run = metta(["fuzz", fixture({ "p.metta": SUITE })]);

    expect(run.out).not.toContain("DIRECTIVE-RAN");
  });

  it("exits 0 when every declaration passes", () => {
    const run = metta(["fuzz", fixture({ "p.metta": PASSING })]);

    expect(run.out).toBe("ok       fine 6 cases, seed 0\n");
    expect(run.code).toBe(0);
  });

  it("lists declarations without running them", () => {
    const run = metta(["fuzz", "--list", fixture({ "p.metta": SUITE })]);

    expect(run.out).toContain("(FuzzTestCase involution (gen-list (gen-int -20 20) 0 6)");
    expect(run.out).not.toContain("FAILED");
    expect(run.code).toBe(0);
  });

  it("applies command-line settings over each declaration's own config", () => {
    const file = fixture({ "p.metta": PASSING });

    expect(metta(["fuzz", file]).out).toContain("6 cases, seed 0");
    // Runs counts the random cases, on top of the declaration's one edge case.
    expect(metta(["fuzz", "--seed", "42", "--runs", "3", file]).out).toContain("4 cases, seed 42");
  });

  it("prints result atoms as JSON when asked", () => {
    const run = metta(["fuzz", "--json", fixture({ "p.metta": SUITE })]);
    const parsed = JSON.parse(run.out) as { id: string; kind: string; result: string }[];

    expect(parsed.map((entry) => [entry.id, entry.kind])).toEqual([
      ["involution", "passed"],
      ["bounded", "failed"],
    ]);
    // The whole result atom travels with it, so a harness can read the replay key or the statistics.
    expect(parsed[1]!.result).toContain("(SmallestValue 5)");
    expect(run.code).toBe(1);
  });

  it("enumerates a whole domain and reports a bounded one as incomplete", () => {
    const file = fixture({
      "p.metta": `
        (: always (-> Atom FuzzProperty))
        (= (always $value) (fuzz-pass))
        (FuzzTest tiny (gen-bool) always (fuzz-config (MaxEnumerated 10)))
        (FuzzTest wide (gen-int 0 100) always (fuzz-config (MaxEnumerated 4)))
      `,
    });
    const run = metta(["fuzz", "--exhaustive", file]);

    expect(run.out).toContain("ok       tiny exhaustive, 2 trees");
    // 101 values do not fit in four, so the domain was not covered and the run is incomplete.
    expect(run.out).toContain("gave up  wide EnumerationLimit");
    expect(run.code).toBe(3);
  });

  it("reports a file with no declarations rather than saying nothing", () => {
    const run = metta(["fuzz", fixture({ "p.metta": "!(+ 1 2)\n" })]);

    expect(run.out).toContain("no (FuzzTest ...) declarations");
    expect(run.code).toBe(0);
  });

  it("resolves the imports a suite file declares", () => {
    const file = fixture({
      "p.metta": `
        !(import! &self props)
        (FuzzTest imported (gen-int 0 9) always (fuzz-config (Runs 2) (EdgeCases 0)))
      `,
      "props.metta": `
        (: always (-> Atom FuzzProperty))
        (= (always $value) (fuzz-pass))
      `,
    });
    const run = metta(["fuzz", file]);

    // The import is a directive too, but it is kept: dropping it would make the property undefined.
    expect(run.out).toContain("ok       imported");
    expect(run.code).toBe(0);
  });

  it("refuses bad arguments with exit 2", () => {
    const file = fixture({ "p.metta": PASSING });

    expect(metta(["fuzz", "--nope", file]).code).toBe(2);
    expect(metta(["fuzz", "--nope", file]).err).toContain("unknown option --nope");
    expect(metta(["fuzz", "--runs", file]).code).toBe(2);
    expect(metta(["fuzz", "--runs", "many", file]).code).toBe(2);
    expect(metta(["fuzz", file, file]).code).toBe(2);
    expect(metta(["fuzz", join(dirname(file), "missing.metta")]).code).toBe(2);
    expect(metta(["fuzz"]).code).toBe(0);
    expect(metta(["fuzz"]).out).toContain("usage");
  });

  it("reports an undecodable result as invalid rather than as a pass", () => {
    const file = fixture({
      "p.metta": `
        (: wrong (-> Atom FuzzProperty))
        (= (wrong $value) NotAPropertyResult)
        (FuzzTest broken (gen-bool) wrong (fuzz-config (Runs 1) (EdgeCases 0)))
      `,
    });
    const run = metta(["fuzz", file]);

    expect(run.out).toContain("invalid  MalformedPropertyResult");
    expect(run.code).toBe(2);
  });
});

describe("metta reach", () => {
  it("runs every declared search and reports the witness", () => {
    const run = metta(["reach", fixture({ "p.metta": COUNTER })]);

    expect(run.out).toContain("reached  climb in 3 steps: up up up");
    // Depth 5 cannot see (Count 90), and a bounded negative is an incomplete answer.
    expect(run.out).toContain("bounded  far no target at or below depth 5");
    expect(run.out).not.toContain("DIRECTIVE-RAN");
    expect(run.code).toBe(3);
  });

  it("restricts the run to one declaration by id", () => {
    const run = metta(["reach", fixture({ "p.metta": COUNTER }), "climb"]);

    expect(run.out).toBe("reached  climb in 3 steps: up up up\n");
    expect(run.code).toBe(0);
  });

  it("applies reach settings over each declaration's own config", () => {
    const file = fixture({ "p.metta": COUNTER });

    // The declaration asked for depth 5; raising the bound reaches the target, and a long witness is
    // elided with its true length rather than printed in full.
    const raised = metta(["reach", "--max-depth", "120", file, "far"]);
    expect(raised.out).toContain("reached  far in 90 steps: up up up up up up up up ...");
    expect(raised.out).toContain("(90 commands)");
    expect(raised.code).toBe(0);

    // A state bound is a cutoff, not a depth answer, and stays incomplete.
    const capped = metta(["reach", "--max-depth", "120", "--max-states", "4", file, "far"]);
    expect(capped.out).toContain("cutoff   far (MaxStatesReached (MaxStates 4))");
    expect(capped.code).toBe(3);
  });

  it("lists declared searches and rejects an unknown id", () => {
    const file = fixture({ "p.metta": COUNTER });

    expect(metta(["reach", "--list", file]).out).toContain("(FuzzReachCase climb (Count 0)");
    expect(metta(["reach", "--list", file]).code).toBe(0);
    expect(metta(["reach", file, "nope"]).code).toBe(2);
    expect(metta(["reach", file, "nope"]).out).toContain("no declaration named nope");
  });
});

describe("fuzz argument parsing", () => {
  it("keeps each subcommand's own options apart", () => {
    // A fuzz setting is not a reach setting: accepting it silently and then ignoring it would be
    // worse than refusing it.
    expect(parseFuzzArgs(["--max-depth", "3", "p.metta"], "reach").ok).toBe(true);
    expect(parseFuzzArgs(["--max-depth", "3", "p.metta"], "fuzz").ok).toBe(false);
    expect(parseFuzzArgs(["--runs", "3", "p.metta"], "fuzz").ok).toBe(true);
    expect(parseFuzzArgs(["--runs", "3", "p.metta"], "reach").ok).toBe(false);
    expect(parseFuzzArgs(["--exhaustive", "p.metta"], "reach").ok).toBe(false);
  });

  it("normalizes settings into MeTTa config options", () => {
    const parsed = parseFuzzArgs(["--seed", "7", "--runs", "9", "p.metta"], "fuzz");

    expect(parsed.ok && parsed.request.overrides).toEqual(["(Seed 7)", "(Runs 9)"]);
    expect(parsed.ok && parsed.request.file).toBe("p.metta");
  });

  it("takes a second positional only for reach", () => {
    expect(parseFuzzArgs(["p.metta", "climb"], "reach")).toMatchObject({
      ok: true,
      request: { only: "climb" },
    });
    expect(parseFuzzArgs(["p.metta", "climb"], "fuzz").ok).toBe(false);
  });
});
