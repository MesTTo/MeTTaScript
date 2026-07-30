// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `pnpm build` already refuses a stale module through `prebuild`, but test runs load
// `src/generated/module.ts` directly, so a stale file would silently execute outdated
// MeTTa sources here. This keeps the freshness check on the test path too.
describe("generated fuzz module", () => {
  it("matches the MeTTa sources", () => {
    const script = join(
      dirname(dirname(fileURLToPath(import.meta.url))),
      "scripts",
      "generate-module.mjs",
    );
    expect(() =>
      execFileSync(process.execPath, [script, "--check"], { stdio: "pipe" }),
    ).not.toThrow();
  });
});
