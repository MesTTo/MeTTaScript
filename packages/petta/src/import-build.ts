// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: build the package's import snapshots (dist/petta.imports/) at package build time, after the image:
// for each library in lib/*.metta and each argv form a run takes (with and without --silent, plain, --strict and
// --strict-det), import the library as the first form of a program and record the load's effect (import-snapshot.ts).
// Each snapshot is checked three ways before it ships: the import is recorded from programs at two different paths
// under two different working directories, which must give the same starting fingerprint, files and effect, so the
// effect names nothing of the importing program; and the second program is run again replaying the first program's
// snapshot, which must leave the same final state and print the same output as translating did. A library that fails
// any check is listed with the reason and imports by translating. Run as `node dist/import-build.js` after the image
// build.
// am[implements a-petta-next-1108.speed.imports.buildonly]
// am[implements a-petta-next-1108.speed.imports.equivalence]

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HostedPetta, imagePaths } from "./hosted";
import { engineHash } from "./image";
import { IMPORTS_DIR, installImportReplay, recordImport, snapshotFiles, snapshotList, stateLines, type Snapshot } from "./import-snapshot";
import type { CellMachine } from "./cell/machine";

/** The argv forms after a program's file the snapshots serve: what petta-compare and plain runs pass. */
const ARGVS: string[][] = [["--silent"], ["--silent", "--strict"], ["--silent", "--strict-det"], [], ["--strict"], ["--strict-det"]];

/** A program's run: the snapshot it recorded or why not, and its final state and output. */
interface Run {
  readonly snapshot: Snapshot | string;
  readonly final: string;
  readonly output: string;
}

/**
 * Run a program at `dir`/`name` whose one form imports `lib`, under argv `argv`, from `dir`: recording the library's
 * import, or replaying `replay` when given.
 */
function runIn(root: string, dir: string, name: string, lib: string, argv: string[], replay?: Snapshot): Run {
  mkdirSync(dir, { recursive: true });
  const prog = join(dir, name);
  writeFileSync(prog, `!(import! &self (library ${lib.replace(/\.metta$/, "")}))\n`);
  let snapshot: Snapshot | string = "the program never loaded the library";
  let loading = false;
  let cells: CellMachine | null = null;
  let output = "";
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const h = new HostedPetta({
      argv: [prog, ...argv],
      out: (s) => (output += s),
      err: (s) => (output += `[stderr]${s}`),
      onCells: (cm) => {
        cells = cm;
        if (replay !== undefined) installImportReplay(cm, root, snapshotList([replay]));
        else
          recordImport(cm, root, join(root, "lib", lib), (r) => ((snapshot = r), (loading = false)), () => (loading = true));
      },
    });
    output += `[exit ${h.run()}]`;
    if (loading) snapshot = "the load failed or threw";
  } catch (e) {
    snapshot = `the run threw: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    process.chdir(cwd);
  }
  let final = "";
  try {
    final = cells === null ? "" : stateLines(cells, root, true).join("\n");
  } catch (e) {
    final = `unencodable final state: ${e instanceof Error ? e.message : String(e)}`;
  }
  return { snapshot, final, output };
}

/** Time: three runs per library and argv form, each a fraction of a second to a few seconds. */
function main(): void {
  const p = imagePaths();
  const engine = engineHash(p.bundle);
  const work = join(p.bundle, ".import-build");
  rmSync(work, { recursive: true, force: true });
  const snapshots: Snapshot[] = [];
  const skipped: string[] = [];
  try {
    for (const lib of readdirSync(join(p.root, "lib")).filter((f) => f.endsWith(".metta")).sort()) {
      for (const argv of ARGVS) {
        const form = `${lib} ${JSON.stringify(argv)}`;
        const a = runIn(p.root, join(work, "a"), "first.metta", lib, argv);
        if (typeof a.snapshot === "string") {
          skipped.push(`${form}: ${a.snapshot}`);
          continue;
        }
        const bDir = join(work, "b", "deeper");
        const b = runIn(p.root, bDir, "second.metta", lib, argv);
        if (typeof b.snapshot === "string") skipped.push(`${form}: ${b.snapshot} (second importer)`);
        else if (a.snapshot.start !== b.snapshot.start) skipped.push(`${form}: the two importers start from different states`);
        else if (JSON.stringify([a.snapshot.files, a.snapshot.dirs, a.snapshot.effect]) !== JSON.stringify([b.snapshot.files, b.snapshot.dirs, b.snapshot.effect]))
          skipped.push(`${form}: the two importers give different effects`);
        else {
          const c = runIn(p.root, bDir, "second.metta", lib, argv, a.snapshot);
          if (c.output !== b.output) skipped.push(`${form}: replaying prints other output than translating`);
          else if (c.final !== b.final) skipped.push(`${form}: replaying leaves another state than translating`);
          else snapshots.push(a.snapshot);
        }
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const dir = join(p.bundle, IMPORTS_DIR);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
  const files = snapshotFiles(engine, snapshots);
  for (const [name, data] of files) writeFileSync(join(dir, name), JSON.stringify(data));
  process.stdout.write(`${dir}: ${snapshots.length} snapshots in ${files.size} files; not snapshotted:\n${skipped.map((s) => `  ${s}\n`).join("")}`);
}

main();
