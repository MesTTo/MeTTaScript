// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: the public entry of @mettascript/petta: the PeTTa-semantics engine, its reader and printer.
// am[implements a-petta-engine]

export { Petta, type PettaOptions } from "./engine";
export { sread, topForms } from "./metta-reader";
export { swrite, writeTerm } from "./writer";
export { Machine } from "./machine";
export { readClauses, PrologReader } from "./prolog-reader";
export * from "./terms";
