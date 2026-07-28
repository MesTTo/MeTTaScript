// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import sharp from "sharp";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MeTTa } from "@mettascript/hyperon";
import { parseProgram } from "./parse";
import { reduceTrace } from "./reduce";
import { blockReductionSvgs } from "./sidebyside-gif";
import { renderReductionGif, type NodeGifView } from "./node";

const QUICK = { width: 160, framesPerStep: 2, maxFrames: 8 } as const;

async function gifMetadata(bytes: Uint8Array) {
  return sharp(Buffer.from(bytes), { animated: true }).metadata();
}

function meanChannelError(actual: Uint8Array, expected: Uint8Array): number {
  expect(actual.byteLength).toBe(expected.byteLength);
  let error = 0;
  for (let i = 0; i < actual.byteLength; i++) error += Math.abs(actual[i]! - expected[i]!);
  return error / actual.byteLength;
}

describe("Node reduction GIFs", () => {
  it.each<NodeGifView>(["blocks", "graph", "side-by-side"])(
    "renders the %s view without a DOM",
    async (view) => {
      expect(globalThis.document).toBeUndefined();
      const bytes = await renderReductionGif("(+ 10 (* 25 2))", { ...QUICK, view });
      expect(Buffer.from(bytes.subarray(0, 6)).toString("ascii")).toBe("GIF89a");

      const metadata = await gifMetadata(bytes);
      expect(metadata.format).toBe("gif");
      expect(metadata.width).toBe(QUICK.width);
      expect(metadata.pages).toBe(5);
      expect(metadata.delay).toEqual([260, 40, 260, 40, 260]);
    },
  );

  it("accepts atoms and an existing MeTTa space", async () => {
    const metta = new MeTTa();
    metta.run("(= (double $x) (* $x 2))");
    const query = parseProgram("(double 21)")[0]!;

    const bytes = await renderReductionGif(query, { ...QUICK, metta });
    expect((await gifMetadata(bytes)).pages).toBeGreaterThan(1);
  });

  it("loads definitions from an atom list and traces the last query", async () => {
    const atoms = parseProgram("(= (double $x) (* $x 2))\n(double 21)");
    const bytes = await renderReductionGif(atoms, QUICK);
    expect((await gifMetadata(bytes)).pages).toBeGreaterThan(1);
  });

  it("accepts the standard top-level query marker", async () => {
    const bytes = await renderReductionGif("!(+ 20 22)", QUICK);
    expect((await gifMetadata(bytes)).pages).toBe(3);
  });

  it.each<NodeGifView>(["blocks", "graph", "side-by-side"])(
    "renders a plain-expression collapse result in the %s animation",
    async (view) => {
      const bytes = await renderReductionGif("(collapse (superpose (1 2 2)))", {
        ...QUICK,
        view,
      });
      const metadata = await gifMetadata(bytes);
      expect(metadata.format).toBe("gif");
      expect(metadata.pages).toBeGreaterThan(1);
    },
  );

  it("preserves the first and final SVG frames through rasterization and GIF encoding", async () => {
    const query = parseProgram("(+ 10 (* 25 2))")[0]!;
    const animation = blockReductionSvgs(reduceTrace(query, new MeTTa()), QUICK);
    const bytes = await renderReductionGif(query, QUICK);
    const decoded = await sharp(Buffer.from(bytes), { animated: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const frameBytes = animation.width * animation.height * 4;

    for (const index of [0, animation.frames.length - 1]) {
      const expected = await sharp(Buffer.from(animation.frames[index]!.svg))
        .resize(animation.width, animation.height, { fit: "fill" })
        .flatten({ background: animation.background })
        .ensureAlpha()
        .raw()
        .toBuffer();
      const actual = decoded.data.subarray(index * frameBytes, (index + 1) * frameBytes);
      expect(meanChannelError(actual, expected)).toBeLessThan(0.2);
    }
  });

  it.each([
    ["(= (double $x) (* $x 2))", "no query"],
    ["42", "does not reduce"],
  ])("rejects an input that %s", async (source, message) => {
    await expect(renderReductionGif(source, QUICK)).rejects.toThrow(message);
  });

  it("rejects an unknown view passed from JavaScript", async () => {
    await expect(
      renderReductionGif("(+ 1 2)", { ...QUICK, view: "unknown" as NodeGifView }),
    ).rejects.toThrow("view");
  });

  it.each([
    [{ width: 0 }, "width"],
    [{ width: 4097 }, "width"],
    [{ framesPerStep: 0 }, "framesPerStep"],
    [{ maxFrames: 0 }, "maxFrames"],
    [{ maxSteps: 0 }, "maxSteps"],
  ])("rejects unsafe options %j", async (options, message) => {
    await expect(renderReductionGif("(+ 1 2)", { ...QUICK, ...options })).rejects.toThrow(message);
  });

  it("rejects a generated animation that exceeds maxFrames", async () => {
    await expect(
      renderReductionGif("(+ 10 (* 25 2))", {
        width: 96,
        framesPerStep: 1,
        maxFrames: 1,
      }),
    ).rejects.toThrow("frames exceed maxFrames");
  });

  it("rejects a generated animation that exceeds the raster budget", async () => {
    await expect(
      renderReductionGif("(+ 1 2)", {
        view: "graph",
        width: 4096,
      }),
    ).rejects.toThrow("raster pixels exceed");
  });

  it("renders small arithmetic programs across varied integer inputs", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -100, max: 100 }),
        fc.integer({ min: -100, max: 100 }),
        async (a, b) => {
          const bytes = await renderReductionGif(`(+ ${a} ${b})`, {
            width: 96,
            framesPerStep: 1,
            maxFrames: 3,
          });
          const metadata = await gifMetadata(bytes);
          expect(metadata.format).toBe("gif");
          expect(metadata.pages).toBe(2);
        },
      ),
      { numRuns: 12 },
    );
  });
});
