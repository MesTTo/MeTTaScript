// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// A regression corpus: the counterexamples a run already found, kept as text so a later run replays
// them before generating anything new. The runner already has the replay phase — it matches
// `(FuzzRegression <property> <value> <replay>)` facts in the space and runs them first — so a corpus
// is just those facts, written down.
//
// The design follows proptest's regression files and Go's fuzz corpus: one entry per counterexample,
// each self-describing and version-stamped, meant to be committed to source control so the failure
// travels with the code that caused it. Entries are content-addressed by the host, which is what makes
// a repeated write a no-op and deduplication structural rather than a comparison pass.
//
// An entry stores the value through the same versioned codec MeTTa uses for replay, not through plain
// formatting. That matters for values with no source syntax: a float is stored as its two 32-bit words,
// so NaN and the infinities survive a round trip exactly, and a grounded value with no encoding is
// refused outright instead of being written back as something else.
//
// An entry stores the value and nothing else. The recorded replay of the original failure is not kept:
// the runner uses it only as reporting context, and a stored generator key goes stale the moment the
// generator changes, which would make a corpus entry claim more than it can support. A replayed entry
// therefore carries no decision tree and is not shrunk again, reported as `(NotShrunk (Reason
// NoDecisionTree))`. That is what a corpus should do: the stored value is already the smallest one the
// run that found it could reach.

import { format, gint, parseAll, standardTokenizer, sym, expr, type Atom } from "@mettascript/core";
import { decodeAtomFromStorage, encodeAtomForStorage } from "./kernel.js";

/** Bumped when the on-disk entry shape changes. A reader refuses anything else. */
export const FUZZ_CORPUS_FORMAT = 1;

const ENTRY_HEAD = "FuzzCorpusEntry";
const KERNEL_ERROR_HEAD = "FuzzKernelError";

const HEADER = `; A counterexample MeTTaScript's fuzzer found, kept so later runs replay it first.
; Commit this file: the failure then travels with the code that caused it.
; Written by \`metta fuzz --corpus\`. Values use the versioned replay codec, not source syntax.
`;

export interface FuzzCorpusEntry {
  /** The id of the declaration the counterexample belongs to. */
  readonly property: string;
  /** The counterexample itself, decoded. */
  readonly value: Atom;
}

export type FuzzCorpusResult<T> = { readonly ok: true; readonly value: T } | FuzzCorpusFailure;

export interface FuzzCorpusFailure {
  readonly ok: false;
  readonly reason: string;
}

function failed(reason: string): FuzzCorpusFailure {
  return { ok: false, reason };
}

function isKernelError(atom: Atom): boolean {
  return (
    atom.kind === "expr" &&
    atom.items.length > 0 &&
    atom.items[0]?.kind === "sym" &&
    atom.items[0].name === KERNEL_ERROR_HEAD
  );
}

/**
 * The text of one corpus entry, or why the value cannot be stored. A value carrying a grounded object
 * with no encoding, such as a live space handle, has no text form and is refused here.
 */
export function renderCorpusEntry(entry: FuzzCorpusEntry): FuzzCorpusResult<string> {
  const encoded = encodeAtomForStorage(entry.value);
  if (isKernelError(encoded))
    return failed(`the value has no storable encoding: ${format(encoded)}`);
  const fact = expr([sym(ENTRY_HEAD), gint(FUZZ_CORPUS_FORMAT), sym(entry.property), encoded]);
  return { ok: true, value: `${HEADER}${format(fact)}\n` };
}

/**
 * The entry a file holds, or why it cannot be read. Every top-level atom must be one well-formed entry:
 * a corpus file is data, and a reader that skipped what it did not recognize would let anything else in
 * the file travel into the program alongside the entries.
 */
export function parseCorpusEntries(text: string): FuzzCorpusResult<FuzzCorpusEntry[]> {
  let tops;
  try {
    tops = parseAll(text, standardTokenizer());
  } catch (error) {
    return failed(`unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (tops.length === 0) return failed("no entries");

  const entries: FuzzCorpusEntry[] = [];
  for (const top of tops) {
    if (top.bang) return failed("a corpus file holds data, not queries");
    const atom = top.atom;
    if (
      atom.kind !== "expr" ||
      atom.items.length !== 4 ||
      atom.items[0]?.kind !== "sym" ||
      atom.items[0].name !== ENTRY_HEAD
    ) {
      return failed(`expected (${ENTRY_HEAD} ${FUZZ_CORPUS_FORMAT} <property> <value>)`);
    }
    const version = atom.items[1]!;
    if (
      version.kind !== "gnd" ||
      version.value.g !== "int" ||
      Number(version.value.n) !== FUZZ_CORPUS_FORMAT
    ) {
      return failed(`unsupported entry format, expected ${FUZZ_CORPUS_FORMAT}`);
    }
    const property = atom.items[2]!;
    if (property.kind !== "sym") return failed("the property id must be a symbol");
    const decoded = decodeAtomFromStorage(atom.items[3]!);
    if (isKernelError(decoded)) return failed(`undecodable value: ${format(decoded)}`);
    entries.push({ property: property.name, value: decoded });
  }
  return { ok: true, value: entries };
}

/**
 * The fact that puts an entry in front of a run. The replay slot is `None`, as it is for a declared
 * example: the value is what reproduces the failure.
 */
export function corpusRegressionFact(entry: FuzzCorpusEntry): Atom {
  return expr([sym("FuzzRegression"), sym(entry.property), entry.value, sym("None")]);
}
