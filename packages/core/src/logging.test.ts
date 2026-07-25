// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Leveled logging: `(pragma! log-level ...)` sets the enabled severity on the world, `log-enabled?` reads
// it, and `log!` emits only what that level admits. The property these tests exist for is that a call the
// level does not admit never reduces its payload, so instrumenting a function costs nothing until someone
// turns logging on. A payload that would not terminate is the sharpest way to state it: if the payload were
// reduced at all, the test would hang instead of failing.

import { afterEach, describe, expect, it } from "vitest";
import { setOutputSink } from "./builtins";
import { format } from "./parser";
import { runProgram } from "./runner";

const last = (src: string): string[] => {
  const rs = runProgram(src);
  return rs[rs.length - 1]!.results.map(format);
};

let restore: ((line: string) => void) | undefined;
const capture = (): string[] => {
  const lines: string[] = [];
  restore = setOutputSink((line) => lines.push(line));
  return lines;
};
afterEach(() => {
  if (restore) setOutputSink(restore);
  restore = undefined;
});

describe("log-enabled?", () => {
  it("is off until a level is set", () => {
    expect(last("!(log-enabled? error)")).toEqual(["False"]);
    expect(last("!(log-enabled? trace)")).toEqual(["False"]);
  });

  it("admits a level at or above the setting's severity", () => {
    const src = "!(pragma! log-level info)\n";
    expect(last(`${src}!(log-enabled? error)`)).toEqual(["True"]);
    expect(last(`${src}!(log-enabled? warn)`)).toEqual(["True"]);
    expect(last(`${src}!(log-enabled? info)`)).toEqual(["True"]);
    expect(last(`${src}!(log-enabled? debug)`)).toEqual(["False"]);
    expect(last(`${src}!(log-enabled? trace)`)).toEqual(["False"]);
  });

  it("treats `off` as admitting nothing, including itself", () => {
    expect(last("!(pragma! log-level trace)\n!(log-enabled? off)")).toEqual(["False"]);
    expect(last("!(pragma! log-level trace)\n!(log-enabled? trace)")).toEqual(["True"]);
    expect(
      last("!(pragma! log-level trace)\n!(pragma! log-level off)\n!(log-enabled? error)"),
    ).toEqual(["False"]);
  });

  it("returns a grounded Bool, so it drives `if` directly", () => {
    // A bare `False` symbol would not match the prelude's (= (if False $t $e) $e) and would leave the
    // if unreduced, which is exactly the shape a guard has to work in.
    expect(last("!(if (log-enabled? debug) yes no)")).toEqual(["no"]);
    expect(last("!(pragma! log-level debug)\n!(if (log-enabled? debug) yes no)")).toEqual(["yes"]);
  });

  it("rejects a level that is not a known severity", () => {
    expect(last("!(log-enabled? shouty)")[0]).toContain("UnknownLogLevel");
    expect(last("!(pragma! log-level shouty)")[0]).toContain("UnknownLogLevel");
  });
});

describe("log!", () => {
  it("emits nothing while logging is off", () => {
    const lines = capture();
    last("!(log! error (+ 1 2))");
    expect(lines).toEqual([]);
  });

  it("emits the payload's value tagged with its level once enabled", () => {
    const lines = capture();
    last("!(pragma! log-level info)\n!(log! info (+ 1 2))");
    expect(lines).toEqual(["(Log info 3)"]);
  });

  it("emits only what the level admits", () => {
    const lines = capture();
    last(
      "!(pragma! log-level warn)\n!(log! error a)\n!(log! warn b)\n!(log! info c)\n!(log! debug d)",
    );
    expect(lines).toEqual(["(Log error a)", "(Log warn b)"]);
  });

  it("reduces to unit either way, so it composes in a let", () => {
    capture();
    expect(last("!(let $x (log! debug ignored) done)")).toEqual(["done"]);
    expect(last("!(pragma! log-level debug)\n!(let $x (log! debug shown) done)")).toEqual(["done"]);
  });

  // The point of the whole design. `endless` has no base case, so reducing the payload cannot terminate.
  // Logging is off, so the payload is never reduced and the program finishes.
  it("does not reduce the payload of a call the level does not admit", () => {
    const endless = "(: endless (-> Number Number))\n(= (endless $n) (endless (+ $n 1)))\n";
    expect(last(`${endless}!(log! debug (endless 0))`)).toEqual(["()"]);
    expect(last(`${endless}!(pragma! log-level info)\n!(log! debug (endless 0))`)).toEqual(["()"]);
  });

  it("does not reduce the payload for effect either", () => {
    const lines = capture();
    last('!(log! debug (println! "payload"))');
    expect(lines).toEqual([]);
  });
});

describe("pragma! log-level", () => {
  it("carries the setting to later top-level queries", () => {
    const lines = capture();
    last("!(pragma! log-level debug)\n!(log! debug first)\n!(log! debug second)");
    expect(lines).toEqual(["(Log debug first)", "(Log debug second)"]);
  });

  it("can be turned back off", () => {
    const lines = capture();
    last(
      "!(pragma! log-level debug)\n!(log! debug on)\n!(pragma! log-level off)\n!(log! debug off)",
    );
    expect(lines).toEqual(["(Log debug on)"]);
  });
});
