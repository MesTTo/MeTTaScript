// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: tests of import snapshots (import-snapshot.ts) on PeTTa consulted from source: a snapshot of lib_he
// (nested lib_error, clause references, backtrackable globals) and of lib_builtin_types recorded under one importer
// replays under another to the final state and output translating gives there, and the replay never runs the
// library's clauses, also under the same flags in another order with program arguments after them; an importer that
// defines a function or declares a type before its import, a library file that changed, and flags that change what
// PeTTa's argv-reading directives set each miss and translate; a library whose load reads argv gets no snapshot.
// am[verifies a-petta-next-1108.speed.imports.equivalence]

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CellMachine } from "./cell/machine";
import { HostedPetta } from "./hosted";
import { installImportReplay, recordImport, snapshotList, stateLines, type Snapshot } from "./import-snapshot";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const FIX = join(HERE, "import-fixtures");

/** Run fixture program `prog` under `argv`, `setup` given the cell machine first: its final state and output. */
function run(prog: string, argv: string[], setup: (cm: CellMachine) => void): { final: string; output: string } {
  let cells: CellMachine | null = null;
  let output = "";
  const h = new HostedPetta({
    argv: [join(FIX, prog), ...argv],
    out: (s) => (output += s),
    err: (s) => (output += `[stderr]${s}`),
    onCells: (cm) => {
      cells = cm;
      setup(cm);
    },
  });
  output += `[exit ${h.run()}]`;
  return { final: stateLines(cells!, ROOT, true).join("\n"), output };
}

/** The snapshot of `lib`'s import by fixture program `prog`. */
function record(prog: string, lib: string, argv: string[]): Snapshot {
  let snap: Snapshot | string = "the program never loaded the library";
  run(prog, argv, (cm) => recordImport(cm, ROOT, join(ROOT, "lib", lib), (r) => (snap = r)));
  if (typeof snap === "string") throw new Error(snap);
  return snap;
}

/** Run `prog` replaying `snaps`: its final state, output and the replay's trace. */
function replaying(prog: string, argv: string[], snaps: Snapshot[]): { final: string; output: string; trace: string[] } {
  const trace: string[] = [];
  const r = run(prog, argv, (cm) => installImportReplay(cm, ROOT, snapshotList(snaps), (e) => trace.push(e)));
  return { ...r, trace };
}

describe("import snapshots", () => {
  it.each([
    ["lib_he.metta", "a/first_he.metta", "b/deeper/second_he.metta"],
    ["lib_builtin_types.metta", "a/first_types.metta", "b/deeper/second_types.metta"],
  ])("replay %s under another importer to the state and output translating gives", (lib, first, second) => {
    const snap = record(first, lib, ["--silent"]);
    const translated = run(second, ["--silent"], () => {});
    const replayed = replaying(second, ["--silent"], [snap]);
    // One replay and no translation: the nested lib_error load is inside the replayed one.
    expect(replayed.trace).toStrictEqual([`replay lib/${lib}`]);
    expect(replayed.output).toBe(translated.output);
    expect(replayed.final).toBe(translated.final);
  }, 60000);

  it("replays under the same flags in another order with program arguments after them", () => {
    const snap = record("a/first_he.metta", "lib_he.metta", ["--silent", "--strict"]);
    const argv = ["--strict", "--silent", "extra", "42"];
    const translated = run("b/deeper/second_he.metta", argv, () => {});
    const replayed = replaying("b/deeper/second_he.metta", argv, [snap]);
    expect(replayed.trace).toStrictEqual(["replay lib/lib_he.metta"]);
    expect(replayed.output).toBe(translated.output);
    expect(replayed.final).toBe(translated.final);
  }, 60000);

  it("records no snapshot of a load that reads argv", () => {
    const pkg = join(FIX, "argv");
    let got: Snapshot | string = "the program never loaded the library";
    run("argv/main.metta", ["--silent"], (cm) => recordImport(cm, pkg, join(pkg, "lib", "reads_argv.metta"), (r) => (got = r)));
    expect(got).toBe("the load read argv");
  }, 60000);

  it("misses and translates for an importer that defined or declared first, a changed file and other flags", () => {
    const snap = record("a/first_he.metta", "lib_he.metta", ["--silent"]);
    const lib = "lib/lib_he.metta";
    const defines = replaying("b/deeper/defines_he.metta", ["--silent"], [snap]);
    expect(defines.trace).toStrictEqual([`miss ${lib}: no snapshot starts from this state and space`, `miss lib/lib_error.metta: no snapshot starts from this state and space`]);
    expect(defines.output).toBe(run("b/deeper/defines_he.metta", ["--silent"], () => {}).output);
    const declares = replaying("b/deeper/declares_he.metta", ["--silent"], [snap]);
    expect(declares.trace[0]).toBe(`miss ${lib}: no snapshot starts from this state and space`);
    const changed: Snapshot = { ...snap, files: snap.files.map(([f, h]) => [f, f === lib ? "0".repeat(40) : h]) };
    expect(replaying("b/deeper/second_he.metta", ["--silent"], [changed]).trace[0]).toBe(`miss ${lib}: a file it read changed`);
    expect(replaying("b/deeper/second_he.metta", ["--silent", "--oracle"], [snap]).trace[0]).toBe(`miss ${lib}: no snapshot starts from this state and space`);
  }, 90000);
});
