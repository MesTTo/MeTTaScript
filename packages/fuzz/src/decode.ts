// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Strict decoders for the library's public result atoms.
//
// The MeTTa side is the source of truth: a run returns one result atom carrying everything a caller
// could need. A host that wants to render, persist, or exit on that result should not re-parse it by
// string matching, so this module turns each public outcome into a discriminated TypeScript value and
// keeps the original atom alongside it.
//
// Strict means a shape that is not recognized becomes `{ kind: "undecodable" }` with the reason,
// never a partially-filled success. A silently-tolerated shape change would let a host report a pass
// for a result it did not understand, which is the one failure mode worth designing against.

import { type Atom, format } from "@mettascript/core";

/** The counts every run reports. */
export interface FuzzCounts {
  readonly passed: number;
  readonly propertyDiscards: number;
  readonly generationDiscards: number;
  readonly regressions: number;
  readonly examples: number;
  readonly edges: number;
  readonly random: number;
}

export interface FuzzStatistics {
  readonly counts: FuzzCounts;
  /** `(Labels ...)`, `(Collected ...)`, `(Coverage ...)` kept as atoms: their shape is user data. */
  readonly labels: Atom | undefined;
  readonly collected: Atom | undefined;
  readonly coverage: Atom | undefined;
}

export interface ReachCounts {
  readonly states: number;
  readonly transitions: number;
  readonly depth: number;
}

/** One transition of a reachability witness. */
export interface ReachStep {
  readonly commandIndex: number;
  readonly command: Atom;
  readonly branch: number;
}

export type FuzzOutcome =
  | {
      readonly kind: "passed";
      readonly property: string;
      readonly seed: number | undefined;
      readonly statistics: FuzzStatistics | undefined;
      readonly atom: Atom;
    }
  | {
      readonly kind: "failed";
      readonly property: string;
      readonly phase: string | undefined;
      readonly caseIndex: number | undefined;
      readonly failureTag: string;
      readonly smallestValue: Atom | undefined;
      readonly smallestDetails: Atom | undefined;
      readonly replay: Atom | undefined;
      readonly shrink: Atom | undefined;
      readonly statistics: FuzzStatistics | undefined;
      readonly atom: Atom;
    }
  | {
      readonly kind: "gave-up";
      readonly property: string;
      readonly reason: string;
      readonly statistics: FuzzStatistics | undefined;
      readonly atom: Atom;
    }
  | {
      readonly kind: "exhaustively-verified";
      readonly property: string;
      readonly domainCount: number | undefined;
      readonly enumerated: number | undefined;
      readonly atom: Atom;
    }
  | {
      readonly kind: "invalid";
      readonly code: string;
      readonly details: readonly Atom[];
      readonly atom: Atom;
    }
  | {
      readonly kind: "reachable";
      readonly property: string;
      readonly depth: number | undefined;
      readonly commands: readonly Atom[];
      readonly witness: readonly ReachStep[];
      readonly target: Atom | undefined;
      readonly counts: ReachCounts | undefined;
      readonly atom: Atom;
    }
  | {
      readonly kind: "unreachable-within-depth";
      readonly property: string;
      readonly depth: number | undefined;
      readonly counts: ReachCounts | undefined;
      readonly atom: Atom;
    }
  | {
      readonly kind: "reachability-exhausted";
      readonly property: string;
      readonly states: number | undefined;
      readonly counts: ReachCounts | undefined;
      readonly atom: Atom;
    }
  | {
      readonly kind: "reachability-cutoff";
      readonly property: string;
      readonly reason: Atom | undefined;
      readonly counts: ReachCounts | undefined;
      readonly atom: Atom;
    }
  | {
      readonly kind: "undecodable";
      readonly reason: string;
      readonly atom: Atom;
    };

const headName = (atom: Atom): string | undefined =>
  atom.kind === "expr" && atom.items.length > 0 && atom.items[0]!.kind === "sym"
    ? (atom.items[0] as { name: string }).name
    : undefined;

/** The first `(<label> ...)` field of a result atom, or undefined when absent. */
function field(atom: Atom, label: string): Atom | undefined {
  if (atom.kind !== "expr") return undefined;
  for (const item of atom.items) if (headName(item) === label) return item;
  return undefined;
}

