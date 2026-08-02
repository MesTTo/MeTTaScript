// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// TS-native MeTTa extensions, not part of upstream MeTTa, packaged as importable built-in modules.
// They stay out of the vendored, spec-conformant prelude so the 270/270 Hyperon oracle runs against a
// pristine baseline; a program opts in with `(import! &self concurrency)`. Importing a module brings
// its type signatures into scope (see `registerImportedTypes` in eval.ts), which is what makes the
// type-directed argument handling work, e.g. `transaction`'s body is typed `Atom`, so it reaches the
// transaction instruction unevaluated and is evaluated under snapshot/rollback.
import type { Atom } from "./atom";
import type { ImportMap } from "./eval";
import { parseAll } from "./parser";
import { standardTokenizer } from "./runner";

/** The `concurrency` module: timing/concurrency extensions (transaction, and later par/race/mutex). */
export const CONCURRENCY_MODULE_SRC = `
  (: transaction (-> Atom %Undefined%))
`;

/** The `json` module: JSON encode/decode plus dict-space query helpers. */
export const JSON_MODULE_SRC = `
  (: dict-space (-> Expression Grounded))
  (: json-encode (-> Atom String))
  (: json-decode (-> String Atom))
  (: get-keys (-> Grounded Atom))
  (: get-value (-> Grounded Atom %Undefined%))

  (@doc get-value
    (@desc "Function takes space and key as input, checks if space contains key-value pairs in form of (key value) and returns value tied to the input key")
    (@params (
      (@param "Space")
      (@param "Key")))
    (@return "Value which tied to input key, empty if no such key in space"))
  (= (get-value $dictspace $key) (unify $dictspace ($key $value) $value (empty)))

  (@doc get-keys
    (@desc "Function takes space and returns all keys from (<key> <value>) tuples in space")
    (@params (
      (@param "Space")))
    (@return "All keys in the input space"))
  (= (get-keys $dictspace)
     (function
       (chain (unify $dictspace ($key $value) $key Empty) $t (return $t)) ))

  (@doc dict-space
    (@desc "Function takes key-value pairs in form of expression as input, creates space and adds key-value pairs into it")
    (@params (
      (@param "Expression")))
    (@return "Space"))

  (@doc json-encode
    (@desc "Function takes atom as an input and encodes it to json-string. Atom could be a string, number, expression, space and combination of those")
    (@params (
      (@param "Input atom")))
    (@return "Json string"))

  (@doc json-decode
    (@desc "Function takes json string as an input and decodes it to the metta objects (list to expression, dictionary to space which will contain key-value pairs in form of (key value), string to string, number to number)")
    (@params (
      (@param "Json string")))
    (@return "Metta object"))
`;

const NATIVE_MODULE_NAMES = new Set(["concurrency", "json", "catalog", "fileio", "git", "random"]);
const moduleCache: ImportMap = new Map();
const registry = new Map<string, string>();

/** Register a built-in module source resolvable via `(import! &self <name>)`. Reserved native names cannot be shadowed. */
export function registerBuiltinModule(name: string, src: string): void {
  if (NATIVE_MODULE_NAMES.has(name)) throw new Error(`built-in module name is reserved: ${name}`);
  registry.set(name, src);
  moduleCache.clear();
}

/** The `random` module: Hyperon's random-number interface. The operations are grounded (in builtins.ts);
 *  this source supplies their type signatures and documentation, so the Hyperon program shape
 *  `!(import! &self random)` resolves here exactly as it does upstream. */
export const RANDOM_MODULE_SRC = `
  (: random-int (-> Number Number Number))
  (: random-float (-> Number Number Number))

  (@doc random-int
    (@desc "A uniformly random integer in the half-open range [from, to); (Error ... RangeIsEmpty) when the range is empty")
    (@params ((@param "Lower bound, inclusive") (@param "Upper bound, exclusive")))
    (@return "A random integer in the range"))

  (@doc random-float
    (@desc "A uniformly random float in the half-open range [from, to); (Error ... RangeIsEmpty) when the range is empty")
    (@params ((@param "Lower bound, inclusive") (@param "Upper bound, exclusive")))
    (@return "A random float in the range"))
`;

/** The `catalog` module: module-catalog management (list/update/clear), mirroring hyperon-experimental.
 *  The operations are grounded (in builtins.ts) over a minimal in-memory catalog; this source supplies
 *  their type signatures and documentation. */
export const CATALOG_MODULE_SRC = `
  (: catalog-list! (-> Symbol (->)))
  (: catalog-update! (-> Symbol (->)))
  (: catalog-clear! (-> Symbol (->)))

  (@doc catalog-list!
    (@desc "Lists the contents of all module catalogs that support the list method")
    (@params ((@param "Name of the catalog to list, or all to list every available catalog")))
    (@return "Unit atom"))
  (@doc catalog-update!
    (@desc "Updates the contents of all managed catalogs to the latest version of all modules")
    (@params ((@param "Name of the catalog to update, or all to update every catalog")))
    (@return "Unit atom"))
  (@doc catalog-clear!
    (@desc "Clears the contents of all managed catalogs")
    (@params ((@param "Name of the catalog to clear, or all to clear every catalog")))
    (@return "Unit atom"))
`;

