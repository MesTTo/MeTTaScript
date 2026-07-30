// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// The filesystem half of the regression corpus. `@mettascript/fuzz` decides what an entry is and how a
// value is encoded; this decides where entries live and how they are written.
//
// One file per counterexample, named for the digest of its own text. Content addressing is what makes
// the two hard parts easy: recording a counterexample that is already stored writes the name that is
// already there, so deduplication is structural rather than a comparison pass, and a write is a create
// that never has to consider replacing another entry. New files land through a temporary name in the
// same directory followed by a rename, so a reader never sees a half-written entry.
//
// A file that cannot be read is an error, never a skip. Silently ignoring a corrupt entry would drop a
// known failure from the run while still reporting the run as complete.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  corpusRegressionFact,
  parseCorpusEntries,
  renderCorpusEntry,
  type FuzzCorpusEntry,
} from "@mettascript/fuzz";
import type { TopAtom } from "@mettascript/core";

const ENTRY_SUFFIX = ".metta";
/** Enough digest to make a collision irrelevant while keeping the name readable. */
const DIGEST_LENGTH = 16;
const LABEL_LENGTH = 32;

export interface CorpusLoad {
  /** Declarations to put in front of a run, one per stored counterexample. */
  readonly facts: readonly TopAtom[];
  readonly count: number;
}

export type CorpusReadResult =
  | { readonly ok: true; readonly load: CorpusLoad }
  | { readonly ok: false; readonly reason: string };

/** What recording an entry did, or why it could not be recorded. */
export type CorpusWriteResult =
  | { readonly ok: true; readonly recorded: boolean; readonly path: string }
  | { readonly ok: false; readonly reason: string };

function digestOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, DIGEST_LENGTH);
}

// The property id leads the name so a directory can be read at a glance. It is a MeTTa symbol and may
// hold anything, so only characters that are safe in a filename on every platform survive; the digest
// carries identity, and a name that sanitizes away to nothing is just the digest.
function entryName(property: string, text: string): string {
  const label = property.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, LABEL_LENGTH);
  const prefix = /[A-Za-z0-9]/.test(label) ? `${label}-` : "";
  return `${prefix}${digestOf(text)}${ENTRY_SUFFIX}`;
}

/**
 * Every entry in a corpus directory, as declarations. A directory that does not exist is an empty
 * corpus, which is the ordinary first run.
 */
export function readCorpus(dir: string): CorpusReadResult {
  if (!existsSync(dir)) return { ok: true, load: { facts: [], count: 0 } };

  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(ENTRY_SUFFIX));
  } catch (error) {
    return { ok: false, reason: `cannot read corpus ${dir}: ${messageOf(error)}` };
  }
  names.sort();

  const facts: TopAtom[] = [];
  for (const name of names) {
    const path = join(dir, name);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      return { ok: false, reason: `cannot read ${path}: ${messageOf(error)}` };
    }
    const parsed = parseCorpusEntries(text);
    if (!parsed.ok) return { ok: false, reason: `${path}: ${parsed.reason}` };
    for (const entry of parsed.value)
      facts.push({ atom: corpusRegressionFact(entry), bang: false });
  }
  return { ok: true, load: { facts, count: facts.length } };
}

/** Store one counterexample. An entry already present is left alone and reported as not recorded. */
export function recordCorpusEntry(dir: string, entry: FuzzCorpusEntry): CorpusWriteResult {
  const rendered = renderCorpusEntry(entry);
  if (!rendered.ok) return { ok: false, reason: rendered.reason };

  const path = join(dir, entryName(entry.property, rendered.value));
  if (existsSync(path)) return { ok: true, recorded: false, path };

  // The temporary name is unique per attempt so two runs recording at once cannot land on the same
  // partial file, and it sits in the destination directory so the rename stays within one filesystem.
  const temporary = `${path}.${process.pid}-${digestOf(`${path}${rendered.value}`)}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(temporary, rendered.value, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    return { ok: false, reason: `cannot record into ${dir}: ${messageOf(error)}` };
  }
  return { ok: true, recorded: true, path };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
