// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// @metta-ts/hyperon: TypeScript class API over the @metta-ts/core MeTTa interpreter, modeled on
// Hyperon's `hyperon.atoms` and `hyperon.base`. It wraps immutable core atoms in classes. Python method
// aliases sit beside idiomatic names for ported Hyperon code.
export {
  Atom,
  SymbolAtom,
  VariableAtom,
  ExpressionAtom,
  GroundedAtom,
  GroundedObject,
  ValueObject,
  MatchableObject,
  OperationObject,
  AtomType,
  S,
  V,
  E,
  G,
  ValueAtom,
  OperationAtom,
  groundToJs,
  friendlyTypeName,
  clearGroundedObjects,
  atomIsError,
  atomsAreEquivalent,
  type MetaType,
} from "./atoms";
export { Bindings, BindingsSet } from "./bindings";
export {
  SpaceRef,
  GroundingSpace,
  Tokenizer,
  SExprParser,
  MeTTa,
  IncorrectArgumentError,
  standardTokenizer,
  asyncOperationReturnToReduceResult,
  type AsyncOperationEffect,
  type AsyncOperationResult,
  type AsyncOperationReturn,
} from "./base";
export { registerJsonModule, SpaceValue } from "./modules/json";
// The kernel's Space interface and its versioned backend, so a host can serve a named space from one
// without reaching past this package.
export { type Space, PersistentSpace, type SpaceVersion } from "@mettascript/core";
export { registerCatalogModule, ModuleCatalog } from "./modules/catalog";
export { registerJsInterop, JsValue, atomToJs, jsToAtom } from "./modules/js";
