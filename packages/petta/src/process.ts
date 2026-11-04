// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: the part of SWI-Prolog's library(process) and tmp_file/2 that PeTTa's libraries call (lib_import's
// git-import! runs git through process_create/3 and process_wait/2). The machine is synchronous, so a process runs
// to completion inside process_create/3; its output is delivered where the options send it, and process_wait/2
// answers its stored exit status.
// am[implements a-hp-process]

import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve as resolvePath } from "node:path";
import { InStream, OutStream } from "./builtins";
import type { Machine } from "./machine";
import { PrologError, Struct, Var, deref, existenceError, instantiationError, listToArray, mkStruct, mkVar, textOf, typeError, type Term } from "./terms";

/** Exit status of each finished process, by the PID process_create/3 reported. */
const statuses = new WeakMap<Machine, Map<number, Term>>();
let nextPid = 1;
let tmpCount = 0;

function textOrThrow(t: Term): string {
  const d = deref(t);
  if (d instanceof Var) throw instantiationError();
  const s = textOf(d);
  if (s === null) throw typeError("text", d);
  return s;
}

/** The executable of path(Name) (searched on PATH, as SWI's absolute_file_name(path(Name), ...) does) or a file. */
function executable(spec: Term): string {
  const d = deref(spec);
  if (d instanceof Struct && d.name === "path" && d.args.length === 1) {
    const name = textOrThrow(d.args[0]!);
    for (const dir of (process.env.PATH ?? "").split(delimiter)) {
      const p = join(dir, name);
      if (dir !== "" && existsSync(p)) return p;
    }
    throw existenceError("source_sink", d);
  }
  if (d instanceof Struct && d.name === "file" && d.args.length === 1) return resolvePath(textOrThrow(d.args[0]!));
  const p = textOrThrow(d);
  return isAbsolute(p) ? p : resolvePath(p);
}

type Sink = { kind: "std" } | { kind: "null" } | { kind: "pipe"; stream: Term } | { kind: "stream"; stream: Term };

function sinkOf(t: Term): Sink {
  const d = deref(t);
  if (d === "std") return { kind: "std" };
  if (d === "null") return { kind: "null" };
  if (d instanceof Struct && d.args.length >= 1 && d.name === "pipe") return { kind: "pipe", stream: d.args[0]! };
  if (d instanceof Struct && d.args.length === 1 && d.name === "stream") return { kind: "stream", stream: d.args[0]! };
  throw new PrologError(mkStruct("error", mkStruct("domain_error", "process_stream", d), mkVar()));
}

/** Deliver one output of a finished process where its option sends it; false if a pipe's stream does not unify. */
function deliver(m: Machine, sink: Sink, text: string, toErr: boolean): boolean {
  switch (sink.kind) {
    case "std":
      (toErr ? m.err : m.out)(text);
      return true;
    case "null":
      return true;
    case "pipe":
      return m.unify(sink.stream, mkStruct("$stream", m.registerObject(new InStream(text))));
    case "stream": {
      const o = m.objectOf(sink.stream);
      if (o instanceof OutStream) o.write(text);
      else if (deref(sink.stream) === "user_error") m.err(text);
      else m.out(text);
      return true;
    }
  }
}

export function installProcess(m: Machine): void {
  statuses.set(m, new Map());
  // process_create(+Exe, +Args, +Options): process(PID), cwd(Dir), env(List), environment(List), stdin(std|null),
  // stdout(Spec), stderr(Spec) with Spec std, null, pipe(S) or stream(S); detached/1 and window/1 are accepted.
  m.defBuiltin("process_create", 3, {
    det: (m2, [exeT, argsT, optsT]) => {
      const exe = executable(exeT!);
      const args = (listToArray(argsT!) ?? []).map((a) => {
        const d = deref(a);
        if (d instanceof Struct && d.name === "file" && d.args.length === 1) return resolvePath(textOrThrow(d.args[0]!));
        return textOrThrow(d);
      });
      let cwd: string | undefined;
      let env: NodeJS.ProcessEnv = process.env;
      let pid: Term | null = null;
      let out: Sink = { kind: "std" };
      let err: Sink = { kind: "std" };
      let stdin: "inherit" | "ignore" = "inherit";
      for (const o of listToArray(optsT!) ?? []) {
        const d = deref(o);
        if (!(d instanceof Struct) || d.args.length !== 1) continue;
        const a = d.args[0]!;
        if (d.name === "process") pid = a;
        else if (d.name === "cwd") cwd = resolvePath(textOrThrow(a));
        else if (d.name === "stdout") out = sinkOf(a);
        else if (d.name === "stderr") err = sinkOf(a);
        else if (d.name === "stdin") {
          const s = deref(a);
          if (s === "null") stdin = "ignore";
          else if (s !== "std") throw new PrologError(mkStruct("error", mkStruct("domain_error", "process_stream", s), mkVar()));
        } else if (d.name === "env" || d.name === "environment") {
          const vars: NodeJS.ProcessEnv = d.name === "env" ? {} : { ...process.env };
          for (const kv of listToArray(a) ?? []) {
            const e = deref(kv);
            if (e instanceof Struct && e.name === "=" && e.args.length === 2) vars[textOrThrow(e.args[0]!)] = textOrThrow(e.args[1]!);
          }
          env = vars;
        }
      }
      const r = spawnSync(exe, args, { cwd, env, stdio: [stdin, "pipe", "pipe"], encoding: "utf8", maxBuffer: 1 << 30 });
      if (r.error !== undefined) throw new PrologError(mkStruct("error", mkStruct("existence_error", "file", exe), mkVar()));
      const id = nextPid++;
      statuses.get(m2)!.set(id, r.signal !== null ? mkStruct("killed", r.signal) : mkStruct("exit", r.status ?? 0));
      return deliver(m2, out, r.stdout ?? "", false) && deliver(m2, err, r.stderr ?? "", true) && (pid === null || m2.unify(pid, id));
    },
  });
  const wait = (m2: Machine, pidT: Term, statusT: Term): boolean => {
    const id = deref(pidT);
    const s = typeof id === "number" ? statuses.get(m2)!.get(id) : undefined;
    if (s === undefined) throw existenceError("process", pidT);
    return m2.unify(statusT, s);
  };
  m.defBuiltin("process_wait", 2, { det: (m2, [p, s]) => wait(m2, p!, s!) });
  m.defBuiltin("process_wait", 3, { det: (m2, [p, s]) => wait(m2, p!, s!) });
  // A process has finished by the time process_create/3 returns, so there is nothing left to signal.
  m.defBuiltin("process_kill", 1, { det: () => true });
  m.defBuiltin("process_kill", 2, { det: () => true });
  // tmp_file(+Base, -File): a fresh file name in the temporary directory, swipl_<Base>_<pid>_<n> as SWI makes it.
  m.defBuiltin("tmp_file", 2, {
    det: (m2, [b, f]) => m2.unify(f!, join(tmpdir(), `swipl_${textOrThrow(b!)}_${process.pid}_${tmpCount++}`)),
  });
  // tmp_file_stream(+Encoding, -File, -Stream): a new temporary file opened for writing.
  m.defBuiltin("tmp_file_stream", 3, {
    det: (m2, [, f, s]) => {
      const path = join(tmpdir(), `swipl_${process.pid}_${tmpCount++}`);
      writeFileSync(path, "");
      return m2.unify(f!, path) && m2.unify(s!, mkStruct("$stream", m2.registerObject(new OutStream(path, true))));
    },
  });
}
