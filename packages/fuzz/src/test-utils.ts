// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import { format, runProgram } from "@mettascript/core";

export const printedWithFuzz = (body: string): string[][] =>
  runProgram(`!(import! &self fuzz)\n${body}`, 10_000_000).map((query) =>
    query.results.map(format),
  );
