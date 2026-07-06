// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// End-to-end over real CPython via pythonia. Gated: PY_LIVE=1 pnpm vitest run packages/py
// One bridge for the whole suite (pythonia's subprocess is a module-level singleton; per-test
// dispose+recreate would churn it and invalidate the root ffid).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MeTTa } from "@metta-ts/hyperon";
import { registerPyInterop, type PyBridge } from "./index";
import { makePythoniaBridge } from "./live-bridge";

const LIVE = process.env.PY_LIVE === "1";
const d = LIVE ? describe : describe.skip;

d("py-call over live CPython (pythonia)", () => {
  let bridge: PyBridge;
  let m: MeTTa;

  beforeAll(async () => {
    bridge = await makePythoniaBridge();
    m = new MeTTa();
    registerPyInterop(m, bridge);
  });
  afterAll(async () => {
    await bridge.dispose();
  });

  const one = async (q: string): Promise<string> => (await m.runAsync(q))[0]![0]!.toString();

  it("py-eval arithmetic returns a number", async () => {
    expect(await one('!(py-eval "2 ** 10")')).toBe("1024");
  });

  it("py-eval deep-converts a list, with @-term primitives", async () => {
    expect(await one("!(py-eval \"[1, 2.5, 'x', True, None]\")")).toBe(
      "(1 2.5 x (@ true) (@ none))",
    );
  });

  it("py-str folds a MeTTa list into a Python string", async () => {
    expect(await one("!(py-str (a b 1))")).toBe("ab1");
  });

  it("holds a live object and reads a field with getattr", async () => {
    // fractions.Fraction(2, 4) == 1/2; .numerator is a property, read via getattr
    expect(await one('!(py-call (getattr (py-call (fractions.Fraction 2 4)) "numerator"))')).toBe(
      "1",
    );
  });

  it("str() of a live handle round-trips through the bridge", async () => {
    expect(await one("!(py-call (str (py-call (fractions.Fraction 1 3))))")).toBe("1/3");
  });

  it("a raised Python error reaches MeTTa with its message, not blank", async () => {
    // pythonia leaves the exception's .message empty; the adapter recovers it from the stack, so the
    // (Error ...) atom carries the real Python text and the run does not abort.
    const r = await one('!(py-eval "1 / 0")');
    expect(r).toContain("Error");
    expect(r).toContain("division by zero");
  });

  it("numpy round-trips a list when importable", async () => {
    try {
      expect(await one("!(py-call (.tolist (py-call (numpy.array (1 2 3)))))")).toBe("(1 2 3)");
    } catch (e) {
      // numpy genuinely absent is acceptable here; any other error is a real failure.
      expect(String(e)).toMatch(/No module named|numpy/);
    }
  });
});
