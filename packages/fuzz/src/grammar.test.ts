// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

import "./index.js";
import { describe, expect, it } from "vitest";
import { printedWithFuzz as printed } from "./test-utils.js";

function sampleValue(result: string): string {
  const match = /^\(FuzzSample ([^ ]+)/.exec(result);
  if (match === null) throw new Error(`expected a FuzzSample: ${result}`);
  return match[1]!;
}

// Splits "(Head item ...)" into its balanced top-level items, string-aware.
function topLevelItems(expression: string): string[] {
  if (!expression.startsWith("(") || !expression.endsWith(")"))
    throw new Error(`expected a parenthesized expression: ${expression}`);
  const inner = expression.slice(1, -1);
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  let inString = false;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]!;
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === " " && depth === 0) {
      if (i > start) items.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  if (depth !== 0) throw new Error(`unbalanced expression: ${expression}`);
  if (start < inner.length) items.push(inner.slice(start));
  return items;
}

function sampleTree(result: string): string {
  const items = topLevelItems(result);
  if (items[0] !== "FuzzSample" || items.length !== 4)
    throw new Error(`expected a FuzzSample: ${result}`);
  return items[3]!;
}

describe("MeTTa grammar and type-directed generators", () => {
  it("treats grammar templates and type constructors as syntax data", () => {
    const out = printed(`
      !(bind! &grammar-counter (new-state 0))
      (= (Ctor $x)
         (let $seen (get-state &grammar-counter)
           (let $changed
                (change-state! &grammar-counter (+ $seen 1))
             (reduced $x))))
      (FuzzGrammar SyntaxData
        (Productions
          ((Production 1 SyntaxData (Ctor leaf)))))
      !(get-state &grammar-counter)
      !(gen-grammar SyntaxData)
      !(get-state &grammar-counter)
      !(fuzz-generate-edge
         (gen-grammar SyntaxData)
         0
         0)
      !(get-state &grammar-counter)
      (FuzzGrammar LiteralSyntaxData
        (Productions
          ((Production 1 LiteralSyntaxData
             (Literal (Ctor leaf))))))
      !(gen-grammar LiteralSyntaxData)
      !(get-state &grammar-counter)
      (= (FuzzTypeSchema SyntaxType Num)
         (FuzzTypeConstructors
           ((Constructor 1 Num (Ctor leaf)))))
      !(gen-well-typed SyntaxType Num)
      !(get-state &grammar-counter)
      !(fuzz-generate-edge
         (gen-well-typed SyntaxType Num)
         0
         0)
      !(get-state &grammar-counter)
    `);

    expect(out[2]).toEqual(["0"]);
    expect(out[3]![0]).toContain("(GrammarProduction 0 1 (quote SyntaxData) (quote (Ctor leaf)))");
    expect(out[4]).toEqual(["0"]);
    expect(out[5]![0]).toMatch(/^\(FuzzSample \(Ctor leaf\) /);
    expect(out[6]).toEqual(["0"]);
    expect(out[7]![0]).toContain(
      "(GrammarProduction 0 1 (quote LiteralSyntaxData) (quote (Literal (Ctor leaf))))",
    );
    expect(out[8]).toEqual(["0"]);
    expect(out[9]![0]).toContain("(GrammarProduction 0 1 (quote Num) (quote (Ctor leaf)))");
    expect(out[10]).toEqual(["0"]);
    expect(out[11]![0]).toMatch(/^\(FuzzSample \(Ctor leaf\) /);
    expect(out[12]).toEqual(["0"]);
  });

  it("treats nonterminal names and type terms as syntax data", () => {
    const out = printed(`
      !(bind! &target-counter (new-state 0))
      (= (NT $x)
         (let $seen (get-state &target-counter)
           (let $changed
                (change-state! &target-counter (+ $seen 1))
             (ReducedNT $x))))
      (FuzzGrammar TargetSyntax
        (Productions
          ((Production 1 (NT A) (Ref (NT B)))
           (Production 1 (NT B) leaf))))
      !(get-state &target-counter)
      !(gen-grammar-root TargetSyntax (NT A))
      !(get-state &target-counter)
      !(fuzz-generate-edge
         (gen-grammar-root TargetSyntax (NT A))
         0
         1)
      !(get-state &target-counter)
      !(bind! &type-counter (new-state 0))
      (= (Ty $x)
         (let $seen (get-state &type-counter)
           (let $changed
                (change-state! &type-counter (+ $seen 1))
             (ReducedTy $x))))
      (= (FuzzTypeSchema TypeSyntax (Ty A))
         (FuzzTypeConstructors
           ((Constructor 1 (Ty A) typed))))
      !(gen-well-typed TypeSyntax (Ty A))
      !(get-state &type-counter)
      !(fuzz-generate-edge
         (gen-well-typed TypeSyntax (Ty A))
         0
         0)
      !(get-state &type-counter)
      (= (FuzzTypeSchema WrongType Num)
         (FuzzTypeConstructors
           ((Constructor 1 (Ty B) nope))))
      !(gen-well-typed WrongType Num)
      !(get-state &type-counter)
      !(gen-grammar-root TargetSyntax $open-root)
      !(gen-well-typed TypeSyntax $open-type)
      (= (FuzzTypeSchema OpenResult Num)
         (FuzzTypeConstructors
           ((Constructor 1 $open-result nope))))
      !(gen-well-typed OpenResult Num)
    `);

    expect(out[2]).toEqual(["0"]);
    expect(out[3]![0]).toContain(
      "(GrammarProduction 0 1 (quote (NT A)) (quote (_FuzzGrammarRef (NT B) 0 1)))",
    );
    expect(out[4]).toEqual(["0"]);
    expect(out[5]![0]).toMatch(/^\(FuzzSample leaf /);
    expect(out[6]).toEqual(["0"]);
    expect(out[8]![0]).toContain("(GrammarProduction 0 1 (quote (Ty A)) (quote typed))");
    expect(out[9]).toEqual(["0"]);
    expect(out[10]![0]).toMatch(/^\(FuzzSample typed /);
    expect(out[10]![0]).toContain("(Target (quote (Ty A)))");
    expect(out[11]).toEqual(["0"]);
    expect(out[12]).toEqual([
      "(FuzzGenerationError TypeConstructorResultMismatch (Details (Schema WrongType) (RequestedType (quote Num)) (ConstructorType (quote (Ty B))) (ConstructorIndex 0)))",
    ]);
    expect(out[13]).toEqual(["0"]);
    expect(out[14]![0]).toContain("NonGroundGrammarRoot");
    expect(out[15]![0]).toContain("NonGroundTypeSchemaRequest");
    expect(out[16]![0]).toContain("NonGroundTypeConstructorResult");
  });

  it("preserves reducible scope metadata as syntax data", () => {
    const out = printed(`
      !(bind! &scope-counter (new-state 0))
      (= (SortCtor $x)
         (let $seen (get-state &scope-counter)
           (let $changed
                (change-state! &scope-counter (+ $seen 1))
             (reduced $x))))
      (FuzzGrammar SortGrammar
        (Productions
          ((Production 1 SortGrammar
             (Scoped
               ((Binding (SortCtor Name) 0))
               (Use (SortCtor Name)))))))
      !(gen-grammar SortGrammar)
      !(get-state &scope-counter)
      !(fuzz-generate-edge
         (gen-grammar SortGrammar)
         0
         0)
      !(get-state &scope-counter)
    `);

    expect(out[2]![0]).toContain("(Binding (SortCtor Name) 0)");
    expect(out[3]).toEqual(["0"]);
    expect(out[4]![0]).toMatch(/^\(FuzzSample \$fuzz-0 /);
    expect(out[4]![0]).toContain("(Sort (quote (SortCtor Name)))");
    expect(out[4]![0]).not.toContain("(reduced Name)");
    expect(out[5]).toEqual(["0"]);
  });

  it("collapses and freezes every Field descriptor exactly once", () => {
    const out = printed(`
      (= (ambiguous-field) (gen-int 0 1))
      (= (ambiguous-field) (gen-bool))
      (FuzzGrammar AmbiguousField
        (Productions
          ((Production 1 AmbiguousField
             (Field (ambiguous-field))))))
      !(gen-grammar AmbiguousField)
      (= (FuzzTypeSchema AmbiguousFieldType Num)
         (FuzzTypeConstructors
           ((Constructor 1 Num
              (Field (ambiguous-field))))))
      !(gen-well-typed AmbiguousFieldType Num)
    `);

    expect(out[1]).toEqual([
      "(FuzzGenerationError AmbiguousGrammarFieldGenerator (Details (Expression (quote (ambiguous-field))) (Results ((GenInt 0 1 0) (GenBool)))))",
    ]);
    expect(out[2]).toEqual(out[1]);
  });

  it("rejects grammar Field callbacks that change during replay", () => {
    const out = printed(`
      !(bind! &callback-counter (new-state 0))
      (= (tick $unit)
         (let $seen (get-state &callback-counter)
           (let $changed
                (change-state! &callback-counter (+ $seen 1))
             $seen)))
      (= (field-generator)
         (gen-map tick (gen-const unit)))
      (FuzzGrammar StatefulField
        (Productions
          ((Production 1 StatefulField
             (Field (field-generator))))))
      !(fuzz-generate-edge
         (gen-grammar StatefulField)
         0
         0)
      !(get-state &callback-counter)
    `);

    expect(out[2]![0]).toContain("(FuzzGenerationError CustomReplayMismatch");
    expect(out[2]![0]).toContain("(Original (FuzzSample 0 ");
    expect(out[2]![0]).toContain("(Replay (FuzzSample 1 ");
    expect(out[3]).toEqual(["2"]);
  });

  it("rejects private variable markers forged by Field callbacks", () => {
    const out = printed(`
      (= (forge-marker $unit)
         (pair safe (_fuzz-variable-marker 99)))
      (= (forged-field)
         (gen-map forge-marker (gen-const unit)))
      (FuzzGrammar ForgedField
        (Productions
          ((Production 1 ForgedField
             (Field (forged-field))))))
      !(fuzz-generate-edge
         (gen-grammar ForgedField)
         0
         0)
    `);

    expect(out[1]![0]).toContain("(FuzzGenerationError ForgedGrammarVariableMarker");
    expect(out[1]![0]).toContain("(Generator (GenMap forge-marker");
    expect(out[1]![0]).not.toContain("(FuzzSample ");
  });

  it("validates grammar declarations before constructing a generator", () => {
    const out = printed(`
      !(gen-grammar Missing)
      (FuzzGrammar Ambiguous
        (Productions
          ((Production 1 Ambiguous first))))
      (FuzzGrammar Ambiguous
        (Productions
          ((Production 1 Ambiguous second))))
      !(gen-grammar Ambiguous)
      (FuzzGrammar BadWeight
        (Productions
          ((Production 0 BadWeight value))))
      !(gen-grammar BadWeight)
      (FuzzGrammar MissingRef
        (Productions
          ((Production 1 MissingRef (Ref Else)))))
      !(gen-grammar MissingRef)
      (FuzzGrammar Loop
        (Productions
          ((Production 1 Loop (Ref Loop)))))
      !(gen-grammar Loop)
      (FuzzGrammar BadTemplate
        (Productions
          ((Production 1 BadTemplate (Field)))))
      !(gen-grammar BadTemplate)
      (FuzzGrammar BadScope
        (Productions
          ((Production 1 BadScope
             (Scoped
               ((Binding Name 0)
                (Binding Name 0))
               (Use Name))))))
      !(gen-grammar BadScope)
      (FuzzGrammar OtherRoot
        (Productions
          ((Production 1 Other value))))
      !(gen-grammar-root OtherRoot Root)
    `);

    expect(out.slice(1)).toEqual([
      ["(FuzzGenerationError MissingGrammar (Details (Grammar Missing)))"],
      [
        "(FuzzGenerationError AmbiguousGrammar (Details (Grammar Ambiguous) (Results ((quote ((Production 1 Ambiguous first))) (quote ((Production 1 Ambiguous second)))))))",
      ],
      [
        "(FuzzGenerationError InvalidGrammarProductionWeight (Details (Grammar BadWeight) (ProductionIndex 0) (Weight 0)))",
      ],
      [
        "(FuzzGenerationError MissingGrammarNonterminal (Details (Grammar MissingRef) (Nonterminal (quote Else))))",
      ],
      [
        "(FuzzGenerationError UnproductiveGrammarNonterminal (Details (Grammar Loop) (Nonterminal (quote Loop))))",
      ],
      [
        "(FuzzGenerationError MalformedGrammarTemplate (Details (Grammar BadTemplate) (Template (quote (Field)))))",
      ],
      ["(FuzzGenerationError DuplicateGrammarBindingId (Details (BindingId 0)))"],
      [
        "(FuzzGenerationError MissingGrammarRoot (Details (Grammar OtherRoot) (Root (quote Root))))",
      ],
    ]);
  });

  it("checks productivity with lexical binder requirements", () => {
    const out = printed(`
      (FuzzGrammar LexicalLoop
        (Productions
          ((Production 1 LexicalLoop (Ref LexicalLoop))
           (Production 1 LexicalLoop (Use Name)))))
      !(gen-grammar LexicalLoop)
      (FuzzGrammar BoundBody
        (Productions
          ((Production 1 Root
             (lambda (Bind Name (Ref Body))))
           (Production 1 Body (Use Type))
           (Production 1 Body (Use Name)))))
      !(gen-grammar-root BoundBody Root)
      !(fuzz-generate-edge
         (gen-grammar-root BoundBody Root)
         0
         1)
    `);

    expect(out[1]).toEqual([
      "(FuzzGenerationError UnproductiveGrammarNonterminal (Details (Grammar LexicalLoop) (Nonterminal (quote LexicalLoop))))",
    ]);
    expect(out[2]![0]).toContain("(GrammarRequest");
    expect(out[3]![0]).toMatch(/^\(FuzzSample \(lambda \(\$fuzz-0 \$fuzz-0\)\) /);
  });

  it("normalizes multiple scoped bindings before recursive validation", () => {
    const out = printed(`
      (FuzzGrammar MultiScope
        (Productions
          ((Production 1 MultiScope
             (Scoped
               ((Binding Name 0)
                (Binding Type 1))
               (pair (Use Name) (Use Type)))))))
      !(_fuzz-validate-grammar-bindings
         ((Binding Name 0)
          (Binding Type 1)))
      !(gen-grammar MultiScope)
      !(fuzz-generate-edge
         (gen-grammar MultiScope)
         0
         0)
    `);

    expect(out[1]![0]).toContain("(GrammarBinding (quote Name) 0) (GrammarBinding (quote Type) 1)");
    expect(out[2]![0]).toContain("(quote MultiScope) () 2");
    expect(out[3]![0]).toMatch(/^\(FuzzSample \(pair \$fuzz-0 \$fuzz-1\) /);
  });

  it("uses weights only for random selection and keeps one ordered exhaustive branch per production", () => {
    const out = printed(`
      (FuzzGrammar Weighted
        (Productions
          ((Production 9 Weighted heavy)
           (Production 1 Weighted light))))
      !(fuzz-generate
         (gen-grammar Weighted)
         (fuzz-exhaustive-driver-limit 2)
         0)
      !(fuzz-generate-edge (gen-grammar Weighted) 0 0)
      !(fuzz-generate-edge (gen-grammar Weighted) 1 0)
      !(fuzz-generate-bytes (gen-grammar Weighted) (0) 0)
      !(fuzz-generate-bytes (gen-grammar Weighted) (1) 0)
      !(_fuzz-grammar-ticket-index
         ((GrammarProduction 0 9 (quote Weighted) (quote heavy))
          (GrammarProduction 1 1 (quote Weighted) (quote light)))
         1
         0)
      !(_fuzz-grammar-ticket-index
         ((GrammarProduction 0 9 (quote Weighted) (quote heavy))
          (GrammarProduction 1 1 (quote Weighted) (quote light)))
         9
         0)
      !(_fuzz-grammar-ticket-index
         ((GrammarProduction 0 9 (quote Weighted) (quote heavy))
          (GrammarProduction 1 1 (quote Weighted) (quote light)))
         10
         0)
    `);

    expect(out[1]!.map(sampleValue)).toEqual(["heavy", "light"]);
    expect(sampleValue(out[2]![0]!)).toBe("heavy");
    expect(sampleValue(out[3]![0]!)).toBe("light");
    expect(sampleValue(out[4]![0]!)).toBe("heavy");
    expect(sampleValue(out[5]![0]!)).toBe("light");
    expect(out.slice(6)).toEqual([["0"], ["0"], ["1"]]);
    for (const result of out.slice(1, 6).flat()) {
      expect(result).toContain("(Decision Int (Bounds 0 1) (Origin 0)");
    }
  });

  it("generates fields and aliases with strict replay identity", () => {
    const out = printed(`
      (FuzzGrammar Arith
        (Productions
          ((Production 1 Arith (Ref Literal))
           (Production 1 Literal
             (Lit (Field (gen-int -2 2)))))))
      !(fuzz-generate-edge (gen-grammar Arith) 0 0)
      !(fuzz-generate-edge (gen-grammar Arith) 0 1)
      !(let $generator (gen-grammar Arith)
         (let $sample
              (fuzz-generate-random $generator 42 1)
           (switch $sample
             (((FuzzSample $value $next $tree)
               (fuzz-replay $generator $tree 1))
              ($bad $bad)))))
    `);

    expect(out[1]![0]).toMatch(
      /^\(FuzzGenerationDiscard \(NoEligibleGrammarProduction \(Target \(quote Arith\)\) \(Size 0\)\)/,
    );
    expect(out[2]![0]).toMatch(/^\(FuzzSample \(Lit 2\) /);
    expect(out[2]![0]).toContain("(Decision GrammarRef (Target (quote Literal))");
    expect(out[3]![0]).toMatch(/^\(FuzzSample \(Lit [-0-9]+\) \(FuzzDriver Replay /);
    expect(out[3]![0]).toContain("(Decision GrammarRef (Target (quote Literal))");
  });

  it("threads binder scope, stable fresh ids, and scope-preserving shrink replay", () => {
    const out = printed(`
      (FuzzGrammar Lambda
        (Productions
          ((Production 1 Expr (Use Name))
           (Production 1 Expr
             (lambda (Bind Name (Ref Expr)))))))
      !(fuzz-generate-edge
         (gen-grammar-root Lambda Expr)
         0
         2)
      !(let $generator (gen-grammar-root Lambda Expr)
         (let $sample
              (fuzz-generate-edge $generator 0 2)
           (switch $sample
             (((FuzzSample $value $next $tree)
               (let $candidate
                    (superpose
                      (_fuzz-shrink-candidates $tree))
                 (_fuzz-shrink-replay
                   $generator
                   $candidate
                   2)))
              ($bad $bad)))))
      (FuzzGrammar ExternalScope
        (Productions
          ((Production 1 ExternalScope
             (Scoped
               ((Binding Name 7))
               (Use Name))))))
      !(fuzz-generate-edge
         (gen-grammar ExternalScope)
         0
         0)
      (FuzzGrammar FreshPair
        (Productions
          ((Production 1 FreshPair
             (pair
               (Fresh Name)
               (Fresh Name))))))
      !(fuzz-generate-edge
         (gen-grammar FreshPair)
         0
         0)
      (FuzzGrammar FreeUse
        (Productions
          ((Production 1 FreeUse (Use Name)))))
      !(fuzz-generate-edge
         (gen-grammar FreeUse)
         0
         0)
      (FuzzGrammar LiteralMarker
        (Productions
          ((Production 1 LiteralMarker
             (Literal (GeneratedVariable 3))))))
      !(fuzz-generate-edge
         (gen-grammar LiteralMarker)
         0
         0)
    `);

    expect(out[1]![0]).toMatch(
      /^\(FuzzSample \(lambda \(\$fuzz-0 \(lambda \(\$fuzz-1 \$fuzz-0\)\)\)\) /,
    );
    expect(out[2]).toHaveLength(2);
    expect(out[2]![0]).toMatch(/^\(FuzzShrinkReplay \(lambda \(\$fuzz-0 \$fuzz-0\)\) /);
    expect(out[2]![1]).toMatch(
      /^\(FuzzShrinkReplay \(lambda \(\$fuzz-0 \(lambda \(\$fuzz-1 \$fuzz-1\)\)\)\) /,
    );
    expect(out[3]![0]).toMatch(/^\(FuzzSample \$fuzz-7 /);
    expect(out[4]![0]).toMatch(/^\(FuzzSample \(pair \$fuzz-0 \$fuzz-1\) /);
    expect(out[5]).toEqual([
      "(FuzzGenerationError UnproductiveGrammarNonterminal (Details (Grammar FreeUse) (Nonterminal (quote FreeUse))))",
    ]);
    expect(out[6]![0]).toMatch(/^\(FuzzSample \(GeneratedVariable 3\) /);
    for (const result of out.slice(1, 6).flat()) expect(result).not.toContain("GeneratedVariable");
  });

  it("returns defined results for deep and wide templates", () => {
    const depth = 1200;
    let deepTemplate = "leaf";
    for (let level = 0; level < depth; level += 1) deepTemplate = `(f ${deepTemplate})`;
    const width = 1500;
    const wideTemplate = `(tuple ${Array.from({ length: width }, (_, index) => `w${index}`).join(
      " ",
    )})`;

    const out = printed(`
      (FuzzGrammar DeepTemplate
        (Productions
          ((Production 1 DeepTemplate ${deepTemplate}))))
      !(gen-grammar DeepTemplate)
      !(fuzz-generate-edge (gen-grammar DeepTemplate) 0 0)
      (FuzzGrammar WideTemplate
        (Productions
          ((Production 1 WideTemplate ${wideTemplate}))))
      !(gen-grammar WideTemplate)
      !(fuzz-generate-edge (gen-grammar WideTemplate) 0 0)
    `);

    expect(out[1]![0]).toContain("(GrammarRequest");
    const deepSample = out[2]![0]!;
    expect(deepSample.startsWith(`(FuzzSample ${deepTemplate} `)).toBe(true);
    expect(out[3]![0]).toContain("(GrammarRequest");
    const wideSample = out[4]![0]!;
    expect(wideSample.startsWith(`(FuzzSample ${wideTemplate} `)).toBe(true);
  }, 120_000);

  it("generates through deep nonterminal reference chains", () => {
    const depth = 600;
    const productions = Array.from({ length: depth }, (_, level) =>
      level === depth - 1
        ? `(Production 1 (T ${level}) bottom)`
        : `(Production 1 (T ${level}) (n ${level} (Ref (T ${level + 1}))))`,
    ).join("\n           ");

    const out = printed(`
      (FuzzGrammar DeepChain
        (Productions
          (${productions})))
      !(gen-grammar-root DeepChain (T 0))
      !(fuzz-generate-edge (gen-grammar-root DeepChain (T 0)) 0 ${depth})
    `);

    expect(out[1]![0]).toContain("(GrammarRequest");
    const sample = out[2]![0]!;
    expect(sample).toMatch(/^\(FuzzSample \(n 0 \(n 1 \(n 2 /);
    expect(topLevelItems(sample)[1]).toContain("bottom");
  }, 120_000);

  it("keeps validation defined under hundreds of open requirement alternatives", () => {
    const alternatives = 400;
    const openUses = Array.from(
      { length: alternatives },
      (_, index) => `(Production 1 Body (Use (S ${index})))`,
    ).join("\n           ");

    const out = printed(`
      (FuzzGrammar ManyAlternatives
        (Productions
          ((Production 1 Root (lambda (Bind (S 0) (Ref Body))))
           ${openUses})))
      !(gen-grammar-root ManyAlternatives Root)
      !(fuzz-generate-edge (gen-grammar-root ManyAlternatives Root) 0 1)
    `);

    expect(out[1]![0]).toContain("(GrammarRequest");
    expect(out[2]![0]).toMatch(/^\(FuzzSample \(lambda \(\$fuzz-0 \$fuzz-0\)\) /);
  }, 120_000);

  it("accepts marker-shaped source syntax and rejects only genuine markers", () => {
    const out = printed(`
      (FuzzGrammar MarkerShapes
        (Productions
          ((Production 1 MarkerShapes
             (shapes
               (Literal (_fuzz-variable-marker 99))
               (Fresh (_fuzz-variable-marker 7))
               (Scoped
                 ((Binding (_fuzz-variable-marker 5) 0))
                 (Use (_fuzz-variable-marker 5)))
               (lambda
                 (Bind (_fuzz-variable-marker 3)
                   (Literal held))))))))
      !(fuzz-generate-edge (gen-grammar MarkerShapes) 0 0)
      (= (marker-const-field)
         (gen-const (_fuzz-variable-marker 42)))
      (FuzzGrammar GenuineMarker
        (Productions
          ((Production 1 GenuineMarker
             (Field (marker-const-field))))))
      !(fuzz-generate-edge (gen-grammar GenuineMarker) 0 0)
    `);

    const shaped = out[1]![0]!;
    expect(shaped).toMatch(
      /^\(FuzzSample \(shapes \(_fuzz-variable-marker 99\) \$fuzz-1 \$fuzz-0 \(lambda \(\$fuzz-2 held\)\)\) /,
    );
    expect(shaped).not.toContain("ForgedGrammarVariableMarker");
    expect(out[2]![0]).toContain("(FuzzGenerationError ForgedGrammarVariableMarker");
    expect(out[2]![0]).not.toContain("(FuzzSample ");
  });

  it("freezes Field generators at construction against later relation changes", () => {
    const out = printed(`
      (= (freezing-field) (gen-int 0 1))
      (FuzzGrammar Freezing
        (Productions
          ((Production 1 Freezing
             (Boxed (Field (freezing-field)))))))
      !(let $generator (gen-grammar Freezing)
         (let $first (fuzz-generate-edge $generator 0 0)
           (let $added
                (add-atom &self (= (freezing-field) (gen-bool)))
             (let $second (fuzz-generate-edge $generator 0 0)
               (Frozen $first $second)))))
      !(gen-grammar Freezing)
    `);

    const frozen = out[1]![0]!;
    const items = topLevelItems(frozen);
    expect(items[0]).toBe("Frozen");
    const first = items[1]!;
    const second = items[2]!;
    expect(first).toMatch(/^\(FuzzSample \(Boxed [01]\) /);
    expect(topLevelItems(second)[1]).toBe(topLevelItems(first)[1]);
    expect(out[2]![0]).toContain("(FuzzGenerationError AmbiguousGrammarFieldGenerator");
  });

  it("rejects trailing, missing, and mutated replay decisions", () => {
    const grammarSource = `
      (FuzzGrammar ReplayMutation
        (Productions
          ((Production 1 ReplayMutation
             (Lit (Field (gen-int 0 3)))))))`;
    const generated = printed(`${grammarSource}
      !(fuzz-generate-edge (gen-grammar ReplayMutation) 0 0)
    `);
    const sample = generated[1]![0]!;
    expect(sample).toMatch(/^\(FuzzSample \(Lit \d+\) /);
    const tree = sampleTree(sample);
    expect(tree).toContain("(Bounds 0 3)");

    const trailing = `(Decision Wrapper () () (${tree} (Decision Int (Bounds 0 3) (Origin 0) (Value 1) ())))`;
    const missing = "(Decision Wrapper () () ())";
    const mutatedBounds = tree.replace("(Bounds 0 3)", "(Bounds 0 5)");
    const valueMatches = [...tree.matchAll(/\(Value (\d+)\)/g)];
    const lastValue = valueMatches[valueMatches.length - 1]!;
    const mutatedValue =
      tree.slice(0, lastValue.index) +
      "(Value 9)" +
      tree.slice(lastValue.index + lastValue[0].length);

    const replayed = printed(`${grammarSource}
      !(fuzz-replay (gen-grammar ReplayMutation) ${tree} 0)
      !(fuzz-replay (gen-grammar ReplayMutation) ${trailing} 0)
      !(fuzz-replay (gen-grammar ReplayMutation) ${missing} 0)
      !(fuzz-replay (gen-grammar ReplayMutation) ${mutatedBounds} 0)
      !(fuzz-replay (gen-grammar ReplayMutation) ${mutatedValue} 0)
    `);

    expect(replayed[1]![0]).toMatch(/^\(FuzzSample \(Lit \d+\) \(FuzzDriver Replay /);
    expect(replayed[2]![0]).toContain("(FuzzGenerationError TrailingReplayDecisions");
    expect(replayed[3]![0]).toContain("(FuzzGenerationError ReplayMismatch");
    expect(replayed[3]![0]).toContain("(Actual EndOfTrace)");
    expect(replayed[4]![0]).toContain("(FuzzGenerationError ReplayMismatch");
    expect(replayed[4]![0]).toContain("(ActualBounds 0 5)");
    expect(replayed[5]![0]).toContain("(FuzzGenerationError ReplayValueOutOfBounds");
  });

  it("keeps generate and replay identical across many seeds", () => {
    const seeds = Array.from({ length: 25 }, (_, seed) => seed).join(" ");
    const out = printed(`
      (FuzzGrammar Rich
        (Productions
          ((Production 2 Expr (Use Name))
           (Production 1 Expr
             (lambda (Bind Name (Ref Expr))))
           (Production 1 Expr
             (lit (Field (gen-int -3 3)))))))
      (= (seed-check $generator $seed)
         (let $sample (fuzz-generate-random $generator $seed 6)
           (switch $sample
             (((FuzzSample $value $next $tree)
               (let $replayed (fuzz-replay $generator $tree 6)
                 (switch $replayed
                   (((FuzzSample $replay-value $replay-next $replay-tree)
                     (SeedCheck $seed (noreduce-eq $value $replay-value)))
                    ($bad (SeedCheck $seed (ReplayFailed $bad)))))))
              ($bad (SeedCheck $seed (GenerateFailed $bad)))))))
      !(let $generator (gen-grammar-root Rich Expr)
         (map-atom (${seeds}) $seed (seed-check $generator $seed)))
    `);

    const expected = `(${Array.from({ length: 25 }, (_, seed) => `(SeedCheck ${seed} True)`).join(
      " ",
    )})`;
    expect(out[1]).toEqual([expected]);
  }, 60_000);

  it("covers purely recursive, finitely recursive, and parametric list schemas", () => {
    const out = printed(`
      (= (FuzzTypeSchema OnlyRecursive Nat)
         (FuzzTypeConstructors
           ((Constructor 1 Nat (succ (Ref Nat))))))
      !(gen-well-typed OnlyRecursive Nat)
      (= (FuzzTypeSchema Peano Nat)
         (FuzzTypeConstructors
           ((Constructor 1 Nat (z))
            (Constructor 1 Nat (succ (Ref Nat))))))
      !(fuzz-generate-edge (gen-well-typed Peano Nat) 0 3)
      !(fuzz-generate-edge (gen-well-typed Peano Nat) 1 3)
      (= (FuzzTypeSchema ListSchema (List $element))
         (FuzzTypeConstructors
           ((Constructor 1 (List $element) (nil))
            (Constructor 1 (List $element)
              (cons (Ref $element) (Ref (List $element)))))))
      (= (FuzzTypeSchema ListSchema Num)
         (FuzzTypeConstructors
           ((Constructor 1 Num (num (Field (gen-int 0 1)))))))
      !(fuzz-generate-edge (gen-well-typed ListSchema (List Num)) 1 4)
      !(gen-well-typed ListSchema (List Bool))
    `);

    expect(out[1]![0]).toContain("(FuzzGenerationError");
    expect(out[1]![0]).toContain("OnlyRecursive");
    expect(out[2]![0]).toMatch(/^\(FuzzSample \(z\) /);
    expect(out[3]![0]).toMatch(/^\(FuzzSample \(succ /);
    expect(out[4]![0]).toMatch(/^\(FuzzSample \(cons \(num [01]\) /);
    expect(out[5]![0]).toContain("(FuzzGenerationError");
    expect(out[5]![0]).toContain("Bool");
  });

  it("scales to many distinct literal targets and dynamic type chains", () => {
    const targets = 96;
    const literalProductions = Array.from(
      { length: targets },
      (_, index) => `(Production 1 (T ${index}) (leaf ${index}))`,
    ).join("\n           ");
    const startedTargets = performance.now();
    const targetsOut = printed(`
      (FuzzGrammar ManyTargets
        (Productions
          (${literalProductions})))
      !(gen-grammar-root ManyTargets (T 0))
      !(fuzz-generate-edge (gen-grammar-root ManyTargets (T 0)) 0 0)
    `);
    const targetsElapsed = performance.now() - startedTargets;
    expect(targetsOut[1]![0]).toContain("(GrammarRequest");
    expect(targetsOut[2]![0]).toMatch(/^\(FuzzSample \(leaf 0\) /);

    const levels = 48;
    const chainSchemas = Array.from({ length: levels }, (_, level) =>
      level === 0
        ? `(= (FuzzTypeSchema Chain (Level 0))
         (FuzzTypeConstructors
           ((Constructor 1 (Level 0) (bottom)))))`
        : `(= (FuzzTypeSchema Chain (Level ${level}))
         (FuzzTypeConstructors
           ((Constructor 1 (Level ${level})
              (down ${level} (Ref (Level ${level - 1})))))))`,
    ).join("\n      ");
    const startedChain = performance.now();
    const chainOut = printed(`
      ${chainSchemas}
      !(fuzz-generate-edge
         (gen-well-typed Chain (Level ${levels - 1}))
         0
         ${levels})
    `);
    const chainElapsed = performance.now() - startedChain;
    expect(chainOut[1]![0]).toMatch(/^\(FuzzSample \(down 47 \(down 46 \(down 45 /);

    // Scaling gate: both workloads were quadratic-or-worse before the
    // immutable summary boundary (10.1s at 64 targets, 55.3s at 48 levels).
    expect(targetsElapsed).toBeLessThan(10_000);
    expect(chainElapsed).toBeLessThan(10_000);
  }, 120_000);

  it("constructs terms from explicit parametric type schemas", () => {
    const out = printed(`
      (= (FuzzTypeSchema STLC Num)
         (FuzzTypeConstructors
           ((Constructor 1 Num
              (var (Use Num)))
            (Constructor 1 Num
              (lit (Field (gen-int 0 2))))
            (Constructor 1 Num
              (add (Ref Num) (Ref Num))))))
      (= (FuzzTypeSchema STLC (Arrow $input $output))
         (FuzzTypeConstructors
           ((Constructor 1
              (Arrow $input $output)
              (lambda
                (Bind $input
                  (Ref $output)))))))
      !(fuzz-generate-edge
         (gen-well-typed STLC Num)
         0
         0)
      !(fuzz-generate-edge
         (gen-well-typed STLC (Arrow Num Num))
         1
         1)
      (: alleged-constructor Num)
      !(gen-well-typed Inferred Num)
      (= (FuzzTypeSchema Wrong Num)
         (FuzzTypeConstructors
           ((Constructor 1 Bool nope))))
      !(gen-well-typed Wrong Num)
      (= (FuzzTypeSchema Ambiguous Num)
         (FuzzTypeConstructors
           ((Constructor 1 Num first))))
      (= (FuzzTypeSchema Ambiguous Num)
         (FuzzTypeConstructors
           ((Constructor 1 Num second))))
      !(gen-well-typed Ambiguous Num)
    `);

    expect(out[1]![0]).toMatch(/^\(FuzzSample \(lit 2\) /);
    expect(out[2]![0]).toMatch(/^\(FuzzSample \(lambda \(\$fuzz-0 \(var \$fuzz-0\)\)\) /);
    expect(out[3]).toEqual([
      "(FuzzGenerationError MissingTypeSchema (Details (Schema Inferred) (Type (quote Num))))",
    ]);
    expect(out[4]).toEqual([
      "(FuzzGenerationError TypeConstructorResultMismatch (Details (Schema Wrong) (RequestedType (quote Num)) (ConstructorType (quote Bool)) (ConstructorIndex 0)))",
    ]);
    expect(out[5]).toEqual([
      "(FuzzGenerationError AmbiguousTypeSchema (Details (Schema Ambiguous) (Type (quote Num)) (Results ((quote (FuzzTypeConstructors ((Constructor 1 Num first)))) (quote (FuzzTypeConstructors ((Constructor 1 Num second))))))))",
    ]);
  });

  it("keeps the kernel machine identical to the MeTTa specification machine", () => {
    const out = printed(`
      (FuzzGrammar DiffMachine
        (Productions
          ((Production 3 Expr (add (Ref Expr) (Ref Expr)))
           (Production 2 Expr (lambda (Bind Name (Ref Expr))))
           (Production 1 Expr (Use Name))
           (Production 1 Expr (var (Fresh Name)))
           (Production 1 Expr (lit (Field (gen-int 0 9))))
           (Production 1 Expr (Literal (closed leaf))))))
      (= (diff-request)
         (let $descriptor (gen-grammar-root DiffMachine Expr)
           (unify $descriptor
             (GenCustom
               _fuzz-grammar
               (GrammarRequest $source $target $scope $next-id))
             (DiffRequest $source $target $scope $next-id)
             (DiffBadDescriptor $descriptor))))
      (= (diff-both $driver $size)
         (let $request (diff-request)
           (unify $request
             (DiffRequest $source $target $scope $next-id)
             (DiffPair
               (_fuzz-generate-grammar-nonterminal
                 $source $target $scope $next-id $driver $size)
               (_fuzz-generate-grammar-nonterminal-reference
                 $source $target $scope $next-id $driver $size))
             $request)))
      (= (diff-tree $seed $size)
         (let $request (diff-request)
           (unify $request
             (DiffRequest $source $target $scope $next-id)
             (let $driver (fuzz-random-driver $seed)
               (let $first
                    (_fuzz-generate-grammar-nonterminal
                      $source $target $scope $next-id $driver $size)
                 (unify $first
                   (GrammarResult $value $spent $final-id $tree)
                   $tree
                   (DiffNoTree $first))))
             $request)))
      (= (diff-replay-both $seed $size)
         (let $tree (diff-tree $seed $size)
           (let $driver (fuzz-replay-driver $tree)
             (diff-both $driver $size))))
      (= (diff-shrink-both $seed $size)
         (let $tree (diff-tree $seed $size)
           (let $driver (_fuzz-shrink-replay-driver $tree)
             (diff-both $driver $size))))
      !(diff-both (fuzz-random-driver (superpose (0 1 2 3 4 5 6 7))) 6)
      !(diff-both (fuzz-random-driver (superpose (11 12 13))) 0)
      !(diff-both (fuzz-random-driver (superpose (21 22 23))) 12)
      !(diff-both (fuzz-edge-driver (superpose (0 1 2 3 4 5))) 4)
      !(diff-replay-both (superpose (31 32 33)) 6)
      !(diff-shrink-both (superpose (41 42 43)) 6)
      !(let $request (diff-request)
         (unify $request
           (DiffRequest $source $target $scope $next-id)
           (let $driver (fuzz-exhaustive-driver)
             (DiffPair
               (collapse
                 (_fuzz-generate-grammar-nonterminal
                   $source $target $scope $next-id $driver 1))
               (collapse
                 (_fuzz-generate-grammar-nonterminal-reference
                   $source $target $scope $next-id $driver 1))))
           $request))
      !(let $request (diff-request)
         (unify $request
           (DiffRequest (StaticGrammar (quote $g) $productions) $target $scope $next-id)
           (let $targets (_fuzz-grammar-reference-targets $productions)
             (DiffPair
               (_fuzz-validate-grammar-productivity
                 $g Expr $productions $targets)
               (_fuzz-validate-grammar-productivity-reference
                 $g Expr $productions $targets)))
           $request))
      !(DiffPair
         (_fuzz-validate-grammar-productivity Unprod Loop
           ((GrammarProduction 0 1 (quote Loop)
              (quote (n (_FuzzGrammarRef Loop 0 1)))))
           ((quote Loop)))
         (_fuzz-validate-grammar-productivity-reference Unprod Loop
           ((GrammarProduction 0 1 (quote Loop)
              (quote (n (_FuzzGrammarRef Loop 0 1)))))
           ((quote Loop))))
    `);

    const diffPair = (row: string): [string, string] => {
      const items = topLevelItems(row);
      expect(items[0]).toBe("DiffPair");
      expect(items).toHaveLength(3);
      return [items[1]!, items[2]!];
    };
    const expectIdenticalRows = (rows: readonly string[] | undefined, shape: RegExp): void => {
      expect(rows).toBeDefined();
      expect(rows!.length).toBeGreaterThan(0);
      for (const row of rows!) {
        const [machine, reference] = diffPair(row);
        expect(machine).toMatch(shape);
        expect(reference).toBe(machine);
      }
    };

    const sample = /^\(GrammarResult /;
    expectIdenticalRows(out[1], sample);
    expectIdenticalRows(out[2], sample);
    expectIdenticalRows(out[3], sample);
    expectIdenticalRows(out[4], sample);
    expectIdenticalRows(out[5], sample);
    expectIdenticalRows(out[6], sample);
    expectIdenticalRows(out[7], /^\(\(GrammarResult /);
    expectIdenticalRows(out[8], /^\(ValidGrammarProductivity\)$/);
    expectIdenticalRows(out[9], /^\(FuzzGenerationError UnproductiveGrammarNonterminal /);
  });
});
