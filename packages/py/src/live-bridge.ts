// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// Test-only helper: build a pythonia bridge for the PY_LIVE / HYPERON_LIVE suites. Not part of the
// package build (tsup bundles only index.ts) and never published (package `files` is dist only), so
// the pythonia dynamic import stays confined to test runs.
import { pythoniaBridge, type PythoniaLike } from "./py-pythonia";
import type { PyBridge } from "./py";

/** Import pythonia and wrap its `python` export in a bridge. Call once per live suite in `beforeAll`. */
export async function makePythoniaBridge(): Promise<PyBridge> {
  const { python } = (await import("pythonia")) as unknown as { python: PythoniaLike };
  return pythoniaBridge(python);
}
