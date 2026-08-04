// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Types for `gifenc`, which ships none of its own.
//
// `exportReductionGif` and `reductionGif` take the encoder as an argument rather than importing it, so the
// package stays dependency-free and a page that never renders a GIF never loads one. The cost is that
// `await import("gifenc")` is an implicit `any` in a strict project, and `noImplicitAny` rejects it.
//
// This declaration is opt-in rather than part of the package's normal types, because a library that
// declares a module it does not own imposes that shape on every consumer, including one who has their own.
// Reach for it either way round:
//
//     /// <reference types="@mettascript/grapher/gifenc-types" />
//
// or by naming it in tsconfig.json:
//
//     { "compilerOptions": { "types": ["@mettascript/grapher/gifenc-types"] } }
//
// It is written against `GifEncoderLib`, the same type the encoder argument is declared with, so what you
// import is exactly what the call accepts.

declare module "gifenc" {
  type Encoder = import("./dist/index").GifEncoderLib;

  export const GIFEncoder: Encoder["GIFEncoder"];
  export const quantize: Encoder["quantize"];
  export const applyPalette: Encoder["applyPalette"];

  const gifenc: Encoder;
  export default gifenc;
}
