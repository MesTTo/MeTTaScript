// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Unit tests for the pythonia adapter's error-message recovery. pythonia leaves a PythonException's
// `.message` empty and writes the real Python exception into `.stack`; pythonErrorText digs it out so
// a raised Python error reaches MeTTa as `(Error <expr> <message>)` with a readable message, not blank.
// The stack samples are copied verbatim from a live pythonia run (eval "1/0" and __import__ of a
// missing module), so this pins the parser to the real format with no Python needed.
import { describe, it, expect } from "vitest";
import { pythonErrorText } from "./py-pythonia";

/** Build an Error shaped like a pythonia PythonException: empty message, real text in the stack. */
function pyException(pythonLine: string): Error {
  const e = new Error("");
  e.stack =
    "*** PY ***  Python Error  Call to 'eval' failed:\n" +
    "> await builtins.eval(...)\n" +
    "  at <module> (<string>:1)\n" +
    "*** JS *** " +
    pythonLine;
  return e;
}

describe("pythonErrorText", () => {
  it("recovers a ZeroDivisionError message from the stack", () => {
    expect(pythonErrorText(pyException("ZeroDivisionError: division by zero"))).toBe(
      "ZeroDivisionError: division by zero",
    );
  });

  it("recovers a ModuleNotFoundError message from the stack", () => {
    expect(
      pythonErrorText(pyException("ModuleNotFoundError: No module named 'nosuchmodule12345'")),
    ).toBe("ModuleNotFoundError: No module named 'nosuchmodule12345'");
  });

  it("takes the last marker when the stack nests several", () => {
    const e = new Error("");
    e.stack = "*** JS *** Outer: a\n... across the bridge ...\n*** JS *** TypeError: inner boom";
    expect(pythonErrorText(e)).toBe("TypeError: inner boom");
  });

  it("falls back to a non-empty message on a plain JS error", () => {
    expect(pythonErrorText(new Error("plain boom"))).toBe("plain boom");
  });

  it("gives a placeholder for an empty error with no marker, not a blank string", () => {
    expect(pythonErrorText(new Error(""))).toBe("Python error");
  });

  it("stringifies a non-Error throwable", () => {
    expect(pythonErrorText("raw string error")).toBe("raw string error");
  });
});
