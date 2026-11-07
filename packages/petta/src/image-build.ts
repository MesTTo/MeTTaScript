// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: build the package's image (dist/petta.image.json) at package build time: consult PeTTa's vendored source
// with argv ["--silent"], record each load-time directive that read the argv flag and the predicates it changed, and
// call a directive confined when every predicate it changed got all its clauses from it; confined directives run
// again when the image loads. The source is then consulted once with no argv and once more for each atom an
// argv-reading directive names, added to --silent: where only confined predicates differ from the --silent consult,
// the image serves runs naming that atom, and otherwise the atom is a branch atom whose runs consult. The image is
// loaded under every argv it serves and must reproduce that consult exactly, or the build fails. Run as
// `node dist/image-build.js` after tsup.
// am[implements a-petta-speed-1105.startup.image]
// am[implements a-petta-speed-1105.startup.image-modes]

import { writeFileSync } from "node:fs";
import { setDirectiveHook } from "./consult";
import { HostedPetta, imagePaths } from "./hosted";
import { engineHash, imageData, loadImage, type ArgvDirective } from "./image";
import { copyTerm, type Machine } from "./machine";
import { Cons, Struct, deref, type Term } from "./terms";

/** A directive that read argv during a consult: what it changed, and the generations its run spans. */
interface ArgvRead extends ArgvDirective {
  readonly effect: Set<string>;
  readonly genFrom: number;
  readonly genTo: number;
}

interface Consulted {
  readonly h: HostedPetta;
  readonly builtins: string[];
  readonly argvDirectives: ArgvRead[];
}

/** Predicates with a clause added or retracted since generation `gen`. Time: every clause of every predicate. */
function changedSince(m: Machine, gen: number): Set<string> {
  const out = new Set<string>();
  for (const [k, p] of m.db.preds) if (p.clauses.some((c) => c.born > gen || (c.died !== Infinity && c.died > gen))) out.add(k);
  return out;
}

function consultWith(argv: string[]): Consulted {
  const h = new HostedPetta({ argv, out: () => {}, err: (s) => process.stderr.write(s), load: "none" });
  const m = h.m;
  const builtins = [...m.builtins.keys()];
  const reads = new Map<string, number>();
  const argvDirectives: ArgvRead[] = [];
  m.flagReads = reads;
  setDirectiveHook((mm, g, file, run) => {
    if (mm !== m) return run();
    const before = reads.get("argv") ?? 0;
    const gen = m.db.generation;
    const goal = copyTerm(g);
    run();
    if ((reads.get("argv") ?? 0) > before) argvDirectives.push({ file, goal, effect: changedSince(m, gen), genFrom: gen, genTo: m.db.generation });
  });
  try {
    h.consultSource();
  } finally {
    setDirectiveHook(null);
    m.flagReads = null;
  }
  return { h, builtins, argvDirectives };
}

/** A state's comparable parts: each predicate's clauses without their generation stamps, and the rest whole. */
interface Comparable {
  readonly preds: Map<string, string>;
  readonly rest: string;
}

function comparable(data: Record<string, unknown>): Comparable {
  const preds = new Map<string, string>();
  const db = data.db as { preds: [string, number, number, unknown, number, string][] };
  for (const [name, arity, bits, file, , json] of db.preds)
    preds.set(name + "/" + arity, JSON.stringify([bits, file, (JSON.parse(json) as unknown[][]).map((c) => c.slice(0, 4))]));
  const rest = { ...data, db: null, files: null, argv: null, flags: (data.flags as [string, unknown][]).filter(([k]) => k !== "argv") };
  return { preds, rest: JSON.stringify(rest) };
}

/** The predicates whose clauses differ between two states. */
function differing(a: Comparable, b: Comparable): string[] {
  const out: string[] = [];
  for (const k of new Set([...a.preds.keys(), ...b.preds.keys()])) if (a.preds.get(k) !== b.preds.get(k)) out.push(k);
  return out;
}

function atomsOf(t: Term, out: Set<string>): void {
  const d = deref(t);
  if (typeof d === "string") out.add(d);
  else if (d instanceof Struct) for (const a of d.args) atomsOf(a, out);
  else if (d instanceof Cons) {
    atomsOf(d.head, out);
    atomsOf(d.tail, out);
  }
}

/**
 * Time: one consult per atom the argv-reading directives name, plus two, and one image load per argv the image
 * serves; each consult is a few hundred milliseconds.
 */
function main(): void {
  const p = imagePaths();
  const engine = engineHash(p.bundle);
  const none = { directives: [], preds: [], branchAtoms: [] };
  const base = consultWith(["--silent"]);
  const m = base.h.m;
  const state = (c: Consulted): Comparable => comparable(imageData(c.h.m, p.root, engine, c.builtins, none));
  const cbase = state(base);
  // Confined: every predicate the directive changed has all its clauses from the directive's own run, so running it
  // again from no clauses rebuilds them for any argv.
  const owns = (d: ArgvRead, key: string): boolean => m.db.preds.get(key)!.clauses.every((c) => c.born > d.genFrom && c.born <= d.genTo);
  const confined = base.argvDirectives.filter((d) => d.effect.size > 0 && [...d.effect].every((k) => owns(d, k)));
  const confinedPreds = new Set(confined.flatMap((d) => [...d.effect]));
  const atoms = new Set<string>();
  for (const d of base.argvDirectives) atomsOf(d.goal, atoms);
  atoms.delete("--silent");
  // The argv values the image serves, each with the state a consult under it gives.
  const served: [string[], Comparable][] = [[["--silent"], cbase]];
  const branchAtoms = new Set<string>();
  for (const argv of [[], ...[...atoms].sort().map((a) => ["--silent", a])]) {
    let c: Comparable | null = null;
    try {
      c = state(consultWith(argv));
    } catch {
      // A consult that cannot finish under this atom (a library it would load is absent here): such runs consult.
    }
    const ok = c !== null && c.rest === cbase.rest && differing(c, cbase).every((k) => confinedPreds.has(k));
    if (ok) served.push([argv, c!]);
    else if (argv.length === 0) throw new Error("image: consulting without --silent changes more than the confined argv directives' predicates");
    else branchAtoms.add(argv[1]!);
  }
  const dep = {
    directives: confined.map(({ file, goal }) => ({ file, goal })),
    preds: [...confinedPreds].sort(),
    branchAtoms: [...branchAtoms].sort(),
  };
  const image = imageData(m, p.root, engine, base.builtins, dep);
  writeFileSync(p.image, JSON.stringify(image));
  // Round trip: loading the image under each argv it serves must give that argv's consulted state.
  for (const [argv, want] of served) {
    const h = new HostedPetta({ argv: [...argv], out: () => {}, err: (s) => process.stderr.write(s), load: "none" });
    loadImage(h.m, JSON.parse(JSON.stringify(image)), p.root);
    const got = comparable(imageData(h.m, p.root, engine, [...h.m.builtins.keys(), ...(image.removedBuiltins as string[])], none));
    if (got.rest !== want.rest) throw new Error(`image: loading under ${JSON.stringify(argv)} gives different non-clause state`);
    const bad = differing(got, want);
    if (bad.length > 0) throw new Error(`image: loading under ${JSON.stringify(argv)} gives different clauses for ${bad.join(", ")}`);
  }
  process.stdout.write(
    `${p.image}: ${(image.db as { preds: unknown[] }).preds.length} predicates; argv predicates ${dep.preds.join(", ") || "none"}; ` +
      `${served.length} argv forms checked; runs naming ${dep.branchAtoms.join(", ") || "nothing"} consult\n`,
  );
}

main();
