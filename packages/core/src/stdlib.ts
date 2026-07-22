// SPDX-FileCopyrightText: 2026 MesTTo
//
// SPDX-License-Identifier: MIT

// The MeTTa standard library that ships with @metta-ts/core, hardcoded and always loaded after the
// (LeaTTa-vendored) prelude. These are STANDARD hyperon functions, written in MeTTa wherever possible
// so the interpreter runs them (only genuine host primitives, println!/format-args/arithmetic, are
// grounded in builtins.ts). TS-native, non-standard extensions (transaction, concurrency) do NOT live
// here; they are opt-in import modules (see extensions.ts).
//
// Ported/adapted from hyperon-experimental stdlib.metta. Only declarations missing from the prelude are
// added here, to avoid duplicate definitions.
import type { Atom } from "./atom";
import { parseAll } from "./parser";
import { standardTokenizer } from "./runner";

export const STDLIB_SRC = `
  ; ---- Types of the grounded ops (math, bool, atom). Hyperon's grounded atoms carry their type
  ; intrinsically and \`get-type\` reads it; @metta-ts grounds these as host functions in builtins.ts,
  ; so the type signature is declared here to match. Values from hyperon-experimental math.rs/atom.rs
  ; (math ops are f64-valued, so e.g. pow-math/sqrt-math return Number; min-atom/max-atom take any
  ; expression, typed %Undefined% -> Number). The core arithmetic and comparison ops (+ - < == …) are
  ; already declared in the prelude.
  (: pow-math (-> Number Number Number))
  (: sqrt-math (-> Number Number))
  (: abs-math (-> Number Number))
  (: log-math (-> Number Number Number))
  (: trunc-math (-> Number Number))
  (: ceil-math (-> Number Number))
  (: floor-math (-> Number Number))
  (: round-math (-> Number Number))
  (: sin-math (-> Number Number))
  (: asin-math (-> Number Number))
  (: cos-math (-> Number Number))
  (: acos-math (-> Number Number))
  (: tan-math (-> Number Number))
  (: atan-math (-> Number Number))
  (: isnan-math (-> Number Bool))
  (: isinf-math (-> Number Bool))
  (: min-atom (-> %Undefined% Number))
  (: max-atom (-> %Undefined% Number))
  (: sqrt (-> Number Number))
  (: sin (-> Number Number))
  (: cos (-> Number Number))
  (: exp (-> Number Number))
  (: log (-> Number Number Number))
  (: min (-> Number Number Number))
  (: max (-> Number Number Number))
  (: and (-> Bool Bool Bool))
  (: or (-> Bool Bool Bool))
  (: not (-> Bool Bool))
  (: xor (-> Bool Bool Bool))
  (: length (-> %Undefined% Number))
  (: first (-> %Undefined% Atom))
  (: last (-> %Undefined% Atom))
  (: reverse (-> %Undefined% Expression))
  (: msort (-> %Undefined% Expression))
  (: sort (-> %Undefined% Expression))
  (: list_to_set (-> %Undefined% Expression))
  (: second-from-pair (-> %Undefined% Atom))
  (: append (-> %Undefined% %Undefined% Expression))
  (: is-member (-> %Undefined% %Undefined% Bool))
  (: is-alpha-member (-> %Undefined% %Undefined% Bool))
  (: member (-> %Undefined% %Undefined% Bool))
  (: exclude-item (-> %Undefined% %Undefined% Expression))
  (: is-var (-> Atom Bool))
  (: is-ground (-> Atom Bool))
  (: is-expr (-> Atom Bool))
  (: is-space (-> Atom Bool))
  (: get-mettatype (-> Atom Atom))
  (: parse (-> String Atom))
  (: sread (-> String Atom))
  (: random-int (-> Number Number Number))
  (: random-float (-> Number Number Number))
  (: current-time (-> Number))
  (: metta-thread (-> Atom Atom Atom Atom))
  (: once (-> Atom %Undefined%))
  (: with-mutex (-> Atom Atom %Undefined%))
  (: with_mutex (-> Atom Atom %Undefined%))
  (: hyperpose (-> %Undefined% %Undefined%))

  ; sealed alpha-renames the variables of its second argument. That argument is Atom-typed so the
  ; body reaches sealed unevaluated (hyperon-experimental core.rs: (-> Expression Atom Atom)); without
  ; this the reduce loop would evaluate the body first, e.g. collapsing (== 1 $e) before renaming.
  (: sealed (-> Expression Atom Atom))

  ; ---- IO (host primitives grounded in builtins.ts) ----
  (: println! (-> %Undefined% (->)))
  (: print! (-> %Undefined% (->)))
  (: format-args (-> String Expression String))
  ; repr renders an atom's textual form. The argument is Atom-typed (not evaluated) so repr shows the
  ; atom as written; to repr a reduced form, evaluate it first (e.g. bind it with let).
  (: repr (-> Atom String))

  ; trace! prints its first argument and returns the (evaluated) second.
  (: trace! (-> %Undefined% Atom %Undefined%))
  (= (trace! $msg $ret) (let $unit (println! $msg) $ret))

  ; Partial application is ordinary PeTTa behavior. A known under-applied head becomes
  ; (partial head args); applying that closure rebuilds the fuller call and evaluates it.
  (: partial (-> Atom Expression Atom))
  (= ((partial $f $bound) $a)
     (let $args (append $bound ($a))
       (let $call (cons-atom $f $args) (metta $call %Undefined% &self))))
  (= ((partial $f $bound) $a $b)
     (let $args (append $bound ($a $b))
       (let $call (cons-atom $f $args) (metta $call %Undefined% &self))))

  ; Lambda heads are expressions, so they do not pass through the symbol-headed
  ; under-application hook above.
  (= ((|-> ($p1 $p2) $body) $a1)
     (partial (|-> ($p1 $p2) $body) ($a1)))
  (= ((|-> ($p1 $p2 $p3) $body) $a1)
     (partial (|-> ($p1 $p2 $p3) $body) ($a1)))
  (= ((|-> ($p1 $p2 $p3) $body) $a1 $a2)
     (partial (|-> ($p1 $p2 $p3) $body) ($a1 $a2)))

  ; PeTTa-compatible single-threaded wrapper. The async mutex is with-mutex; this spelling exists so PeTTa
  ; corpus examples can run on the synchronous runner where there is no concurrent mutation to protect.
  (= (with_mutex $name $body) (metta $body %Undefined% &self))

  ; include = import a module's contents into the current space.
  (: include (-> Atom %Undefined%))
  (= (include $module) (import! &self $module))

  ; ---- Error system ----
  (: ErrorType Type)
  (: ErrorDescription Type)
  (: IncorrectNumberOfArguments ErrorDescription)
  (: BadType (-> Type Type ErrorDescription))
  (: BadArgType (-> Number Type Type ErrorDescription))

  ; ---- Module system (minimal: @metta-ts resolves modules via import! into a space) ----
  (: module-space-no-deps (-> SpaceType SpaceType))
  (= (module-space-no-deps $s) $s)
  (: print-mods! (-> (->)))
  (= (print-mods!) ())
  (: git-module! (-> Atom (->)))
  (= (git-module! $url) (Error (git-module! $url) "git-module! is not supported in @metta-ts"))

  ; ---- Documentation system (ported from hyperon stdlib.metta) ----
  (: DocDescription Type)
  (: DocInformal Type)
  (: DocFormal Type)
  (: DocItem Type)
  (: DocKindFunction Type)
  (: DocKindAtom Type)
  (: DocType Type)
  (: DocParameters Type)
  (: DocParameter Type)
  (: DocParameterInformal Type)
  (: DocReturn Type)
  (: DocReturnInformal Type)
  (: @doc (-> Atom DocDescription DocInformal))
  (: @doc (-> Atom DocDescription DocParameters DocReturnInformal DocInformal))
  (: @desc (-> String DocDescription))
  (: @param (-> String DocParameterInformal))
  (: @param (-> DocType DocDescription DocParameter))
  (: @return (-> String DocReturnInformal))
  (: @return (-> DocType DocDescription DocReturn))
  (: @doc-formal (-> DocItem DocKindFunction DocType DocDescription DocParameters DocReturn DocFormal))
  (: @doc-formal DocFormal)
  (: @item (-> Atom DocItem))
  (: @kind (-> Atom DocKindFunction))
  (: @type (-> Type DocType))
  (: @params (-> Expression DocParameters))

  (= (get-doc-single-atom $space $atom)
    (let $type (get-type-space $space $atom)
      (if (is-function $type)
        (get-doc-function $space $atom $type)
        (get-doc-atom $space $atom) )))
  (= (get-doc-function $space $name $type)
    (unify $space (@doc $name $desc (@params $params) $ret)
      (let $type' (if (== $type %Undefined%) (undefined-doc-function-type $params) (cdr-atom $type))
      (let ($params' $ret') (get-doc-params $params $ret $type')
        (@doc-formal (@item $name) (@kind function) (@type $type) $desc (@params $params') $ret')))
      Empty ))
  (= (get-doc-atom $space $atom)
    (let $type (get-type-space $space $atom)
      (unify $space (@doc $atom $desc)
        (@doc-formal (@item $atom) (@kind atom) (@type $type) $desc)
        (unify $space (@doc $atom $desc' (@params $params) $ret)
          (get-doc-function $space $atom %Undefined%)
          Empty ))))
  (= (get-doc-params $params $ret $types)
    (let $head-type (car-atom $types)
    (let $tail-types (cdr-atom $types)
      (if (== () $params)
        (let (@return $ret-desc) $ret
          (() (@return (@type $head-type) (@desc $ret-desc))) )
        (let (@param $param-desc) (car-atom $params)
          (let $tail-params (cdr-atom $params)
          (let ($params' $result-ret) (get-doc-params $tail-params $ret $tail-types)
          (let $result-params (cons-atom (@param (@type $head-type) (@desc $param-desc)) $params')
            ($result-params $result-ret) ))))))))
  (= (undefined-doc-function-type $params)
    (if (== () $params) (%Undefined%)
      (let $params-tail (cdr-atom $params)
      (let $tail (undefined-doc-function-type $params-tail)
        (cons-atom %Undefined% $tail) ))))
  (= (help-param! $param)
    (let (@param (@type $type) (@desc $desc)) $param
      (println! (format-args "  {} {}" ((type $type) $desc))) ))
  (: help-space! (-> SpaceType (->)))
  (= (help-space! $space)
    (let $_ (collapse
      (unify $space (@doc $name (@desc $desc) $params $ret)
        (let () (println! (format-args "{} {}" ($name $desc))) Empty)
        Empty )) ()))

  ; mod-space! loads a module into a fresh space and returns it.
  (: mod-space! (-> Atom SpaceType))
  (= (mod-space! $module) (let $s (new-space) (let $u (import! $s $module) $s)))

  ; ---- builtin documentation: @doc entries read by get-doc; descriptions from the hyperon stdlib ----
  (@doc + (@desc "Sums two numbers") (@params ((@param "Addend") (@param "Augend"))) (@return "Sum"))
  (@doc - (@desc "Subtracts second argument from first one") (@params ((@param "Minuend") (@param "Deductible"))) (@return "Difference"))
  (@doc * (@desc "Multiplies two numbers") (@params ((@param "Multiplier") (@param "Multiplicand"))) (@return "Product"))
  (@doc / (@desc "Divides first argument by second one") (@params ((@param "Dividend") (@param "Divisor"))) (@return "Fraction"))
  (@doc % (@desc "Modulo operator. Returns the remainder of dividing the first argument by the second") (@params ((@param "Dividend") (@param "Divisor"))) (@return "Remainder"))
  (@doc if (@desc "Replaces itself by one of the arguments depending on the condition") (@params ((@param "Boolean condition") (@param "Result when condition is True") (@param "Result when condition is False"))) (@return "Second or third argument"))
  (@doc car-atom (@desc "Extracts the first atom of an expression as a tuple") (@params ((@param "Expression"))) (@return "First atom of an expression"))
  (@doc cdr-atom (@desc "Extracts the tail of an expression (all but the first atom)") (@params ((@param "Expression"))) (@return "Tail of an expression"))
  (@doc match (@desc "Searches a space (first argument) for atoms matching a pattern (second argument) and returns the output template (third argument)") (@params ((@param "Atomspace to search") (@param "Pattern atom to match") (@param "Output template, typically containing variables from the pattern"))) (@return "The template with matched variables filled, or Empty"))
  (@doc get-type (@desc "Returns the type notation of the input atom") (@params ((@param "Atom to get the type for"))) (@return "Type notation, or %Undefined% if the atom has no type"))

  ; comparison and equality
  (@doc < (@desc "Less than. Checks whether the first argument is less than the second") (@params ((@param "First number") (@param "Second number"))) (@return "True if the first argument is less than the second, False otherwise"))
  (@doc <= (@desc "Less than or equal. Checks whether the first argument is less than or equal to the second") (@params ((@param "First number") (@param "Second number"))) (@return "True if the first argument is less than or equal to the second, False otherwise"))
  (@doc > (@desc "Greater than. Checks whether the first argument is greater than the second") (@params ((@param "First number") (@param "Second number"))) (@return "True if the first argument is greater than the second, False otherwise"))
  (@doc >= (@desc "Greater than or equal. Checks whether the first argument is greater than or equal to the second") (@params ((@param "First number") (@param "Second number"))) (@return "True if the first argument is greater than or equal to the second, False otherwise"))
  (@doc == (@desc "Checks equality of two arguments of the same type") (@params ((@param "First argument") (@param "Second argument"))) (@return "True if the two arguments are equal, False otherwise"))
  (@doc != (@desc "Checks inequality of two arguments of the same type") (@params ((@param "First argument") (@param "Second argument"))) (@return "True if the two arguments are not equal, False otherwise"))
  (@doc = (@desc "Defines a reduction rule for expressions") (@params ((@param "Pattern to match against the expression to reduce") (@param "Result of reduction or transformation of the pattern"))) (@return "Not reduced itself unless custom equalities over equalities are added"))
  (@doc =alpha (@desc "Checks alpha equality of two expressions") (@params ((@param "First expression") (@param "Second expression"))) (@return "True if both expressions are alpha equal, False otherwise"))

  ; boolean
  (@doc and (@desc "Logical conjunction of two arguments") (@params ((@param "First argument") (@param "Second argument"))) (@return "True if both arguments are True, False otherwise"))
  (@doc or (@desc "Logical disjunction of two arguments") (@params ((@param "First argument") (@param "Second argument"))) (@return "True if any argument is True, False otherwise"))
  (@doc xor (@desc "Logical exclusive or") (@params ((@param "First argument") (@param "Second argument"))) (@return "True if exactly one input is True"))
  (@doc not (@desc "Logical negation") (@params ((@param "Argument"))) (@return "The negated boolean input"))

  ; math
  (@doc abs-math (@desc "Returns the absolute value of the input number") (@params ((@param "Input number"))) (@return "Absolute value"))
  (@doc acos-math (@desc "Returns the arccosine of the input value") (@params ((@param "Float number"))) (@return "Result of the arccosine function"))
  (@doc asin-math (@desc "Returns the arcsine of the input value") (@params ((@param "Float number"))) (@return "Result of the arcsine function"))
  (@doc atan-math (@desc "Returns the arctangent of the input value") (@params ((@param "Float number"))) (@return "Result of the arctangent function"))
  (@doc ceil-math (@desc "Returns the smallest integer greater than or equal to the input value") (@params ((@param "Float value"))) (@return "Integer greater than or equal to the input"))
  (@doc cos-math (@desc "Returns the cosine of the input value in radians") (@params ((@param "Angle in radians"))) (@return "Result of the cosine function"))
  (@doc floor-math (@desc "Returns the largest integer less than or equal to the input value") (@params ((@param "Float value"))) (@return "Integer less than or equal to the input"))
  (@doc round-math (@desc "Returns the nearest integer to the input float value") (@params ((@param "Float value"))) (@return "Nearest integer to the input"))
  (@doc sin-math (@desc "Returns the sine of the input value in radians") (@params ((@param "Angle in radians"))) (@return "Result of the sine function"))
  (@doc sqrt-math (@desc "Returns the square root of the input number") (@params ((@param "Input number"))) (@return "Result of the square root function"))
  (@doc tan-math (@desc "Returns the tangent of the input value in radians") (@params ((@param "Angle in radians"))) (@return "Result of the tangent function"))
  (@doc trunc-math (@desc "Returns the integer part of the input value") (@params ((@param "Float value"))) (@return "Integer part of the input"))
  (@doc isinf-math (@desc "Checks whether the input value is positive or negative infinity") (@params ((@param "Number"))) (@return "True or False"))
  (@doc isnan-math (@desc "Checks whether the input value is NaN") (@params ((@param "Number"))) (@return "True or False"))
  (@doc log-math (@desc "Returns the logarithm of a number given a base") (@params ((@param "Base") (@param "Input number"))) (@return "Result of the logarithm function"))
  (@doc pow-math (@desc "Returns the base raised to the given power") (@params ((@param "Base") (@param "Power"))) (@return "Result of the power function"))
  (@doc sqrt (@desc "Returns the square root of the input number") (@params ((@param "Input number"))) (@return "Square root"))
  (@doc sin (@desc "Returns the sine of the input value in radians") (@params ((@param "Angle in radians"))) (@return "Sine of the input"))
  (@doc cos (@desc "Returns the cosine of the input value in radians") (@params ((@param "Angle in radians"))) (@return "Cosine of the input"))
  (@doc exp (@desc "Returns e raised to the input number") (@params ((@param "Input number"))) (@return "Exponential value"))
  (@doc log (@desc "Returns the logarithm of a number in a base") (@params ((@param "Base") (@param "Input number"))) (@return "Logarithm"))
  (@doc min (@desc "Returns the smaller of two numbers") (@params ((@param "First number") (@param "Second number"))) (@return "Smaller number"))
  (@doc max (@desc "Returns the larger of two numbers") (@params ((@param "First number") (@param "Second number"))) (@return "Larger number"))

  ; list and expression
  (@doc cons-atom (@desc "Constructs an expression from a head and a tail") (@params ((@param "Head of the expression") (@param "Tail of the expression"))) (@return "New expression with the head prepended to the tail"))
  (@doc decons-atom (@desc "Splits a non-empty expression into its head and tail") (@params ((@param "Expression"))) (@return "Deconstructed expression as head and tail"))
  (@doc index-atom (@desc "Returns the atom at the given index of an expression, or an error if out of bounds") (@params ((@param "Expression") (@param "Index"))) (@return "Atom at the index, or an error"))
  (@doc size-atom (@desc "Returns the size of an expression") (@params ((@param "Expression"))) (@return "Size of the expression"))
  (@doc filter-atom (@desc "Keeps the atoms of a list that satisfy a predicate") (@params ((@param "List of atoms") (@param "Variable") (@param "Filter predicate"))) (@return "Filtered list"))
  (@doc map-atom (@desc "Evaluates a template for each atom in a list") (@params ((@param "List of atoms") (@param "Variable name") (@param "Template using the variable"))) (@return "List of results"))
  (@doc foldl-atom (@desc "Folds an operation across a list from an initial value") (@params ((@param "List of values") (@param "Initial value") (@param "Variable") (@param "Variable") (@param "Operation"))) (@return "Result of folding the operation across the list"))
  (@doc for-each-in-atom (@desc "Applies a function to each atom in an expression") (@params ((@param "Expression whose atoms the function is applied to") (@param "Function to apply"))) (@return "Unit atom"))
  (@doc atom-subst (@desc "Substitutes a variable in a template with a value") (@params ((@param "Value to substitute in") (@param "Variable to replace") (@param "Template containing the variable"))) (@return "The template with the variable substituted"))
  (@doc length (@desc "Returns the number of atoms in an expression") (@params ((@param "Expression"))) (@return "Number of atoms"))
  (@doc first (@desc "Returns the first atom in a non-empty expression") (@params ((@param "Expression"))) (@return "First atom"))
  (@doc last (@desc "Returns the last atom in a non-empty expression") (@params ((@param "Expression"))) (@return "Last atom"))
  (@doc reverse (@desc "Returns the atoms of an expression in reverse order") (@params ((@param "Expression"))) (@return "Reversed expression"))
  (@doc msort (@desc "Sorts an expression by standard atom order, preserving duplicates") (@params ((@param "Expression"))) (@return "Sorted expression"))
  (@doc sort (@desc "Sorts an expression by standard atom order and removes duplicate atoms") (@params ((@param "Expression"))) (@return "Sorted expression with duplicates removed"))
  (@doc list_to_set (@desc "Removes duplicate atoms from an expression, preserving first occurrences") (@params ((@param "Expression"))) (@return "Expression with duplicates removed"))
  (@doc append (@desc "Concatenates two expressions") (@params ((@param "First expression") (@param "Second expression"))) (@return "Concatenated expression"))
  (@doc member (@desc "Succeeds with True when an atom is a member of an expression") (@params ((@param "Atom to search for") (@param "Expression to search"))) (@return "True if the atom is present, otherwise Empty"))
  (@doc is-member (@desc "Checks whether an atom is a member of an expression") (@params ((@param "Atom to search for") (@param "Expression to search"))) (@return "True if the atom is present, False otherwise"))
  (@doc is-alpha-member (@desc "Checks whether an atom is alpha-equal to a member of an expression") (@params ((@param "Atom to search for") (@param "Expression to search"))) (@return "True if an alpha-equal atom is present, False otherwise"))
  (@doc exclude-item (@desc "Returns an expression with every occurrence of an atom removed") (@params ((@param "Atom to remove") (@param "Expression to filter"))) (@return "Filtered expression"))
  (@doc second-from-pair (@desc "Returns the second atom of a pair") (@params ((@param "Pair"))) (@return "Second atom of the pair"))

  ; set operations
  (@doc union (@desc "Returns the union of two nondeterministic inputs") (@params ((@param "Nondeterministic set of values") (@param "Another nondeterministic set of values"))) (@return "Union of the sets"))
  (@doc intersection (@desc "Returns the intersection of two nondeterministic inputs") (@params ((@param "Nondeterministic set of values") (@param "Another nondeterministic set of values"))) (@return "Intersection of the sets"))
  (@doc subtraction (@desc "Returns the subtraction of two nondeterministic inputs") (@params ((@param "Nondeterministic set of values") (@param "Another nondeterministic set of values"))) (@return "Subtraction of the sets"))
  (@doc union-atom (@desc "Returns the union of two tuples") (@params ((@param "List of values") (@param "List of values"))) (@return "Union of the tuples"))
  (@doc intersection-atom (@desc "Returns the intersection of two tuples") (@params ((@param "List of values") (@param "List of values"))) (@return "Intersection of the tuples"))
  (@doc subtraction-atom (@desc "Returns the subtraction of two tuples") (@params ((@param "List of values") (@param "List of values"))) (@return "Subtraction of the tuples"))
  (@doc unique (@desc "Returns only the unique values from a nondeterministic input") (@params ((@param "Nondeterministic set of values"))) (@return "Unique values"))
  (@doc unique-atom (@desc "Returns only the unique values from a tuple") (@params ((@param "List of values"))) (@return "Unique values"))
  (@doc min-atom (@desc "Returns the minimum value in an expression of numbers") (@params ((@param "Expression of Number atoms"))) (@return "Minimum value, or an error if the expression is non-numeric or empty"))
  (@doc max-atom (@desc "Returns the maximum value in an expression of numbers") (@params ((@param "Expression of Number atoms"))) (@return "Maximum value, or an error if the expression is non-numeric or empty"))

  ; control flow
  (@doc if-equal (@desc "Checks whether the first two arguments are equal and evaluates the third if so, the fourth otherwise") (@params ((@param "First argument") (@param "Second argument") (@param "Evaluated if equal") (@param "Evaluated if not equal"))) (@return "The evaluated third or fourth argument"))
  (@doc if-error (@desc "Checks whether the first argument is an error and returns the second if so, the third otherwise") (@params ((@param "Atom to check for an error") (@param "Value if the first is an error") (@param "Value otherwise"))) (@return "The second or third argument"))
  (@doc return-on-error (@desc "Returns the first argument if it is Empty or an error, the second otherwise") (@params ((@param "Previous evaluation result") (@param "Atom for further evaluation"))) (@return "The previous result if it is an error or Empty, otherwise the second argument"))
  (@doc if-decons-expr (@desc "Deconstructs a non-empty expression into head and tail and evaluates a template, or a default otherwise") (@params ((@param "Expression to deconstruct") (@param "Head variable") (@param "Tail variable") (@param "Template if the expression is non-empty") (@param "Default otherwise"))) (@return "The template with head and tail, or the default"))
  (@doc case (@desc "Tests pattern-matching conditions for a value in sequence") (@params ((@param "Atom to evaluate") (@param "Tuple of pattern-to-result pairs"))) (@return "The result of the first matching condition"))
  (@doc switch (@desc "Tests pattern-matching conditions for a value in sequence") (@params ((@param "Atom to match against the patterns") (@param "Tuple of pattern-to-result pairs"))) (@return "The result for the first matching pattern"))
  (@doc switch-internal (@desc "Tests one case of a switch and recurses if the condition is not met") (@params ((@param "Atom to evaluate") (@param "Deconsed tuple of pattern-to-result pairs"))) (@return "The result of the matched condition"))
  (@doc let (@desc "Unifies the first two arguments and evaluates the third under the resulting bindings") (@params ((@param "First atom to unify") (@param "Second atom to unify, evaluated first") (@param "Expression evaluated if the two unify"))) (@return "The third argument, or Empty"))
  (@doc let* (@desc "Sequentially unifies a list of pairs, then evaluates a body") (@params ((@param "List of pairs of atoms to unify") (@param "Expression evaluated if every pair unifies"))) (@return "The body, or Empty"))
  (@doc id (@desc "Returns its argument unchanged") (@params ((@param "Input argument"))) (@return "The input argument"))
  (@doc noeval (@desc "Returns its argument unevaluated") (@params ((@param "Input argument"))) (@return "The input argument"))
  (@doc noreduce-eq (@desc "Checks equality of two atoms without reducing them") (@params ((@param "First atom") (@param "Second atom"))) (@return "True if the unreduced atoms are equal, False otherwise"))

  ; minimal MeTTa
  (@doc eval (@desc "Performs one step of evaluation of the input atom") (@params ((@param "Atom to evaluate, reducible by an equality or a grounded call"))) (@return "Result of one evaluation step"))
  (@doc evalc (@desc "Performs one step of evaluation of the input atom in the context of a space") (@params ((@param "Atom to evaluate") (@param "Space to evaluate the atom in"))) (@return "Result of one evaluation step"))
  (@doc chain (@desc "Evaluates the first argument, binds it to the variable, then evaluates the template") (@params ((@param "Atom to evaluate") (@param "Variable") (@param "Atom evaluated at the end"))) (@return "Result of evaluating the template"))
  (@doc unify (@desc "Matches the first two arguments and returns the third if they match, the fourth otherwise") (@params ((@param "First atom to unify") (@param "Second atom to unify") (@param "Result if they match") (@param "Result otherwise"))) (@return "The third argument if matched, otherwise the fourth"))
  (@doc function (@desc "Evaluates its argument until it becomes a return, then reduces to the returned value") (@params ((@param "Atom to evaluate"))) (@return "Result of the atom's evaluation"))
  (@doc return (@desc "Returns a value from an enclosing function expression") (@params ((@param "Value to return"))) (@return "The passed argument"))
  (@doc collapse-bind (@desc "Evaluates the atom and returns all alternative evaluations as atom-and-bindings pairs") (@params ((@param "Minimal MeTTa operation to evaluate"))) (@return "All alternative evaluations"))
  (@doc superpose-bind (@desc "Puts a list of atom-and-bindings results back into the interpreter plan") (@params ((@param "Expression of atom-and-bindings pairs"))) (@return "Nondeterministic list of atoms"))
  (@doc metta (@desc "Runs the MeTTa interpreter on an atom") (@params ((@param "Atom to interpret") (@param "Expected type of the atom") (@param "Space to interpret the atom in"))) (@return "Result of interpretation"))
  (@doc metta-thread (@desc "Runs the MeTTa interpreter on an atom and threads its bindings into the current evaluation") (@params ((@param "Atom to interpret") (@param "Expected type of the atom") (@param "Space to interpret the atom in"))) (@return "Result of interpretation"))

  ; spaces and matching
  (@doc add-atom (@desc "Adds an atom to a space without reducing it") (@params ((@param "Space to add the atom to") (@param "Atom to add"))) (@return "Unit atom"))
  (@doc remove-atom (@desc "Removes an atom from a space") (@params ((@param "Space to remove the atom from") (@param "Atom to remove"))) (@return "Unit atom"))
  (@doc add-atoms (@desc "Adds the atoms of an expression to a space without reducing them") (@params ((@param "Space") (@param "Expression of atoms to add"))) (@return "Unit atom"))
  (@doc add-reduct (@desc "Reduces an atom and adds the result to a space") (@params ((@param "Space to add the atom to") (@param "Atom to reduce and add"))) (@return "Unit atom"))
  (@doc add-reducts (@desc "Reduces the atoms of an expression and adds the results to a space") (@params ((@param "Space") (@param "Expression to reduce and add"))) (@return "Unit atom"))
  (@doc get-atoms (@desc "Returns all atoms in a space") (@params ((@param "Reference to the space"))) (@return "List of all atoms in the space"))
  (@doc new-space (@desc "Creates a new atomspace usable as a separate space from &self") (@params ()) (@return "Reference to a new space"))
  (@doc context-space (@desc "Returns the space used as the context in atom evaluation") (@params ()) (@return "The context space"))

  ; state monad
  (@doc new-state (@desc "Creates a new state atom wrapping its argument") (@params ((@param "Atom to wrap"))) (@return "A state wrapping the argument"))
  (@doc get-state (@desc "Returns the atom wrapped by a state") (@params ((@param "State"))) (@return "Atom wrapped by the state"))
  (@doc change-state! (@desc "Replaces the wrapped atom of a state with a new value") (@params ((@param "State created by new-state") (@param "Atom to replace the wrapped atom"))) (@return "State with the replaced atom"))

  ; nondeterminism and quoting
  (@doc superpose (@desc "Turns a tuple into a nondeterministic result") (@params ((@param "Tuple to convert"))) (@return "The argument as a nondeterministic result"))
  (@doc hyperpose (@desc "Turns an expression into nondeterministic results") (@params ((@param "Expression to convert"))) (@return "The expression items as nondeterministic results"))
  (@doc collapse (@desc "Converts a nondeterministic result into a tuple") (@params ((@param "Atom to evaluate"))) (@return "Tuple"))
  (@doc once (@desc "Evaluates an atom and keeps only its first result") (@params ((@param "Atom to evaluate"))) (@return "First result, or Empty if there is no result"))
  (@doc quote (@desc "Prevents an atom from being reduced") (@params ((@param "Atom"))) (@return "Quoted atom"))
  (@doc unquote (@desc "Unquotes a quoted atom") (@params ((@param "Quoted atom"))) (@return "Unquoted atom"))
  (@doc sealed (@desc "Replaces every variable in an atom with a unique variable, except those to ignore") (@params ((@param "Variable list to ignore") (@param "Atom that uses the variables"))) (@return "The atom with its variables made unique"))
  (@doc capture (@desc "Wraps an atom and captures the current space") (@params ((@param "Function name whose space to capture"))) (@return "Function"))
  (@doc with-mutex (@desc "Evaluates a body while holding a mutex with the given name") (@params ((@param "Mutex name") (@param "Body to evaluate"))) (@return "Body result"))
  (@doc with_mutex (@desc "PeTTa-compatible single-threaded wrapper that evaluates its body") (@params ((@param "Mutex name") (@param "Body to evaluate"))) (@return "Body result"))

  ; IO and misc
  (@doc println! (@desc "Prints a line of text to the console") (@params ((@param "Expression or atom to print"))) (@return "Unit atom"))
  (@doc print! (@desc "Prints text to the console without adding a newline") (@params ((@param "Expression or atom to print"))) (@return "Unit atom"))
  (@doc trace! (@desc "Prints the first argument and returns the second; both are evaluated") (@params ((@param "Atom to print") (@param "Atom to return"))) (@return "The evaluated second argument"))
  (@doc repr (@desc "Returns the textual representation of an atom") (@params ((@param "Atom to render"))) (@return "String representation"))
  (@doc format-args (@desc "Fills the placeholders in a string with atoms from an expression") (@params ((@param "String with placeholders to replace") (@param "Atoms to place into the string"))) (@return "The string with placeholders replaced"))
  (@doc parse (@desc "Parses a string of MeTTa source and returns its first atom") (@params ((@param "Source string"))) (@return "First parsed atom, or the empty expression if the string has no atoms"))
  (@doc sread (@desc "Parses a string of MeTTa source and returns its first atom") (@params ((@param "Source string"))) (@return "First parsed atom, or the empty expression if the string has no atoms"))
  (@doc current-time (@desc "Returns the current Unix time in seconds") (@params ()) (@return "Current Unix time"))
  (@doc random-float (@desc "Returns a random float in the half-open interval from the lower bound to the upper bound") (@params ((@param "Lower bound") (@param "Upper bound"))) (@return "Random float"))
  (@doc random-int (@desc "Returns a random integer in the half-open interval from the lower bound to the upper bound") (@params ((@param "Lower bound") (@param "Upper bound"))) (@return "Random integer"))
  (@doc nop (@desc "Outputs the unit atom") (@params ()) (@return "Unit atom"))
  (@doc pragma! (@desc "Changes the value of a global key, such as type-check, interpreter, max-stack-depth, or mettascript-max-steps") (@params ((@param "Key name") (@param "New value"))) (@return "Unit atom"))
  (@doc bind! (@desc "Registers a token replaced by an atom during parsing of the rest of the program") (@params ((@param "Token name") (@param "Atom associated with the token after reduction"))) (@return "Unit atom"))
  (@doc sort-strings (@desc "Sorts an expression of strings in alphabetical order") (@params ((@param "List of strings"))) (@return "Sorted list of strings"))
  (@doc first-from-pair (@desc "Returns the first atom of a pair") (@params ((@param "Pair"))) (@return "First atom of the pair"))
  ; empty is intentionally not documented: it cuts its own evaluation branch, so an @doc-formal mentioning it
  ; reduces to an Error rather than the record. The catalog describes it instead.

  ; type introspection
  (@doc get-type-space (@desc "Returns the type notation of an atom relative to a specified space") (@params ((@param "Space to search for the type") (@param "Atom to get the type for"))) (@return "Type notation, or %Undefined% if the atom has no type in the space"))
  (@doc get-metatype (@desc "Returns the metatype of the input atom") (@params ((@param "Atom to get the metatype for"))) (@return "The metatype of the input atom"))
  (@doc is-var (@desc "Checks whether the input atom is a variable") (@params ((@param "Atom to check"))) (@return "True if the atom is a variable, False otherwise"))
  (@doc is-ground (@desc "Checks whether the input atom contains no variables") (@params ((@param "Atom to check"))) (@return "True if the atom contains no variables, False otherwise"))
  (@doc is-expr (@desc "Checks whether the input atom is an expression") (@params ((@param "Atom to check"))) (@return "True if the atom is an expression, False otherwise"))
  (@doc is-space (@desc "Checks whether the input atom is a space reference") (@params ((@param "Atom to check"))) (@return "True if the atom is a space reference, False otherwise"))
  (@doc get-mettatype (@desc "Returns the implementation metatype of the input atom") (@params ((@param "Atom to inspect"))) (@return "Variable, Grounded, Expression, or Symbol"))
  (@doc is-function (@desc "Checks whether the input type is a function type") (@params ((@param "Type atom"))) (@return "True if the type is a function type, False otherwise"))
  (@doc match-types (@desc "Unifies two types and returns the third argument if they unify, the fourth otherwise") (@params ((@param "First type") (@param "Second type") (@param "Returned if the types unify") (@param "Returned if the types do not unify"))) (@return "The third or fourth argument"))
  (@doc match-type-or (@desc "Unifies two types and ORs the result with a boolean") (@params ((@param "Boolean value") (@param "First type") (@param "Second type"))) (@return "True or False"))
  (@doc type-cast (@desc "Casts an atom to a type using a space as context") (@params ((@param "Atom to cast") (@param "Type to cast to") (@param "Context space"))) (@return "The atom if the cast succeeds, otherwise a BadType error"))

  ; documentation system
  (@doc @doc (@desc "Stores informal documentation for a symbol"))
  (@doc @desc (@desc "Wraps documentation text"))
  (@doc @param (@desc "Wraps a parameter description"))
  (@doc @params (@desc "Wraps the informal parameter list"))
  (@doc @return (@desc "Wraps a return description"))
  (@doc @type (@desc "Wraps a type annotation in formal documentation"))
  (@doc @item (@desc "Wraps the documented item name"))
  (@doc @kind (@desc "Wraps the documented item kind"))
  (@doc @doc-formal (@desc "Represents documentation after get-doc has attached kinds, types, params, and return info"))
  (@doc get-doc (@desc "Returns documentation for an atom or function") (@params ((@param "Atom or function name to document"))) (@return "Documentation for the atom or function"))
  (@doc get-doc-atom (@desc "Gets documentation for a non-function atom") (@params ((@param "Space to search for documentation") (@param "Atom name to document"))) (@return "Documentation for the atom"))
  (@doc get-doc-single-atom (@desc "Gets documentation for either a function or an atom, dispatching on which it is") (@params ((@param "Space to search for documentation") (@param "Atom or function name to document"))) (@return "Documentation for the atom or function"))
  (@doc get-doc-function (@desc "Gets documentation for a function, or default documentation if none exists") (@params ((@param "Space to search for documentation") (@param "Function name to document") (@param "Type notation for the function"))) (@return "Documentation for the function"))
  (@doc get-doc-params (@desc "Builds a function's parameter and return documentation, each augmented with its type") (@params ((@param "List of parameter descriptions") (@param "Return description") (@param "Type notation without the leading arrow"))) (@return "United list of parameters and return, each with its type"))
  (@doc undefined-doc-function-type (@desc "Builds a placeholder type list for a function with no type notation") (@params ((@param "List of parameters for the function"))) (@return "A list of %Undefined% types sized to the parameters"))
  (@doc help! (@desc "Prints documentation for an atom or module; with no argument prints the corelib functions") (@params ((@param "Atom or module to document"))) (@return "Unit atom"))
  (@doc help-param! (@desc "Prints a single parameter's documentation, used by help!") (@params ((@param "Parameter to print"))) (@return "Unit atom"))
  (@doc help-space! (@desc "Prints documentation for every atom in a space") (@params ((@param "Space to document"))) (@return "Unit atom"))

  ; assertions
  (@doc assertEqual (@desc "Compares the results of evaluating two expressions") (@params ((@param "First expression") (@param "Second expression"))) (@return "Unit atom if the results are equal, an error otherwise"))
  (@doc assertAlphaEqual (@desc "Compares the results of evaluating two expressions using alpha equality") (@params ((@param "First expression") (@param "Second expression"))) (@return "Unit atom if the results are alpha equal, an error otherwise"))
  (@doc assertEqualToResult (@desc "Compares the results of evaluating the first expression to the unevaluated second expression") (@params ((@param "First expression, evaluated") (@param "Second expression with the expected results, not evaluated"))) (@return "Unit atom if equal, an error otherwise"))
  (@doc assertAlphaEqualToResult (@desc "Alpha-compares the results of evaluating the first expression to the unevaluated second") (@params ((@param "First expression, evaluated") (@param "Second expression, not evaluated"))) (@return "Unit atom if alpha equal, an error otherwise"))
  (@doc assertEqualMsg (@desc "Compares the results of evaluating two expressions, returning a message on failure") (@params ((@param "First expression") (@param "Second expression") (@param "Message to return on failure"))) (@return "Unit atom if equal, the message otherwise"))
  (@doc assertAlphaEqualMsg (@desc "Alpha-compares the results of evaluating two expressions, returning a message on failure") (@params ((@param "First expression") (@param "Second expression") (@param "Message to return on failure"))) (@return "Unit atom if alpha equal, the message otherwise"))
  (@doc assertEqualToResultMsg (@desc "Compares evaluation results to an unevaluated expected value, returning a message on failure") (@params ((@param "First expression, evaluated") (@param "Second expression, not evaluated") (@param "Message to return on failure"))) (@return "Unit atom if equal, the message otherwise"))
  (@doc assertAlphaEqualToResultMsg (@desc "Alpha-compares evaluation results to an unevaluated expected value, returning a message on failure") (@params ((@param "First expression, evaluated") (@param "Second expression, not evaluated") (@param "Message to return on failure"))) (@return "Unit atom if alpha equal, the message otherwise"))
  (@doc assertIncludes (@desc "Checks that the second argument is included in the results of evaluating the first") (@params ((@param "First expression") (@param "Second expression"))) (@return "Unit atom if included, an error otherwise"))

  ; errors
  (@doc Error (@desc "Constructs an error atom") (@params ((@param "Atom that failed") (@param "Error description"))) (@return "Error atom"))
  (@doc BadType (@desc "Constructs an error description for an expected type and an actual type") (@params ((@param "Expected type") (@param "Actual type"))) (@return "BadType error description"))
  (@doc BadArgType (@desc "Constructs an error description for an argument with the wrong type") (@params ((@param "Argument position") (@param "Expected type") (@param "Actual type"))) (@return "BadArgType error description"))
  (@doc ErrorType (@desc "Type of error atoms"))
  (@doc SpaceType (@desc "Type of atomspace references"))
  (@doc ErrorDescription (@desc "Type of values that describe an error"))
  (@doc IncorrectNumberOfArguments (@desc "Error description used when a function is called with the wrong number of arguments"))

  ; modules
  (@doc import! (@desc "Imports a module by relative path, binding it to a token; &self imports into the current space") (@params ((@param "Symbol turned into the token for the imported space") (@param "Module name or relative path"))) (@return "Unit atom"))
  (@doc include (@desc "Includes a MeTTa script into the current space, like import! with &self") (@params ((@param "Name of the MeTTa script to include"))) (@return "Unit atom"))
  (@doc register-module! (@desc "Loads a module into the runner from a file system path") (@params ((@param "File system path"))) (@return "Unit atom"))
  (@doc mod-space! (@desc "Returns the space of a module, loading the module if it is not yet loaded") (@params ((@param "Module name"))) (@return "The module's space"))
  (@doc module-space-no-deps (@desc "Returns a module space without its dependencies") (@params ((@param "Module space"))) (@return "The space without its included dependencies"))
  (@doc print-mods! (@desc "Prints all modules with their corresponding spaces") (@params ()) (@return "Unit atom"))
  (@doc git-module! (@desc "Returns an error because git modules are not supported in @metta-ts") (@params ((@param "Git module URL"))) (@return "Unsupported-module error"))
`;

