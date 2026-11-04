// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Purpose: the public entry of @mettascript/petta: HostedPetta, PeTTa's own source run on the TypeScript Prolog
// machine, with the machine, its Prolog reader and the term printers.
// am[implements a-pe-host-petta-src]

export { HostedPetta, type HostedOptions } from "./hosted";
export { swrite, writeTerm } from "./writer";
export { Machine } from "./machine";
export { readClauses, PrologReader } from "./prolog-reader";
export * from "./terms";
