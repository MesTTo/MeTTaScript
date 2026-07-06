// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Differential oracle: the same corpus through live PeTTa (SWI + janus) and through
// @metta-ts/py + pythonia, comparing the (RESULT ...) line sequences byte-for-byte on the parity
// surface, and asserting mutual failure on the error corpus. Gated on PY_LIVE=1; the PeTTa checkout
// is PETTA_DIR (default /home/user/Dev/PeTTa). The helper defs (PY_METTA_SRC) are prepended to both
// sides, so the corpus needs no library import.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setOutputSink, runProgramAsync, format } from "@metta-ts/core";
import { PY_METTA_SRC, pyCoreAsyncOps, type PyBridge } from "./index";
import { makePythoniaBridge } from "./live-bridge";

const PETTA = process.env.PETTA_DIR ?? "/home/user/Dev/PeTTa";
const LIVE = process.env.PY_LIVE === "1" && existsSync(join(PETTA, "run.sh"));
const d = LIVE ? describe : describe.skip;

const here = dirname(fileURLToPath(import.meta.url));
const corpusDir = join(here, "..", "corpus");

const ANSI = /\x1b\[[0-9;]*m/g;
const resultLines = (text: string): string[] =>
  text
    .replace(ANSI, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("(RESULT"));

function runPeTTa(src: string): { lines: string[]; failed: boolean } {
  const dir = mkdtempSync(join(tmpdir(), "py-diff-"));
  const f = join(dir, "case.metta");
  writeFileSync(f, src);
  try {
    const out = execFileSync("sh", ["run.sh", f], { cwd: PETTA, timeout: 120_000 }).toString();
    return { lines: resultLines(out), failed: false };
  } catch (e) {
    const out = String((e as { stdout?: Buffer }).stdout ?? "");
    return { lines: resultLines(out), failed: true };
  }
}

function isError(atomText: string): boolean {
  return atomText.startsWith("(Error");
}

async function runOurs(
  src: string,
  bridge: PyBridge,
): Promise<{ lines: string[]; failed: boolean }> {
  const buf: string[] = [];
  const prev = setOutputSink((line) => buf.push(line));
  try {
    const rs = await runProgramAsync(PY_METTA_SRC + "\n" + src, pyCoreAsyncOps(bridge));
    // runProgramAsync returns core atoms (plain structs); format() gives their source text.
    const failed = rs.some((r) => r.results.some((a) => isError(format(a))));
    return { lines: resultLines(buf.join("\n")), failed };
  } finally {
    setOutputSink(prev);
  }
}

d("differential vs PeTTa", () => {
  let bridge: PyBridge;
  beforeAll(async () => {
    bridge = await makePythoniaBridge();
  });
  afterAll(async () => {
    await bridge.dispose();
  });

  const parity = readdirSync(corpusDir)
    .filter((f) => f.startsWith("py-parity"))
    .sort();

  for (const file of parity) {
    it(`byte-parity: ${file}`, async () => {
      const src = readFileSync(join(corpusDir, file), "utf8");
      const petta = runPeTTa(PY_METTA_SRC + "\n" + src);
      expect(petta.failed, "PeTTa run should not fail on the parity corpus").toBe(false);
      const ours = await runOurs(src, bridge);
      expect(ours.failed, "our run should not fail on the parity corpus").toBe(false);
      expect(ours.lines).toEqual(petta.lines);
    });
  }

  it("error corpus: PeTTa aborts, we surface (Error ...) and continue (documented divergence)", async () => {
    const src = readFileSync(join(corpusDir, "py-error-abort.metta"), "utf8");
    const petta = runPeTTa(PY_METTA_SRC + "\n" + src);
    const ours = await runOurs(src, bridge);
    // Both reach the pre-error println.
    expect(petta.lines).toContain("(RESULT before)");
    expect(ours.lines).toContain("(RESULT before)");
    // PeTTa aborts on the Python error and never reaches the post-error println.
    expect(petta.lines).not.toContain("(RESULT after)");
    // We turn the error into an atom and keep going.
    expect(ours.failed).toBe(true);
    expect(ours.lines).toContain("(RESULT after)");
  });
});