let evalCache: Atom[] | undefined;
let docCache: Atom[] | undefined;

/** An `(@doc name …)` documentation atom: data read by get-doc, never touched during evaluation. The
 *  `(: @doc …)` type declaration is not one of these (its head is `:`), so it stays with the eval atoms. */
function isDocAtom(atom: Atom): boolean {
  return atom.kind === "expr" && atom.items[0]?.kind === "sym" && atom.items[0].name === "@doc";
}

function ensureStdlibParsed(): { evalAtoms: Atom[]; docAtoms: Atom[] } {
  if (evalCache !== undefined && docCache !== undefined)
    return { evalAtoms: evalCache, docAtoms: docCache };
  const all = parseAll(STDLIB_SRC, standardTokenizer())
    .filter((t) => !t.bang)
    .map((t) => t.atom);
  const docAtoms = all.filter(isDocAtom);
  const evalAtoms = all.filter((atom) => !isDocAtom(atom));
  evalCache = evalAtoms;
  docCache = docAtoms;
  return { evalAtoms, docAtoms };
}

/** The standard-library evaluation atoms: type declarations and function definitions, without the @doc
 *  documentation data. Loaded by the runner into every program's space. The @doc atoms are held separately
 *  (stdlibDocAtoms) so a program that never calls get-doc does not pay to load 185 documentation atoms into
 *  its space; that load is ~+22% of the stdlib-load microbenchmark. Parsed once and cached. */
export function stdlibAtoms(): Atom[] {
  return ensureStdlibParsed().evalAtoms;
}

/** The standard-library `@doc` documentation atoms, consulted by get-doc as a fallback when a symbol is not
 *  documented in the program's own space. Kept out of the eval environment. Parsed once and cached. */
export function stdlibDocAtoms(): Atom[] {
  return ensureStdlibParsed().docAtoms;
}
