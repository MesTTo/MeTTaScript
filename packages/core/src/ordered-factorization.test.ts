// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  type OrderedAnswer,
  countOrderedAnswers,
  enumerateOrderedAnswers,
} from "./ordered-factorization";

const leaf = <T>(choice: number, occurrence: number, value: T): OrderedAnswer<T> => ({
  derivations: [{ choice, occurrence, children: [], build: () => value }],
});

const values = <T>(answers: readonly OrderedAnswer<T>[]): T[] =>
  [...enumerateOrderedAnswers(answers)].map((entry) => entry.value);

describe("ordered factorization", () => {
  it("keeps source choice order and duplicate alternatives", () => {
    const answers: OrderedAnswer<string>[] = [
      {
        derivations: [
          { choice: 2, occurrence: 2, children: [], build: () => "late" },
          { choice: 0, occurrence: 0, children: [], build: () => "first" },
          { choice: 0, occurrence: 1, children: [], build: () => "first" },
        ],
      },
    ];

    expect(values(answers)).toEqual(["first", "first", "late"]);
  });

  it("expands products left-major without materializing them in the circuit", () => {
    const left: OrderedAnswer<string> = {
      derivations: [
        { choice: 0, occurrence: 0, children: [], build: () => "a" },
        { choice: 1, occurrence: 1, children: [], build: () => "b" },
      ],
    };
    const right: OrderedAnswer<string> = {
      derivations: [
        { choice: 0, occurrence: 2, children: [], build: () => "1" },
        { choice: 1, occurrence: 3, children: [], build: () => "2" },
      ],
    };
    const product: OrderedAnswer<string> = {
      derivations: [
        {
          choice: 0,
          occurrence: 4,
          children: [left, right],
          build: ([x, y]) => x! + y!,
        },
      ],
    };

    expect(values([product])).toEqual(["a1", "a2", "b1", "b2"]);
    expect(countOrderedAnswers([product], 100n)).toBe(4n);
  });

  it("restores interleaved DFS order across shared logical answers", () => {
    const firstChild = leaf(0, 0, "child-0");
    const secondChild = leaf(1, 1, "child-1");
    const logicalA: OrderedAnswer<string> = {
      derivations: [
        { choice: 0, occurrence: 2, children: [firstChild], build: ([x]) => `A:${x}` },
        { choice: 1, occurrence: 4, children: [], build: () => "A:last" },
      ],
    };
    const logicalB: OrderedAnswer<string> = {
      derivations: [
        { choice: 0, occurrence: 3, children: [secondChild], build: ([x]) => `B:${x}` },
      ],
    };

    expect(values([logicalA, logicalB])).toEqual(["A:child-0", "B:child-1", "A:last"]);
  });

  it("interleaves distinct occurrences with the same structural order key", () => {
    const logicalA: OrderedAnswer<string> = {
      derivations: [
        { choice: 0, occurrence: 0, children: [], build: () => "A:first" },
        { choice: 0, occurrence: 2, children: [], build: () => "A:second" },
      ],
    };
    const logicalB: OrderedAnswer<string> = {
      derivations: [{ choice: 0, occurrence: 1, children: [], build: () => "B:first" }],
    };

    expect(values([logicalA, logicalB])).toEqual(["A:first", "B:first", "A:second"]);
  });

  it("saturates represented-output counts before expansion", () => {
    const choices: OrderedAnswer<number> = {
      derivations: Array.from({ length: 10 }, (_, choice) => ({
        choice,
        occurrence: choice,
        children: [],
        build: () => choice,
      })),
    };
    const square: OrderedAnswer<number> = {
      derivations: [
        {
          choice: 0,
          occurrence: 10,
          children: [choices, choices],
          build: ([x, y]) => x! * 10 + y!,
        },
      ],
    };

    expect(countOrderedAnswers([square], 1_000n)).toBe(100n);
    expect(countOrderedAnswers([square], 50n)).toBe(51n);
  });
});
