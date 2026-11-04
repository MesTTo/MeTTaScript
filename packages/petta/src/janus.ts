// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: SWI-Prolog's library(janus) on the machine, as PeTTa's py-call and Python import! use it: py_call/2,3,
// py_is_object/1 and py_free/1. Calls go to a Python process (python/janus_bridge.py) over two FIFOs read with
// blocking reads, so each call is synchronous like janus's embedded interpreter, and values cross with janus's
// conversions (ai-tmp/probe/janus.pl, janus2.pl, janus3.pl on swipl 10.1.17): str comes back as an atom, bool as
// @(true)/@(false), None as @(none), tuple as -(...), set as py_set(List), dict as '$pydict'([K:V, ...]) (SWI's
// py{K:V, ...}), other objects as '$py'(Id, Type) references.
// am[implements a-hp-janus]

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Machine } from "./machine";
import {
  Cons,
  Float,
  NIL,
  PrologError,
  Str,
  Struct,
  Var,
  deref,
  instantiationError,
  mkList,
  mkStruct,
  mkVar,
  normInt,
  typeError,
  type Term,
} from "./terms";

type Json = { t: string; v?: unknown; type?: string };
type Step = { mod: string } | { obj: Json } | { attr: string } | { call: string; args: Json[]; kwargs: [string, Json][] };

interface Bridge {
  req: number;
  resp: number;
  pending: Buffer;
}

const bridges = new WeakMap<Machine, Bridge>();

/** python/janus_bridge.py beside dist or src. */
function bridgeScript(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [join(here, "..", "python", "janus_bridge.py"), join(here, "..", "..", "python", "janus_bridge.py")]) if (existsSync(c)) return c;
  return join(here, "..", "python", "janus_bridge.py");
}

function pyError(type: string, detail: Term): PrologError {
  return new PrologError(mkStruct("error", mkStruct("python_error", type, detail), mkVar()));
}

/**
 * Start the Python process on first use: two FIFOs in a fresh temporary directory, the bridge opened on them, and
 * both ends opened here (each open waits for the other side, so the names can go once they are open).
 */
function start(): Bridge {
  const python = process.env.PETTA_PYTHON ?? "python3";
  const probe = spawnSync(python, ["-c", "import json"], { stdio: "ignore" });
  if (probe.error !== undefined || probe.status !== 0) throw pyError("ImportError", `cannot run ${python}`);
  const dir = mkdtempSync(join(tmpdir(), "petta-janus-"));
  const reqPath = join(dir, "req");
  const respPath = join(dir, "resp");
  const mk = spawnSync("mkfifo", [reqPath, respPath], { stdio: "ignore" });
  if (mk.error !== undefined || mk.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw pyError("OSError", "mkfifo failed");
  }
  const child = spawn(python, [bridgeScript(), reqPath, respPath], { stdio: ["ignore", "inherit", "inherit"] });
  child.unref();
  const req = openSync(reqPath, "w");
  const resp = openSync(respPath, "r");
  rmSync(dir, { recursive: true, force: true });
  return { req, resp, pending: Buffer.alloc(0) };
}

/** One request and its answer line. Time: the Python call plus the size of the messages. */
function request(m: Machine, msg: object): { ok?: Json; err?: { type: string; ref: number }; out: string; errout: string } {
  let b = bridges.get(m);
  if (b === undefined) bridges.set(m, (b = start()));
  writeSync(b.req, JSON.stringify(msg) + "\n");
  const chunk = Buffer.alloc(1 << 16);
  let nl = b.pending.indexOf(10);
  while (nl < 0) {
    const n = readSync(b.resp, chunk, 0, chunk.length, null);
    if (n === 0) throw pyError("EOFError", "the Python bridge closed");
    b.pending = Buffer.concat([b.pending, chunk.subarray(0, n)]);
    nl = b.pending.indexOf(10);
  }
  const line = b.pending.subarray(0, nl).toString("utf8");
  b.pending = b.pending.subarray(nl + 1);
  return JSON.parse(line);
}

/** A Prolog term as janus passes it to Python. */
function toPy(t0: Term): Json {
  const t = deref(t0);
  if (t instanceof Var) throw instantiationError();
  if (typeof t === "number") return { t: "int", v: String(t) };
  if (typeof t === "bigint") return { t: "int", v: t.toString() };
  if (t instanceof Float) return { t: "float", v: Number.isNaN(t.v) ? "nan" : t.v === Infinity ? "inf" : t.v === -Infinity ? "-inf" : t.v };
  if (typeof t === "string") return { t: "str", v: t };
  if (t instanceof Str) return { t: "str", v: t.s };
  if (t === NIL) return { t: "list", v: [] };
  if (t instanceof Cons) {
    const items: Json[] = [];
    let c: Term = t;
    while (c instanceof Cons) {
      items.push(toPy(c.head));
      c = deref(c.tail);
    }
    if (c instanceof Var) throw instantiationError();
    if (c !== NIL) throw typeError("list", t);
    return { t: "list", v: items };
  }
  if (t instanceof Struct) {
    if (t.name === "@" && t.args.length === 1) {
      const a = deref(t.args[0]!);
      if (a === "true" || a === "false") return { t: "bool", v: a === "true" };
      if (a === "none") return { t: "none" };
    }
    if (t.name === "-") return { t: "tuple", v: t.args.map(toPy) };
    if (t.name === "py_set" && t.args.length === 1) return { t: "set", v: (toPy(t.args[0]!).v as Json[]) ?? [] };
    if (t.name === "$py" && t.args.length === 2) return { t: "ref", v: deref(t.args[0]!) };
    if (t.name === "$pydict" && t.args.length === 1) return { t: "dict", v: pairsOf(t.args[0]!).map(([k, v]) => [toPy(k), toPy(v)]) };
  }
  throw new PrologError(mkStruct("error", mkStruct("domain_error", "py_term", t), mkVar()));
}