/** The `fileio` module: opt-in host file IO for Node-like hosts. */
export const FILEIO_MODULE_SRC = `
  (: FileHandle Type)
  (: file-open! (-> String String FileHandle))
  (: file-close! (-> FileHandle (->)))
  (: file-read-to-string! (-> FileHandle String))
  (: file-read-exact! (-> FileHandle Number String))
  (: file-write! (-> FileHandle String (->)))
  (: file-seek! (-> FileHandle Number (->)))
  (: file-get-size! (-> FileHandle Number))

  (@doc file-open!
    (@desc "Function takes path to the file and open options r, w, c, a, t, both in form of string, creates filehandle and returns it")
    (@params (
      (@param "Filepath string atom")
      (@param "Open options string atom: r read, w write, c create if missing, a append to file, t truncate file")))
    (@return "Filehandle or error if combination of path and open options is wrong, for example file does not exist and no c option, or rc option provided since c demands w"))

  (@doc file-read-to-string!
    (@desc "Function takes filehandle provided by file-open! reads its content from current cursor place till the end of file and returns content in form of string.")
    (@params (
      (@param "Filehandle")))
    (@return "File's content"))

  (@doc file-close!
    (@desc "Closes a filehandle immediately. Dropped filehandles are also closed automatically.")
    (@params (
      (@param "Filehandle")))
    (@return "Unit atom"))

  (@doc file-write!
    (@desc "Function takes filehandle provided by file-open!, content to be written string atom and puts content into file associated with filehandle")
    (@params (
      (@param "Filehandle")
      (@param "Content string atom")))
    (@return "Unit atom"))

  (@doc file-seek!
    (@desc "Function takes filehandle provided by file-open! and desired cursor position number and sets cursor to provided position")
    (@params (
      (@param "Filehandle")
      (@param "Desired cursor position number")))
    (@return "Unit atom"))

  (@doc file-read-exact!
    (@desc "Function takes filehandle provided by file-open! and desired number of bytes to read number, reads content of file from current cursor position and returns it in form of string")
    (@params (
      (@param "Filehandle")
      (@param "Number of bytes to read")))
    (@return "File's content"))

  (@doc file-get-size!
    (@desc "Function takes filehandle provided by file-open! and returns size of file")
    (@params (
      (@param "Filehandle")))
    (@return "Size of file"))
`;

/** The `git` module: opt-in host git imports for Node-like hosts. */
export const GIT_MODULE_SRC = `
  (: GitImportOp Type)
  (: git-import! (-> String (->)))
  (: git-import! GitImportOp)

  (@doc git-import!
    (@desc "Clones a git repository shallowly into the repos directory if it is not already present")
    (@params (
      (@param "Git repository URL or local path")))
    (@return "Unit atom, or Error atom if the host git capability is unavailable or cloning fails"))
`;

function parseModule(src: string): Atom[] {
  return parseAll(src, standardTokenizer())
    .filter((t) => !t.bang)
    .map((t) => t.atom);
}

/** The built-in extension modules, by the name used in `(import! &self <name>)`. */
export function builtinModules(): ImportMap {
  if (moduleCache.size === 0) {
    moduleCache.set("concurrency", parseModule(CONCURRENCY_MODULE_SRC));
    moduleCache.set("json", parseModule(JSON_MODULE_SRC));
    moduleCache.set("catalog", parseModule(CATALOG_MODULE_SRC));
    moduleCache.set("random", parseModule(RANDOM_MODULE_SRC));
    moduleCache.set("fileio", parseModule(FILEIO_MODULE_SRC));
    moduleCache.set("git", parseModule(GIT_MODULE_SRC));
    for (const [name, src] of registry) {
      moduleCache.set(name, parseModule(src));
    }
    // The PeTTa-convention spelling of a registered library resolves to the same module identity, so a
    // program may import either name (or both: the shared id deduplicates the load).
    for (const [name] of registry) {
      const alias = "lib_" + name;
      if (moduleCache.has(alias)) continue;
      moduleCache.set(alias, { id: name, defs: moduleCache.get(name) as Atom[], imports: [] });
    }
  }
  return moduleCache;
}

/** A fresh imports map seeded with the built-in extension modules, optionally merged with caller
 *  imports. Built-ins are only applied when a program actually `(import! ...)`s them, so this never
 *  affects the Hyperon oracle baseline. Built-in module names are reserved: a caller-supplied module of
 *  the same name does NOT override the built-in. */
export function withBuiltinModules(extra?: ImportMap): ImportMap {
  const out: ImportMap = new Map(builtinModules());
  if (extra) for (const [k, v] of extra) if (!out.has(k)) out.set(k, v);
  return out;
}
