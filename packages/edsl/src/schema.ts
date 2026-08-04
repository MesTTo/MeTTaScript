// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Decoding results with a validator you already use.
//
// An evaluation hands back atoms, and unwrapping them gives `unknown`: the engine rewrites at runtime,
// so no amount of type-level work can say what came out. That is exactly the `unknown -> typed` problem
// the JavaScript validation libraries solve, and there is no reason to solve it again here.
//
// So this takes a Standard Schema (https://standardschema.dev) rather than a validator of its own. That
// is a small TypeScript interface co-authored by the Zod, Valibot and ArkType authors: a library exposes
// a `~standard` property, and a tool that reads it validates with ANY of them. Zod, Valibot, ArkType,
// TypeBox, Yup and Joi all implement it, so one interface supports all of them, and the interface is
// types only, so `@mettascript/edsl` gains no runtime dependency for it.
//
//     import { z } from "zod";
//     db.evalAs(fetchUser(1), z.object({ name: z.string(), age: z.number() }));
//     // Array<{ name: string; age: number }> — validated, not asserted
//
// The types below are the spec's own, vendored rather than depended on, which is what the spec intends
// for a consumer.

/** A schema from any library implementing Standard Schema v1. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaV1.Props<Input, Output>;
}

// The spec's own shape: the helper types are namespace members (`StandardSchemaV1.Props`,
// `StandardSchemaV1.InferOutput`), so a library implementing it can be recognised structurally. It is
// types only and declaration-only, which is the case the namespace rule exists to allow.
// eslint-disable-next-line @typescript-eslint/no-namespace
export declare namespace StandardSchemaV1 {
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    /** The implementing library, e.g. `"zod"`. Reported in an error so the source is never in doubt. */
    readonly vendor: string;
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
    readonly types?: Types<Input, Output> | undefined;
  }

  export type Result<Output> = SuccessResult<Output> | FailureResult;

  export interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }

  export interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }

  export interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }

  export interface PathSegment {
    readonly key: PropertyKey;
  }

  export interface Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
  }

  export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<
    Schema["~standard"]["types"]
  >["output"];
}

/** Thrown when a result does not satisfy the schema it was decoded with. Carries the issues as the
 *  validator reported them, so a caller can render them however it already renders that library's. */
export class SchemaError extends Error {
  constructor(
    readonly issues: ReadonlyArray<StandardSchemaV1.Issue>,
    readonly vendor: string,
    readonly value: unknown,
  ) {
    const lines = issues.map((i) => {
      const path = (i.path ?? [])
        .map((p) => (typeof p === "object" ? String(p.key) : String(p)))
        .join(".");
      return path === "" ? i.message : `${path}: ${i.message}`;
    });
    super(`result did not match the ${vendor} schema: ${lines.join("; ")}`);
    this.name = "SchemaError";
  }
}

/** A schema's `validate` may answer asynchronously. The synchronous decoders say so rather than
 *  returning a promise where a value is expected. */
function assertSync<T>(
  r: StandardSchemaV1.Result<T> | Promise<StandardSchemaV1.Result<T>>,
  vendor: string,
): StandardSchemaV1.Result<T> {
  if (r instanceof Promise)
    throw new TypeError(
      `the ${vendor} schema validates asynchronously; use the awaiting form (evalAsyncAs)`,
    );
  return r;
}

/** Validate one value, answering it typed or raising. */
export function decodeWith<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
): StandardSchemaV1.InferOutput<S> {
  const props = schema["~standard"];
  const result = assertSync(props.validate(value), props.vendor);
  if (result.issues !== undefined) throw new SchemaError(result.issues, props.vendor, value);
  return result.value as StandardSchemaV1.InferOutput<S>;
}

/** The awaiting form, for a schema that validates asynchronously. */
export async function decodeWithAsync<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
): Promise<StandardSchemaV1.InferOutput<S>> {
  const props = schema["~standard"];
  const result = await props.validate(value);
  if (result.issues !== undefined) throw new SchemaError(result.issues, props.vendor, value);
  return result.value as StandardSchemaV1.InferOutput<S>;
}
