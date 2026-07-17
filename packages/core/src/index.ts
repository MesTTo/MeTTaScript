// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// @metta-ts/core: a pure-TypeScript MeTTa (Hyperon) interpreter.
export * from "./atom";
export * from "./number";
export * from "./tabling";
export * from "./compile";
export * from "./cleanup-fault";
export * from "./wcojoin";
export * from "./bindings";
export * from "./substitution";
export * from "./unify";
export * from "./match";
export * from "./instantiate";
export * from "./alpha";
export * from "./tokenizer";
export * from "./parser";
export * from "./standard-syntax";
export * from "./space";
export * from "./builtins";
export * from "./eval";
export * from "./effect-journal";
export * from "./search-cursor";
export * from "./grounded-v2";
export * from "./runner";
export * from "./host";
export * from "./extensions";
export * from "./revision-collection";
export * from "./stdlib";
export * from "./flat-kb";
export * from "./flat-atomspace";
export * from "./flat-william";
export * from "./table-space";
export * from "./worker-protocol";
export { Trail, unifyTrail } from "./trail";
// Static analyzer (diagnostics): source-anchored checks and rustc-style rendering, off the eval path.
export * from "./diagnostic";
export * from "./fuzzy";
export * from "./cst";
export * from "./diagnose";
export * from "./render";
