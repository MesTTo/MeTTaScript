// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { RevisionMap, RevisionSet } from "./revision-collection";

describe("revisioned copy-on-write collections", () => {
  it("keeps a map snapshot stable when the source changes", () => {
    const source = new RevisionMap<string, number>([
      ["a", 1],
      ["b", 2],
    ]);
    const snapshot = source.snapshot();

    source.set("a", 3).delete("b");
    source.set("c", 4);

    expect([...snapshot]).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    expect([...source]).toEqual([
      ["a", 3],
      ["c", 4],
    ]);
    expect(snapshot.revision).toBe(0);
    expect(source.revision).toBe(3);
  });

  it("detaches a map snapshot when the snapshot changes", () => {
    const source = new RevisionMap<string, number>([["a", 1]]);
    const snapshot = source.snapshot();

    snapshot.set("b", 2);

    expect([...source]).toEqual([["a", 1]]);
    expect([...snapshot]).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    expect(source.revision).toBe(0);
    expect(snapshot.revision).toBe(1);
  });

  it("keeps a set snapshot stable when either side changes", () => {
    const source = new RevisionSet(["a", "b"]);
    const sourceSnapshot = source.snapshot();
    source.delete("a");
    source.add("c");

    const snapshotSource = new RevisionSet(["x"]);
    const changedSnapshot = snapshotSource.snapshot();
    changedSnapshot.add("y");

    expect([...sourceSnapshot]).toEqual(["a", "b"]);
    expect([...source]).toEqual(["b", "c"]);
    expect([...snapshotSource]).toEqual(["x"]);
    expect([...changedSnapshot]).toEqual(["x", "y"]);
  });

  it("releases an unchanged snapshot without changing revisions", () => {
    const source = new RevisionMap<string, number>([["a", 1]]);
    const snapshot = source.snapshot();

    snapshot.releaseSnapshot();
    source.set("b", 2);

    expect(source.revision).toBe(1);
    expect([...source]).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });
});
