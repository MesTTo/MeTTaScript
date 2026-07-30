// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Each @metta-ts/* compat shim re-exports its @mettascript/* canonical, so bundling-relevant package.json
// fields must match the canonical. sideEffects is the one that regressed: compat/browser shipped `false`
// while the canonical lists the hyperpose worker, so a bundler tree-shook the worker's side-effect import
// to an empty file. This asserts every shim mirrors its canonical's sideEffects, so a shim can never again
// drift into dropping a worker entry.
//
// It also asserts the pairing in the other direction. Walking only compat/* cannot notice a canonical with
// no shim at all, which is how a new package ships under one scope: @mettascript/fuzz was publishable for
// a while with no @metta-ts/fuzz beside it. Every publishable canonical needs its shim, and every package
// needs the same version, which is what the release bump refuses to run without.
const ROOT = process.cwd();
const COMPAT = resolve(ROOT, "compat");
const PACKAGES = resolve(ROOT, "packages");

interface Manifest {
  readonly sideEffects?: unknown;
  readonly private?: boolean;
  readonly version?: string;
}

const manifest = (dir: string): Manifest =>
  JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")) as Manifest;

const namesIn = (base: string): string[] =>
  readdirSync(base).filter((name) => existsSync(resolve(base, name, "package.json")));

const shimNames = namesIn(COMPAT);
const publishable = namesIn(PACKAGES).filter(
  (name) => manifest(resolve(PACKAGES, name)).private !== true,
);

describe("compat shim / canonical sideEffects parity", () => {
  it.each(shimNames)("compat/%s mirrors packages/%s sideEffects", (name) => {
    expect(existsSync(resolve(PACKAGES, name, "package.json")), `packages/${name} exists`).toBe(
      true,
    );
    expect(manifest(resolve(COMPAT, name)).sideEffects).toEqual(
      manifest(resolve(PACKAGES, name)).sideEffects,
    );
  });

  it.each(publishable)("packages/%s has a compat shim", (name) => {
    expect(existsSync(resolve(COMPAT, name, "package.json")), `compat/${name} exists`).toBe(true);
  });

  it("versions every package in lockstep", () => {
    const versions = [
      ...shimNames.map((name) => manifest(resolve(COMPAT, name)).version),
      ...publishable.map((name) => manifest(resolve(PACKAGES, name)).version),
    ];

    expect([...new Set(versions)]).toHaveLength(1);
  });
});
