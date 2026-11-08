// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: tests that the cell machine's heap limit (membalancerLimit) is V8's MemBalancer's: from the allocation
// rate, collection speed and live size V8's own balancer printed under --trace-memory-balancer (node 22, V8 12.4,
// running tilepuzzle and an allocating worker), it gives the limit V8 computed, to the trace's rounding.
// am[verifies a-petta-speed-general-1108.heap]

import { describe, expect, it } from "vitest";
import { membalancerLimit } from "./machine";

const KB = 1024;
const MB = 1024 * 1024;

/** V8's trace lines: allocation rate and collection speed in KB/ms, then its minimum and computed limits in MB. */
const TRACE: [number, number, number, number][] = [
  [75.0, 14839.6, 12.1, 22.8],
  [62.0, 2204.2, 21.5, 61.2],
  [151.0, 4709.8, 39.3, 99.0],
  [172.4, 5864.4, 56.2, 125.4],
  [149.2, 3738.4, 77.3, 173.0],
  [155.5, 5452.6, 85.5, 170.6],
  [1509.3, 2770.0, 108.6, 536.4],
];

describe("cell machine heap limit", () => {
  it.each(TRACE)("is V8's MemBalancer limit for allocation %f KB/ms and collection %f KB/ms", (alloc, speed, minimum, computed) => {
    // V8's minimum limit is the live size plus its 2 MB of least room.
    const live = (minimum - 2) * MB;
    expect(Math.abs(membalancerLimit(live, alloc * KB, speed * KB) / MB - computed)).toBeLessThan(0.2);
  });

  it("leaves at least 2 MB past the live size when allocation stops", () => {
    expect(membalancerLimit(50 * MB, 0, 5000 * KB)).toBe(52 * MB);
  });
});
