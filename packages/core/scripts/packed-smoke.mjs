// Packed cross-entry smoke test for the Grounded V2 registration identity.
//
//   pnpm --filter @metta-ts/core build && pnpm --filter @metta-ts/core test:packed
//
// Packs the built package, installs the tarball into a scratch project, and proves that a V2
// adapter created through the `@metta-ts/core/runtime` subpath carries the same registration
// identity seen by the root entry, the host composition entry, and the evaluator. A build that
// bundles `grounded-v2` separately per entry duplicates the module-local registration store, and
// this script fails on exactly that defect.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "metta-core-packed-"));

const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, stdio: ["ignore", "pipe", "inherit"] })
    .toString()
    .trim();

try {
  const tarball = join(
    scratch,
    run("pnpm", ["pack", "--pack-destination", scratch], packageDir)
      .split("\n")
      .pop()
      .trim()
      .split("/")
      .pop(),
  );
  writeFileSync(
    join(scratch, "package.json"),
    JSON.stringify({ name: "packed-smoke", private: true, type: "module" }, null, 2),
  );
  run("npm", ["install", "--no-audit", "--no-fund", tarball], scratch);

  writeFileSync(
    join(scratch, "smoke.mjs"),
    `
import {
  groundedSyncAnswers,
  groundedV2SyncAdapter,
  markGroundedV2Registration,
} from "@metta-ts/core/runtime";
import {
  buildEnv,
  gint,
  groundedV2Registration,
  initSt,
  mettaEval,
  parseAll,
  preludeAtoms,
  registerGroundedOperationV2,
  standardTokenizer,
  stdlibAtoms,
  stdTable,
  sym,
} from "@metta-ts/core";
import { composeHostInterops } from "@metta-ts/core/host";

const failures = [];
const check = (label, condition) => {
  if (!condition) failures.push(label);
};

const pureSync = { mode: "sync", effects: { classes: ["pure"], speculative: true } };
const registration = {
  operation: () => ({ tag: "answers", answers: groundedSyncAnswers([{ atom: sym("ok") }]) }),
  options: pureSync,
};

// 1. An adapter created through the runtime subpath is recognized by the root entry.
const runtimeAdapter = groundedV2SyncAdapter(registration);
check("root entry sees runtime-created adapter", groundedV2Registration(runtimeAdapter) !== undefined);

// 2. A mark applied through the runtime subpath is recognized by the host composition entry.
const hostImport = markGroundedV2Registration(
  (space, file, context) => runtimeAdapter([space, file], context),
  registration,
);
const composed = composeHostInterops([
  { name: "left", hostImport },
  { name: "right", hostImport },
]);
check(
  "host entry composes runtime-marked imports at the V2 boundary",
  composed.hostImport !== undefined && groundedV2Registration(composed.hostImport) !== undefined,
);

// 3. The evaluator streams a runtime-marked operation: once over a large producer performs one
//    pull instead of collecting the bag a duplicated registration store would force.
let produced = 0;
const env = buildEnv([...preludeAtoms(), ...stdlibAtoms()], stdTable());
registerGroundedOperationV2(
  env,
  "packed-stream",
  () => ({
    tag: "answers",
    answers: groundedSyncAnswers(
      (function* () {
        for (let index = 0; index < 4096; index += 1) {
          produced += 1;
          yield { atom: gint(index) };
        }
      })(),
    ),
  }),
  pureSync,
);
const program = parseAll("(once (packed-stream))", standardTokenizer())[0].atom;
const [pairs] = mettaEval(env, 1_000_000, initSt(), [], program);
check("once returns the first streamed answer", pairs.length === 1);
check(\`once pulls one answer, not the bag (produced \${produced})\`, produced === 1);

if (failures.length > 0) {
  console.error("packed smoke FAILED:");
  for (const failure of failures) console.error(\`  - \${failure}\`);
  process.exit(1);
}
console.log("packed cross-entry V2 identity smoke passed");
`,
  );
  run("node", ["smoke.mjs"], scratch);
  console.log("packed smoke passed");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
