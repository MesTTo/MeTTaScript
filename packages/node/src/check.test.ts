// SPDX-FileCopyrightText: 2026 MesTTo
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkFile } from "./check";

function fixture(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "metta-check-"));
  const file = join(dir, "prog.metta");
  writeFileSync(file, content);
  return file;
}

// A main file plus a sibling `lib.metta` it imports, so `check` must resolve the import to see lib's types.
function importFixture(lib: string, main: string): string {
  const dir = mkdtempSync(join(tmpdir(), "metta-check-imp-"));
  writeFileSync(join(dir, "lib.metta"), lib);
  const file = join(dir, "main.metta");
  writeFileSync(file, main);
  return file;
}

describe("checkFile", () => {
  it("exits 0 with no output on a clean file", () => {
    const r = checkFile(fixture("!(car-atom (a b))"), { json: false, undefinedSymbols: false });
    expect(r.exitCode).toBe(0);
    expect(r.text).toBe("");
  });

  it("exits 1 and renders on an arity error", () => {
    const r = checkFile(fixture("!(car-atom 1 2)"), { json: false, undefinedSymbols: false });
    expect(r.exitCode).toBe(1);
    expect(r.text).toContain("error[arity-mismatch]");
    expect(r.text).toContain("car-atom expects 1 argument, got 2");
  });

  it("emits valid JSON with --json", () => {
    const r = checkFile(fixture("!(car-atom 1 2)"), { json: true, undefinedSymbols: false });
    const parsed = JSON.parse(r.text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].code).toBe("arity-mismatch");
  });

  it("resolves imports so a cross-file Atom-typed parameter is treated as data", () => {
    // lib types `store`'s formula parameter as Atom (unevaluated); main imports lib and passes a term that
    // would be a wrong-arity call if evaluated. The runtime never applies it, and neither should check.
    const lib = "(: store (-> SpaceType Atom %Undefined%))\n";
    const main = '!(import! &self "lib")\n!(store &s (Wrap (forall)))\n';
    const r = checkFile(importFixture(lib, main), { json: true, undefinedSymbols: false });
    const diags = JSON.parse(r.text) as { code: string }[];
    expect(diags.filter((d) => d.code === "arity-mismatch")).toEqual([]);
    expect(r.exitCode).toBe(0);
  });

  it("still flags a genuine arity error in the main file when imports are resolved", () => {
    const lib = "(: store (-> SpaceType Atom %Undefined%))\n";
    const main = '!(import! &self "lib")\n!(car-atom 1 2)\n';
    const r = checkFile(importFixture(lib, main), { json: true, undefinedSymbols: false });
    const diags = JSON.parse(r.text) as { code: string }[];
    expect(diags.filter((d) => d.code === "arity-mismatch")).toHaveLength(1);
    expect(r.exitCode).toBe(1);
  });
});
