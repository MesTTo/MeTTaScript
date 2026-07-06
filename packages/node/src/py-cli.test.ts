// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// --py smoke test: the CLI runs a Python-using file end to end over real CPython (pythonia). Gated
// PY_LIVE=1. The default path (no flag) is byte-covered by the existing CLI/runner tests; here we
// also assert the missing-backend branch prints an actionable message (unconditionally, no Python
// needed for that one).
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");

function fixture(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "py-cli-"));
  const f = join(dir, "p.metta");
  writeFileSync(f, content);
  return f;
}

const LIVE = process.env.PY_LIVE === "1";
const d = LIVE ? describe : describe.skip;

d("metta-ts --py (live)", () => {
  it("runs py-eval from the command line", () => {
    const out = execFileSync(process.execPath, [CLI, "--py", fixture('!(py-eval "6 * 7")\n')], {
      timeout: 120_000,
    }).toString();
    expect(out).toContain("[42]");
  });

  it("evaluates the py-atom surface from the command line", () => {
    const out = execFileSync(
      process.execPath,
      [CLI, "--py", fixture("!((py-atom operator.add) 40 2)\n")],
      { timeout: 120_000 },
    ).toString();
    expect(out).toContain("[42]");
  });
});

describe("metta-ts --py (no backend)", () => {
  it("fails with an actionable message when pythonia is unavailable", () => {
    let msg = "";
    try {
      execFileSync(process.execPath, [CLI, "--py", fixture('!(py-eval "1")\n')], {
        env: { ...process.env, METTA_TS_FORCE_NO_PYTHONIA: "1" },
        timeout: 60_000,
      });
    } catch (e) {
      msg = String((e as { stderr?: Buffer }).stderr ?? "");
    }
    expect(msg).toContain("npm install pythonia");
  });
});
