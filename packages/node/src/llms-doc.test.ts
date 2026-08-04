// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// The claims in this package's LLMS.md, run. The point of this package over `core` is that `import!`
// resolves against the file system, so the examples need real files on disk — and the resolution rule
// is subtle enough that the document had it wrong until this test was written.
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { format } from "@mettascript/core";
import { runFile } from "./index.js";

const LIB = "(= (double $x) (* 2 $x))\n";
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "metta-llms-"));
  mkdirSync(join(root, "app"));
  mkdirSync(join(root, "a", "b"), { recursive: true });
  writeFileSync(join(root, "lib.metta"), LIB);
  writeFileSync(join(root, "app", "lib.metta"), LIB);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const write = (rel: string, src: string): string => {
  const p = join(root, rel);
  writeFileSync(p, src);
  return p;
};
const answers = (p: string): string[][] => runFile(p).map((q) => q.results.map(format));

describe("node/LLMS.md claims", () => {
  it("resolves a module name BESIDE the importing file", () => {
    const p = write("app/main.metta", "!(import! &self lib)\n!(double 21)\n");
    expect(answers(p)).toEqual([["()"], ["42"]]);
  });

  it("reaches one level out by default, but no further", () => {
    // `app/` has its own lib.metta above; use a directory that does not, so `../lib` is the only hit.
    const near = write("a/near.metta", "!(import! &self ../lib)\n!(double 21)\n");
    expect(answers(near)).toEqual([["()"], ["42"]]);
    const far = write("a/b/deep.metta", "!(import! &self ../../lib)\n!(double 21)\n");
    expect(answers(far)[0]![0]).toContain("Failed to resolve module ../../lib");
  });

  it("widens the reachable root with the pragma, which does NOT move the resolution base", () => {
    const ok = write(
      "a/b/deep-ok.metta",
      `!(pragma! import-root "${root}")\n!(import! &self ../../lib)\n!(double 21)\n`,
    );
    expect(answers(ok).at(-1)).toEqual(["42"]);
    // A bare name still means "beside this file", however wide the root is.
    const bare = write(
      "a/b/bare.metta",
      `!(pragma! import-root "${root}")\n!(import! &self lib)\n!(double 21)\n`,
    );
    expect(answers(bare)[1]![0]).toContain("Failed to resolve module lib");
  });

  it("reports an unresolvable import instead of loading nothing", () => {
    const p = write("app/bad.metta", "!(import! &self no-such-module)\n");
    expect(answers(p)[0]![0]).toContain("Failed to resolve module no-such-module");
  });
});
