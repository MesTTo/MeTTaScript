// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: tests that the cell machine's checks of V8's heap against MemBalancer's limit come on time whatever each
// port costs: on a simulated clock and heap, the old generation growing at a fixed rate per millisecond, ports a
// hundred times slower after a fast stretch, each forced collection finds the old generation no further past the
// limit than the rate times the checks' spacing and one late tick, where checks a fixed number of ports apart let it
// run on for the whole slow stretch.
// am[verifies a-petta-heap-check-bound-1108]

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Machine } from "../machine";
import { CellMachine, membalancerLimit } from "./machine";

/** The simulated clock in milliseconds and old generation in bytes, which the mocked V8 statistics read. */
const sim = vi.hoisted(() => ({ now: 0, old: 0, checkMs: 0.002 }));
vi.mock("node:v8", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:v8")>()),
  // A check costs checkMs of the clock, as reading V8's space statistics does.
  getHeapSpaceStatistics: () => {
    sim.now += sim.checkMs;
    return [{ space_name: "old_space", space_used_size: sim.old, space_size: sim.old, space_available_size: 0, physical_space_size: sim.old }];
  },
  getHeapStatistics: () => ({ used_heap_size: sim.old }),
}));

const MB = 2 ** 20;

describe("cell machine heap checks", () => {
  beforeEach(() => {
    [sim.now, sim.old] = [0, 20 * MB];
    vi.spyOn(performance, "now").mockImplementation(() => sim.now);
  });
  afterEach(() => vi.restoreAllMocks());

  it("find the old generation past MemBalancer's limit by at most the rate times the spacing and one late tick", () => {
    const cm = new CellMachine(new Machine());
    const rate = 200 * 1024; // bytes a millisecond
    const found: { old: number; limit: number }[] = [];
    cm.majorGc = () => {
      const b = (cm as unknown as { balancer: { live: number; allocBytes: number; allocMs: number; gcBytes: number; gcMs: number } | null }).balancer;
      if (b !== null && b.allocMs > 0) found.push({ old: sim.old, limit: membalancerLimit(b.live, b.allocBytes / b.allocMs, b.gcBytes / b.gcMs) });
      // A collection takes 5 ms and keeps 60% of the old generation.
      sim.now += 5;
      sim.old = Math.round(sim.old * 0.6);
    };
    // 60000 fast ports of a microsecond, then 4000 slow ones of 100 microseconds each, the heap growing per millisecond.
    const run = (ports: number, ms: number): void => {
      for (let i = 0; i < ports; i++) {
        sim.now += ms;
        sim.old += rate * ms;
        cm.port();
      }
    };
    for (let phase = 0; phase < 10; phase++) {
      run(60000, 0.001);
      run(4000, 0.1);
    }
    expect(found.length).toBeGreaterThan(3);
    // The spacing is the check's cost over its 0.1% share, 2 ms; the slow stretch makes one tick, an eighth of it, a
    // hundred times late.
    const spacing = sim.checkMs / 1e-3, lateTick = (spacing / 8) * 100;
    // The first comes at the first allocation sample, before which there is no limit for the heap to pass.
    for (const f of found.slice(1)) expect(f.old - f.limit).toBeLessThanOrEqual(rate * (spacing + lateTick) + 1);
  });
});
