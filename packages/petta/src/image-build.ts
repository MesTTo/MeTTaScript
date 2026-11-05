// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: build the package's image (dist/petta.image.json) at package build time: consult PeTTa's vendored source
// twice, with argv ["--silent"] and [], record each load-time directive that read the argv flag and the predicates
// it changed, and check the two consulted states differ only in predicates such directives alone define; those
// directives run again when the image loads. The image is then loaded under both argv and must reproduce each
// consulted state exactly, or the build fails. Run as `node dist/image-build.js` after tsup.
// am[implements a-petta-speed-1105.startup.image]

import { writeFileSync } from "node:fs";
import { setDirectiveHook } from "./consult";
import { HostedPetta, imagePaths } from "./hosted";
import { engineHash, imageData, loadImage, type ArgvDirective } from "./image";
import { copyTerm, type Machine } from "./machine";
import { Cons, Struct, deref, type Term } from "./terms";

interface Consulted {
  readonly h: HostedPetta;
  readonly builtins: string[];
  readonly argvDirectives: (ArgvDirective & { effect: Set<string> })[];
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
  const argvDirectives: Consulted["argvDirectives"] = [];
  m.flagReads = reads;
  setDirectiveHook((mm, g, file, run) => {
    if (mm !== m) return run();
    const before = reads.get("argv") ?? 0;
    const gen = m.db.generation;
    const goal = copyTerm(g);
    run();
    if ((reads.get("argv") ?? 0) > before) argvDirectives.push({ file, goal, effect: changedSince(m, gen) });
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
function comparable(data: Record<string, unknown>): { preds: Map<string, string>; rest: string } {
  const preds = new Map<string, string>();
  const db = data.db as { preds: [string, number, number, unknown, unknown[][]][] };
  for (const [name, arity, bits, file, clauses] of db.preds)
    preds.set(name + "/" + arity, JSON.stringify([bits, file, clauses.map((c) => c.slice(0, 4))]));
  const rest = { ...data, db: null, files: null, argv: null, flags: (data.flags as [string, unknown][]).filter(([k]) => k !== "argv") };
  return { preds, rest: JSON.stringify(rest) };
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

function main(): void {
  const p = imagePaths();
  const engine = engineHash(p.bundle);
  const none = { directives: [], preds: [], branchAtoms: [] };
  const a = consultWith(["--silent"]);
  const b = consultWith([]);
  const ca = comparable(imageData(a.h.m, p.root, engine, a.builtins, none));
  const cb = comparable(imageData(b.h.m, p.root, engine, b.builtins, none));
  if (ca.rest !== cb.rest) throw new Error("image: consulting with and without --silent left different non-clause state");
  const differ = new Set<string>();
  for (const k of new Set([...ca.preds.keys(), ...cb.preds.keys()])) if (ca.preds.get(k) !== cb.preds.get(k)) differ.add(k);
  // The argv predicates must be defined by argv-reading directives that define nothing else; any other directive
  // that read argv took a branch both consults shared, so a run whose argv names one of its atoms consults.
  const confined = a.argvDirectives.filter((d) => d.effect.size > 0 && [...d.effect].every((k) => differ.has(k)));
  for (const k of differ)
    if (!confined.some((d) => d.effect.has(k))) throw new Error(`image: ${k} depends on argv through more than an argv-reading directive's own clauses`);
  const branchAtoms = new Set<string>();
  for (const d of a.argvDirectives) if (!confined.includes(d)) atomsOf(d.goal, branchAtoms);
  const dep = { directives: confined.map(({ file, goal }) => ({ file, goal })), preds: [...differ].sort(), branchAtoms: [...branchAtoms].sort() };
  const image = imageData(a.h.m, p.root, engine, a.builtins, dep);
  writeFileSync(p.image, JSON.stringify(image));
  // Round trip: loading the image under each argv must give that argv's consulted state.
  for (const [argv, want] of [[["--silent"], ca], [[], cb]] as const) {
    const h = new HostedPetta({ argv: [...argv], out: () => {}, err: (s) => process.stderr.write(s), load: "none" });
    loadImage(h.m, JSON.parse(JSON.stringify(image)), p.root);
    const got = comparable(imageData(h.m, p.root, engine, [...h.m.builtins.keys(), ...(image.removedBuiltins as string[])], none));
    if (got.rest !== want.rest) throw new Error(`image: loading under ${JSON.stringify(argv)} gives different non-clause state`);
    for (const k of new Set([...got.preds.keys(), ...want.preds.keys()]))
      if (got.preds.get(k) !== want.preds.get(k)) throw new Error(`image: loading under ${JSON.stringify(argv)} gives different clauses for ${k}`);
  }
  process.stdout.write(`${p.image}: ${(image.db as { preds: unknown[] }).preds.length} predicates; argv predicates ${dep.preds.join(", ") || "none"}\n`);
}

main();
