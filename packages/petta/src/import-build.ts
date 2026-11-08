// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: build the package's import snapshots (dist/petta.imports/) at package build time, after the image:
// for each library in lib/*.metta and each argv form argvForms derives from the argv-reading directives the image
// runs again at load, import the library as the first form of a program and record the load's effect
// (import-snapshot.ts).
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
import { argvDependence, atomsOf, Encoder, engineHash, loadImage, readImage, runArgvDirectives } from "./image";
import { IMPORTS_DIR, installImportReplay, recordImport, snapshotFiles, snapshotList, stateLines, type Snapshot } from "./import-snapshot";
import { copyTerm } from "./machine";
import { mkList } from "./terms";
import type { CellMachine } from "./cell/machine";

/**
 * The argv forms after a program's file the snapshots are recorded under, from the argv-reading directives image
 * `image` runs again at load (image.ts ArgvDependence): each directive given no atom or one of the atoms it names, an
 * atom kept only where the directive run alone under it leaves the argv predicates in a state no atom before it left,
 * and every combination of the directives' kept atoms. Branch atoms are left out, since a run naming one consults.
 * Time: one run of a directive per atom it names, then the product of the directives' kept atom counts.
 */
function argvForms(image: Record<string, unknown>, root: string): string[][] {
  const av = argvDependence(image, root);
  const h = new HostedPetta({ argv: ["argv-forms"], out: () => {}, err: (s) => process.stderr.write(s), load: "none" });
  loadImage(h.m, image, root);
  const enc = new Encoder(root);
  const state = (): string =>
    JSON.stringify(
      av.preds.map((key) => {
        const i = key.lastIndexOf("/");
        const p = h.m.db.get(key.slice(0, i), Number(key.slice(i + 1)));
        return p === undefined ? [] : p.clauses.filter((c) => c.died === Infinity).map((c) => enc.term(c.head));
      }),
    );
  let forms: string[][] = [[]];
  for (const d of av.directives) {
    const atoms = new Set<string>();
    atomsOf(d.goal, atoms);
    const seen = new Set<string>();
    const kept: string[][] = [];
    for (const tail of [[], ...[...atoms].filter((a) => !av.branchAtoms.includes(a)).sort().map((a) => [a])]) {
      h.m.flags.set("argv", mkList(["argv-forms", ...tail]));
      runArgvDirectives(h.m, av.preds, [{ file: d.file, goal: copyTerm(d.goal) }]);
      const s = state();
      if (!seen.has(s)) {
        seen.add(s);
        kept.push(tail);
      }
    }
    forms = forms.flatMap((f) => kept.map((t) => [...f, ...t]));
  }
  return forms;
}

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
  const image = readImage(p.image, p.root, engine, []);
  if (image === null) throw new Error("import snapshots: the image does not apply to this bundle; build the image first");
  const argvs = argvForms(image, p.root);
  const work = join(p.bundle, ".import-build");
  rmSync(work, { recursive: true, force: true });
  const snapshots: Snapshot[] = [];
  const skipped: string[] = [];
  try {
    for (const lib of readdirSync(join(p.root, "lib")).filter((f) => f.endsWith(".metta")).sort()) {
      for (const argv of argvs) {
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
  process.stdout.write(`${dir}: ${snapshots.length} snapshots in ${files.size} files over ${argvs.length} argv forms (${argvs.map((a) => a.join(" ") || "none").join(", ")}); not snapshotted:\n${skipped.map((s) => `  ${s}\n`).join("")}`);
}

main();
