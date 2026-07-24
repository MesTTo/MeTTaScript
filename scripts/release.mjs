// SPDX-FileCopyrightText: 2026 MesTTo
// SPDX-License-Identifier: MIT

// Bump every publishable package to a new version in lockstep. A MeTTaScript release versions all of
// packages/* and compat/* together; their inter-package and shim dependencies use pnpm `workspace:*`,
// which `pnpm publish` rewrites to the exact version, so only each package's own `version` field changes
// here. The private root package carries no version and is left untouched.
//
// Usage:
//   node scripts/release.mjs 2.5.1          set an explicit version
//   node scripts/release.mjs patch          bump the shared patch version (also: minor, major)
//   npm run release -- patch                same, via the package script
//
// After bumping: add the RELEASE_NOTES.md section, commit as "MeTTaScript <version>", tag `v<version>`,
// and push the commit and tag. `.github/workflows/release.yml` builds and publishes on the pushed `v*` tag.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every publishable package.json under packages/* and compat/*. */
function packageManifests() {
  return ["packages", "compat"].flatMap((base) => {
    const dir = join(root, base);
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name, "package.json"))
      .filter(existsSync);
  });
}

/** The target version for an explicit `x.y.z` (optionally with a prerelease suffix) or a semver bump keyword. */
function nextVersion(current, spec) {
  if (/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(spec)) return spec;
  const [major, minor, patch] = current.split(".").map((n) => Number.parseInt(n, 10));
  if (spec === "major") return `${major + 1}.0.0`;
  if (spec === "minor") return `${major}.${minor + 1}.0`;
  if (spec === "patch") return `${major}.${minor}.${patch + 1}`;
  return undefined;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const spec = process.argv[2];
if (spec === undefined) fail("usage: node scripts/release.mjs <version | patch | minor | major>");

const manifests = packageManifests();
if (manifests.length === 0) fail("no publishable packages found under packages/ or compat/");

const current = new Set(manifests.map((file) => JSON.parse(readFileSync(file, "utf8")).version));
if (current.size !== 1)
  fail(`packages are not in lockstep, refusing to bump: ${[...current].sort().join(", ")}`);
const from = [...current][0];

const to = nextVersion(from, spec);
if (to === undefined) fail(`not a version or a patch/minor/major bump: ${spec}`);
if (to === from) fail(`already at ${to}`);

for (const file of manifests) {
  const text = readFileSync(file, "utf8");
  // Replace only the package's own top-level version field. `workspace:*` dependencies carry no literal
  // version, so this string is unambiguous and formatting (indentation, key order) is preserved.
  const bumped = text.replace(/"version":\s*"[^"]+"/, `"version": "${to}"`);
  if (bumped === text) fail(`no version field in ${file}`);
  writeFileSync(file, bumped);
}

console.log(`bumped ${manifests.length} packages: ${from} -> ${to}`);
console.log(`next: update RELEASE_NOTES.md, commit "MeTTaScript ${to}", tag v${to}, push commit + tag`);