function pairsOf(l: Term): [Term, Term][] {
  const out: [Term, Term][] = [];
  for (let c = deref(l); c instanceof Cons; c = deref(c.tail)) {
    const p = deref(c.head);
    if (p instanceof Struct && (p.name === "-" || p.name === ":") && p.args.length === 2) out.push([p.args[0]!, p.args[1]!]);
  }
  return out;
}

/** A Python value as janus returns it: strings as `stringAs` says (atom by default). */
function fromPy(j: Json, stringAs: string): Term {
  switch (j.t) {
    case "int": {
      const b = BigInt(j.v as string);
      return normInt(b);
    }
    case "float": {
      const v = j.v;
      return new Float(v === "inf" ? Infinity : v === "-inf" ? -Infinity : v === "nan" ? NaN : Number(v));
    }
    case "str": {
      const s = j.v as string;
      if (stringAs === "string") return new Str(s);
      if (stringAs === "codes") return mkList([...s].map((c) => c.codePointAt(0)!));
      if (stringAs === "chars") return mkList([...s]);
      return s;
    }
    case "bool":
      return mkStruct("@", j.v ? "true" : "false");
    case "none":
      return mkStruct("@", "none");
    case "list":
      return mkList((j.v as Json[]).map((x) => fromPy(x, stringAs)));
    case "tuple":
      return new Struct("-", (j.v as Json[]).map((x) => fromPy(x, stringAs)));
    case "set":
      return mkStruct("py_set", mkList((j.v as Json[]).map((x) => fromPy(x, stringAs))));
    case "dict":
      return mkStruct("$pydict", mkList((j.v as [Json, Json][]).map(([k, v]) => mkStruct(":", fromPy(k, stringAs), fromPy(v, stringAs)))));
    case "ref":
      return mkStruct("$py", j.v as number, j.type ?? "object");
  }
  throw pyError("TypeError", `cannot convert ${j.t}`);
}

/** A janus call spec as a chain: Root:Step:Step..., the root a module name or an object reference. */
function chainOf(call: Term): Step[] {
  const parts: Term[] = [];
  let c = deref(call);
  while (c instanceof Struct && c.name === ":" && c.args.length === 2) {
    parts.push(c.args[0]!);
    c = deref(c.args[1]!);
  }
  parts.push(c);
  if (parts.length < 2) throw typeError("py_callable", call);
  const root = deref(parts[0]!);
  const steps: Step[] = [];
  if (typeof root === "string") steps.push({ mod: root });
  else if (root instanceof Struct && root.name === "$py" && root.args.length === 2) steps.push({ obj: toPy(root) });
  else if (root instanceof Var) throw instantiationError();
  else throw typeError("py_callable", root);
  for (const p of parts.slice(1)) {
    const d = deref(p);
    if (d instanceof Var) throw instantiationError();
    if (typeof d === "string") steps.push({ attr: d });
    else if (d instanceof Struct) {
      const args: Json[] = [];
      const kwargs: [string, Json][] = [];
      for (const a of d.args) {
        const ad = deref(a);
        if (ad instanceof Struct && ad.name === "=" && ad.args.length === 2 && typeof deref(ad.args[0]!) === "string")
          kwargs.push([deref(ad.args[0]!) as string, toPy(ad.args[1]!)]);
        else args.push(toPy(ad));
      }
      steps.push({ call: d.name, args, kwargs });
    } else throw typeError("py_callable", d);
  }
  return steps;
}

function pyCall(m: Machine, call: Term, result: Term, opts: Term): boolean {
  let stringAs = "atom";
  for (let c = deref(opts); c instanceof Cons; c = deref(c.tail)) {
    const o = deref(c.head);
    if (o instanceof Struct && o.name === "py_string_as" && o.args.length === 1) stringAs = String(deref(o.args[0]!));
  }
  const answer = request(m, { op: "call", chain: chainOf(call) });
  if (answer.out) m.out(answer.out);
  if (answer.errout) m.err(answer.errout);
  if (answer.err !== undefined) throw pyError(answer.err.type, mkStruct("$py", answer.err.ref, answer.err.type));
  return m.unify(result, fromPy(answer.ok!, stringAs));
}

export function installJanus(m: Machine): void {
  m.defBuiltin("py_call", 1, { det: (m2, [c]) => pyCall(m2, c!, mkVar(), NIL) });
  m.defBuiltin("py_call", 2, { det: (m2, [c, r]) => pyCall(m2, c!, r!, NIL) });
  m.defBuiltin("py_call", 3, { det: (m2, [c, r, o]) => pyCall(m2, c!, r!, o!) });
  m.defBuiltin("py_is_object", 1, {
    det: (_, [t]) => {
      const d = deref(t!);
      return d instanceof Struct && d.name === "$py" && d.args.length === 2;
    },
  });
  m.defBuiltin("py_free", 1, {
    det: (m2, [t]) => {
      const d = deref(t!);
      if (d instanceof Struct && d.name === "$py" && d.args.length === 2) request(m2, { op: "free", id: deref(d.args[0]!) });
      return true;
    },
  });
}