/** The single payload of a `(<label> payload)` field. */
function fieldValue(atom: Atom, label: string): Atom | undefined {
  const found = field(atom, label);
  return found?.kind === "expr" && found.items.length === 2 ? found.items[1] : undefined;
}

function symbolValue(atom: Atom | undefined): string | undefined {
  return atom?.kind === "sym" ? atom.name : undefined;
}

function integerValue(atom: Atom | undefined): number | undefined {
  if (atom?.kind !== "gnd") return undefined;
  const value = atom.value;
  if (value.g !== "int") return undefined;
  const n = Number(value.n);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** A quote-wrapped payload reports the value itself: the library quotes values that must not reduce. */
function unquote(atom: Atom | undefined): Atom | undefined {
  if (atom?.kind === "expr" && atom.items.length === 2 && headName(atom) === "quote")
    return atom.items[1];
  return atom;
}

function decodeCounts(statistics: Atom | undefined): FuzzCounts | undefined {
  const counts = statistics === undefined ? undefined : field(statistics, "Counts");
  if (counts === undefined) return undefined;
  const read = (label: string): number | undefined => integerValue(fieldValue(counts, label));
  const passed = read("Passed");
  const propertyDiscards = read("PropertyDiscards");
  const generationDiscards = read("GenerationDiscards");
  const regressions = read("Regressions");
  const examples = read("Examples");
  const edges = read("Edges");
  const random = read("Random");
  if (
    passed === undefined ||
    propertyDiscards === undefined ||
    generationDiscards === undefined ||
    regressions === undefined ||
    examples === undefined ||
    edges === undefined ||
    random === undefined
  )
    return undefined;
  return { passed, propertyDiscards, generationDiscards, regressions, examples, edges, random };
}

function decodeStatistics(atom: Atom): FuzzStatistics | undefined {
  const statistics = field(atom, "FuzzStatistics");
  if (statistics === undefined) return undefined;
  const counts = decodeCounts(statistics);
  if (counts === undefined) return undefined;
  return {
    counts,
    labels: field(statistics, "Labels"),
    collected: field(statistics, "Collected"),
    coverage: field(statistics, "Coverage"),
  };
}

function decodeReachCounts(atom: Atom): ReachCounts | undefined {
  const statistics = field(atom, "ReachStatistics");
  if (statistics === undefined) return undefined;
  const states = integerValue(fieldValue(statistics, "States"));
  const transitions = integerValue(fieldValue(statistics, "Transitions"));
  const depth = integerValue(fieldValue(statistics, "Depth"));
  if (states === undefined || transitions === undefined || depth === undefined) return undefined;
  return { states, transitions, depth };
}

function decodeWitness(atom: Atom): readonly ReachStep[] {
  const witness = fieldValue(atom, "Witness");
  if (witness?.kind !== "expr") return [];
  const steps: ReachStep[] = [];
  for (const step of witness.items) {
    if (step.kind !== "expr" || step.items.length !== 4 || headName(step) !== "Step") continue;
    const commandIndex = integerValue(step.items[1]);
    const branch = integerValue(step.items[3]);
    if (commandIndex === undefined || branch === undefined) continue;
    steps.push({ commandIndex, command: step.items[2]!, branch });
  }
  return steps;
}

/** The property or machine identifier a result names. */
function propertyOf(atom: Atom): string | undefined {
  return symbolValue(fieldValue(atom, "Property"));
}

/** Decode one public result atom. Never throws: an unrecognized shape decodes as `undecodable`. */
export function decodeFuzzOutcome(atom: Atom): FuzzOutcome {
  const head = headName(atom);
  if (head === undefined)
    return { kind: "undecodable", reason: "result is not a symbol-headed expression", atom };

  switch (head) {
    case "FuzzPassed": {
      const property = propertyOf(atom);
      if (property === undefined)
        return { kind: "undecodable", reason: "FuzzPassed without (Property ...)", atom };
      return {
        kind: "passed",
        property,
        seed: integerValue(fieldValue(atom, "Seed")),
        statistics: decodeStatistics(atom),
        atom,
      };
    }
    case "FuzzFailed": {
      const property = propertyOf(atom);
      const failureTag = symbolValue(fieldValue(atom, "FailureTag"));
      if (property === undefined || failureTag === undefined)
        return {
          kind: "undecodable",
          reason: "FuzzFailed without (Property ...) and (FailureTag ...)",
          atom,
        };
      return {
        kind: "failed",
        property,
        phase: symbolValue(fieldValue(atom, "Phase")),
        caseIndex: integerValue(fieldValue(atom, "CaseIndex")),
        failureTag,
        smallestValue: unquote(fieldValue(atom, "SmallestValue")),
        smallestDetails: field(atom, "SmallestDetails"),
        replay: field(atom, "Replay"),
        shrink: field(atom, "Shrink"),
        statistics: decodeStatistics(atom),
        atom,
      };
    }
    case "FuzzGaveUp": {
      const property = propertyOf(atom);
      // The reason is a bare symbol positioned after (Property ...), e.g. GenerationDiscards.
      const reason =
        atom.kind === "expr" ? atom.items.slice(1).find((item) => item.kind === "sym") : undefined;
      if (property === undefined || reason === undefined)
        return { kind: "undecodable", reason: "FuzzGaveUp without a property and a reason", atom };
      return {
        kind: "gave-up",
        property,
        reason: (reason as { name: string }).name,
        statistics: decodeStatistics(atom),
        atom,
      };
    }
    case "FuzzExhaustivelyVerified": {
      const property = propertyOf(atom);
      if (property === undefined)
        return {
          kind: "undecodable",
          reason: "FuzzExhaustivelyVerified without (Property ...)",
          atom,
        };
      return {
        kind: "exhaustively-verified",
        property,
        domainCount: integerValue(fieldValue(atom, "DomainCount")),
        enumerated: integerValue(fieldValue(atom, "Enumerated")),
        atom,
      };
    }
    case "FuzzInvalid": {
      // (FuzzInvalid <code> <details>...): the code is the first item after the head.
      const code = atom.kind === "expr" ? symbolValue(atom.items[1]) : undefined;
      if (code === undefined)
        return { kind: "undecodable", reason: "FuzzInvalid without a symbol code", atom };
      return {
        kind: "invalid",
        code,
        details: atom.kind === "expr" ? atom.items.slice(2) : [],
        atom,
      };
    }
    case "FuzzReachable": {
      const property = propertyOf(atom);
      if (property === undefined)
        return { kind: "undecodable", reason: "FuzzReachable without (Property ...)", atom };
      const commands = fieldValue(atom, "Commands");
      return {
        kind: "reachable",
        property,
        depth: integerValue(fieldValue(atom, "Depth")),
        commands: commands?.kind === "expr" ? commands.items : [],
        witness: decodeWitness(atom),
        target: unquote(fieldValue(atom, "Target")),
        counts: decodeReachCounts(atom),
        atom,
      };
    }
    case "FuzzUnreachableWithinDepth": {
      const property = propertyOf(atom);
      if (property === undefined)
        return {
          kind: "undecodable",
          reason: "FuzzUnreachableWithinDepth without (Property ...)",
          atom,
        };
      return {
        kind: "unreachable-within-depth",
        property,
        depth: integerValue(fieldValue(atom, "Depth")),
        counts: decodeReachCounts(atom),
        atom,
      };
    }
    case "FuzzReachabilityExhausted": {
      const property = propertyOf(atom);
      if (property === undefined)
        return {
          kind: "undecodable",
          reason: "FuzzReachabilityExhausted without (Property ...)",
          atom,
        };
      return {
        kind: "reachability-exhausted",
        property,
        states: integerValue(fieldValue(atom, "States")),
        counts: decodeReachCounts(atom),
        atom,
      };
    }
    case "FuzzReachabilityCutoff": {
      const property = propertyOf(atom);
      if (property === undefined)
        return {
          kind: "undecodable",
          reason: "FuzzReachabilityCutoff without (Property ...)",
          atom,
        };
      return {
        kind: "reachability-cutoff",
        property,
        reason: fieldValue(atom, "Reason"),
        counts: decodeReachCounts(atom),
        atom,
      };
    }
    default:
      return { kind: "undecodable", reason: `unknown result head ${head}`, atom };
  }
}

/** Process exit codes. Documented as part of the CLI contract, so scripts can branch on them. */
export const FUZZ_EXIT_OK = 0;
export const FUZZ_EXIT_PROPERTY_FAILURE = 1;
export const FUZZ_EXIT_INVALID = 2;
export const FUZZ_EXIT_INCOMPLETE = 3;

export type FuzzExitCode = 0 | 1 | 2 | 3;

/** The exit code one outcome deserves.
 *
 *  A reachability answer is graded by how complete it is rather than by whether finding the target is
 *  good news, which the tool cannot know: a replayed witness and a finite exhaustion are both
 *  definitive answers, while a depth answer and any cutoff are explicitly bounded and report
 *  incomplete. */
export function exitCodeForOutcome(outcome: FuzzOutcome): FuzzExitCode {
  switch (outcome.kind) {
    case "passed":
    case "exhaustively-verified":
    case "reachable":
    case "reachability-exhausted":
      return FUZZ_EXIT_OK;
    case "failed":
      return FUZZ_EXIT_PROPERTY_FAILURE;
    case "invalid":
    case "undecodable":
      return FUZZ_EXIT_INVALID;
    case "gave-up":
    case "unreachable-within-depth":
    case "reachability-cutoff":
      return FUZZ_EXIT_INCOMPLETE;
  }
}

// Worst-first precedence for a whole run. An invalid result outranks a property failure because it
// means the run could not be trusted to execute; a property failure outranks an incomplete run
// because a found counterexample is the more actionable finding.
const EXIT_PRECEDENCE: readonly FuzzExitCode[] = [
  FUZZ_EXIT_INVALID,
  FUZZ_EXIT_PROPERTY_FAILURE,
  FUZZ_EXIT_INCOMPLETE,
  FUZZ_EXIT_OK,
];

/** The exit code for a set of outcomes: the most severe one present, or OK when there are none. */
export function exitCodeForOutcomes(outcomes: readonly FuzzOutcome[]): FuzzExitCode {
  const seen = new Set<FuzzExitCode>(outcomes.map(exitCodeForOutcome));
  for (const code of EXIT_PRECEDENCE) if (seen.has(code)) return code;
  return FUZZ_EXIT_OK;
}

/** A single terminal line for an outcome. The full atom stays available for JSON and artifacts. */
export function renderOutcomeLine(outcome: FuzzOutcome): string {
  switch (outcome.kind) {
    case "passed": {
      const counts = outcome.statistics?.counts;
      const cases = counts === undefined ? "" : ` ${counts.passed} cases`;
      const seed = outcome.seed === undefined ? "" : `, seed ${outcome.seed}`;
      return `ok       ${outcome.property}${cases}${seed}`;
    }
    case "exhaustively-verified":
      return `ok       ${outcome.property} exhaustive, ${outcome.domainCount ?? "?"} trees`;
    case "failed": {
      const smallest =
        outcome.smallestValue === undefined ? "" : ` ${format(outcome.smallestValue)}`;
      return `FAILED   ${outcome.property} ${outcome.failureTag}${smallest}`;
    }
    case "gave-up":
      return `gave up  ${outcome.property} ${outcome.reason}`;
    case "invalid":
      return `invalid  ${outcome.code}`;
    case "reachable":
      return `reached  ${outcome.property} in ${outcome.depth ?? "?"} steps: ${outcome.commands
        .map(format)
        .join(" ")}`;
    case "unreachable-within-depth":
      return `bounded  ${outcome.property} no target at or below depth ${outcome.depth ?? "?"}`;
    case "reachability-exhausted":
      return `ok       ${outcome.property} unreachable in ${outcome.states ?? "?"} states`;
    case "reachability-cutoff":
      return `cutoff   ${outcome.property} ${
        outcome.reason === undefined ? "" : format(outcome.reason)
      }`;
    case "undecodable":
      return `invalid  undecodable result: ${outcome.reason}`;
  }
}
