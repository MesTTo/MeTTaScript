// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: the petta engine as PeTTa itself: PeTTa ee5cacb's own Prolog source (petta-src/, vendored from
// trueagi-io/PeTTa) consulted on the TypeScript machine with SWI's builtins, the vendored SWI libraries and the
// clpfd subset, then run through main.pl's main/0, so parsing, translation, type and determinism checking and
// evaluation are PeTTa's own code (a-pe-host-petta-src).
// am[implements a-hp-entry]

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installBuiltins, formatString } from "./builtins";
import { installClpfd } from "./clpfd";
import { installProcess } from "./process";
import { installJanus } from "./janus";
import { consultFile, installConsult, mainGoalOf, markLoaded } from "./consult";
import { installLibrary } from "./library";
import { Machine, profileReport } from "./machine";
import { errorMessage } from "./messages";
import { readClauses } from "./prolog-reader";
import { Halt, PrologError, Str, Struct, deref, listToArray, mkList, mkStruct, mkVar, NIL, textOf, type Term } from "./terms";
import { writeTerm } from "./writer";

export interface HostedOptions {
  /** The command-line arguments main.pl reads from the argv flag: files, then flags. */
  readonly argv: string[];
  readonly out?: (s: string) => void;
  readonly err?: (s: string) => void;
  readonly readLine?: () => string | null;
  /** PeTTa's src directory; the vendored petta-src by default. */
  readonly srcDir?: string;
}

/** The vendored PeTTa src directory (petta-src beside dist or src). */
function defaultSrcDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [join(here, "..", "petta-src"), join(here, "..", "..", "petta-src")]) if (existsSync(c)) return c;
  return join(here, "..", "petta-src");
}

/**
 * load_cache.pl replays a stored snapshot of a library load when the starting state matches; by its own
 * contract the effect equals load_metta_file's, which a cold cache runs, so cached-import! loads directly.
 */
const UNCACHED_LOAD_PL = String.raw`
load_metta_file_cached(F, R) :- load_metta_file(F, R).
load_metta_file_cached(F, R, S) :- load_metta_file(F, R, S).
`;

/** SWI-Prolog's flags as swipl 10.1.20 starts with them under run.sh. */
const SWI_FLAGS: [string, Term][] = [
  ["bounded", "false"],
  ["max_arity", "unbounded"],
  ["max_tagged_integer", 1152921504606846975],
  ["min_tagged_integer", -1152921504606846976],
  ["double_quotes", "codes"],
  ["unknown", "error"],
  ["occurs_check", "false"],
  ["version", 100120],
  ["dialect", "swi"],
  ["encoding", "utf8"],
  ["prefer_rationals", "false"],
  ["iso", "false"],
];

export class HostedPetta {
  readonly m = new Machine();
  readonly srcDir: string;

  constructor(opts: HostedOptions) {
    const m = this.m;
    this.srcDir = opts.srcDir ?? defaultSrcDir();
    if (opts.out) m.out = opts.out;
    if (opts.err) m.err = opts.err;
    if (opts.readLine) m.readLine = opts.readLine;
    for (const [k, v] of SWI_FLAGS) m.flags.set(k, v);
    m.flags.set("argv", mkList(opts.argv));
    installBuiltins(m);
    installLibrary(m);
    installConsult(m);
    installClpfd(m);
    installProcess(m);
    installJanus(m);
    markLoaded(m, join(this.srcDir, "load_cache.pl"));
    for (const c of readClauses(UNCACHED_LOAD_PL)) m.addClause(c, true);
    consultFile(m, join(this.srcDir, "main.pl"));
  }

  /**
   * main.pl's main/0, the goal of its initialization(main, main): the exit status halt/1 gives, 0 when main
   * succeeds, 1 when it fails; an uncaught error is reported on stderr as SWI does and the status is 2.
   */
  run(): number {
    try {
      return this.runMain();
    } finally {
      if (this.m.profile !== null) this.m.err(profileReport(this.m));
    }
  }

  private runMain(): number {
    const g = mainGoalOf(this.m);
    if (g === null) throw new Error(`${this.srcDir}/main.pl declares no initialization(main, main) goal`);
    try {
      if (this.m.solveOnce(g)) return 0;
      this.m.err("Warning: goal (initialization) failed\n");
      return 1;
    } catch (e) {
      if (e instanceof Halt) return e.status;
      if (e instanceof PrologError) {
        this.m.err(`ERROR: ${this.message(e.ball)}\n`);
        return 2;
      }
      if (e instanceof RangeError) {
        this.m.err("ERROR: Stack limit exceeded\n");
        return 2;
      }
      throw e;
    }
  }

  /**
   * An uncaught error's text: PeTTa's prolog:error_message//1 rules (main.pl) for its own error terms, SWI's
   * default wording otherwise, then the context's message in parentheses as SWI prints it.
   */
  message(ball: Term): string {
    const b = deref(ball);
    if (!(b instanceof Struct && b.name === "error" && b.args.length === 2)) return errorMessage(ball, "");
    const lines = mkVar();
    let text: string | null = null;
    try {
      if (this.m.solveOnce(mkStruct("error_message", b.args[0]!, lines, NIL))) text = this.renderLines(lines);
    } catch (e) {
      if (!(e instanceof PrologError)) throw e;
    }
    if (text === null) return errorMessage(ball, "");
    const ctx = deref(b.args[1]!);
    if (ctx instanceof Struct && ctx.name === "context" && ctx.args.length === 2) {
      const extra = textOf(deref(ctx.args[1]!));
      if (extra !== null && extra !== "") text += ` (${extra})`;
    }
    return text;
  }

  /** print_message/2's rendering of message lines: Format-Args, plain text and nl. */
  private renderLines(lines: Term): string {
    let out = "";
    for (const item of listToArray(lines) ?? []) {
      const d = deref(item);
      if (d instanceof Struct && d.name === "-" && d.args.length === 2) out += formatString(this.m, textOf(deref(d.args[0]!)) ?? "", d.args[1]!);
      else if (d === "nl") out += "\n";
      else if (typeof d === "string" || d instanceof Str) out += textOf(d) ?? "";
      else out += writeTerm(d, { quoted: true });
    }
    return out;
  }
}
