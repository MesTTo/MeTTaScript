// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Decoding results with a Standard Schema. The schemas below are hand-written against the published
// interface rather than imported from Zod or Valibot, which is the point twice over: it demonstrates
// that the contract is all this package needs, and it keeps `@mettascript/edsl` free of a runtime
// dependency on any validator. A real Zod schema satisfies the same interface, because Zod is one of
// the libraries that co-authored it.
import { describe, expect, it } from "vitest";
import { SchemaError, decodeWith, mettaDB, mul, names, type StandardSchemaV1 } from "./index";

/** A Standard Schema v1 for "is a number", written by hand. */
const numberSchema: StandardSchemaV1<unknown, number> = {
  "~standard": {
    version: 1,
    vendor: "handrolled",
    validate: (v) =>
      typeof v === "number" ? { value: v } : { issues: [{ message: `expected a number` }] },
    types: undefined,
  },
};

/** One with a path on its issue, to check the message renders it. */
const personSchema: StandardSchemaV1<unknown, { name: string }> = {
  "~standard": {
    version: 1,
    vendor: "handrolled",
    validate: (v) => {
      if (typeof v !== "object" || v === null || Array.isArray(v))
        return { issues: [{ message: "expected an object" }] };
      const name = (v as Record<string, unknown>)["name"];
      return typeof name === "string"
        ? { value: { name } }
        : { issues: [{ message: "expected a string", path: ["name"] }] };
    },
    types: undefined,
  },
};

/** One that validates asynchronously, which the spec permits. */
const asyncNumber: StandardSchemaV1<unknown, number> = {
  "~standard": {
    version: 1,
    vendor: "handrolled-async",
    validate: (v) =>
      Promise.resolve(
        typeof v === "number" ? { value: v } : { issues: [{ message: "expected a number" }] },
      ),
    types: undefined,
  },
};

describe("decoding a result with a Standard Schema", () => {
  it("decodes every result, typed by the schema", () => {
    const db = mettaDB();
    const rows = db.evalAs(mul(6, 7), numberSchema);
    // the STATIC type is number[], from the schema's own inference
    const first: number | undefined = rows[0];
    expect(first).toBe(42);
  });

  it("raises with the validator's own issues when a result does not match", () => {
    const db = mettaDB();
    const { sym } = names("sym");
    try {
      db.evalAs(sym, numberSchema);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SchemaError);
      const err = e as SchemaError;
      expect(err.vendor).toBe("handrolled");
      expect(err.issues).toHaveLength(1);
      expect(err.message).toContain("expected a number");
    }
  });

  it("renders an issue's path in the message", () => {
    expect(() => decodeWith(personSchema, { name: 42 })).toThrow(/name: expected a string/);
    expect(decodeWith(personSchema, { name: "Ada" })).toEqual({ name: "Ada" });
  });

  it("says so rather than returning a promise where a value is expected", () => {
    // The spec allows `validate` to be async. The synchronous decoder must not hand back a promise
    // dressed as a value, so it names the problem and points at the awaiting form.
    expect(() => decodeWith(asyncNumber, 42)).toThrow(/validates asynchronously/);
  });

  it("awaits an async schema through the async form", async () => {
    const db = mettaDB();
    await expect(db.evalAsyncAs(mul(6, 7), asyncNumber)).resolves.toEqual([42]);
    const { sym } = names("sym");
    await expect(db.evalAsyncAs(sym, asyncNumber)).rejects.toBeInstanceOf(SchemaError);
  });
});
