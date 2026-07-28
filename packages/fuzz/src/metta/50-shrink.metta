; SPDX-FileCopyrightText: 2026 MesTTo
;
; SPDX-License-Identifier: MIT

; List edits used by collection and child shrink passes.
(= (_fuzz-list-take-loop $values $remaining $reversed)
   (if (or (<= $remaining 0) (== $values ()))
       (reverse $reversed)
       (let* ((($value $tail) (decons-atom $values)))
         (_fuzz-list-take-loop
           $tail
           (- $remaining 1)
           (cons-atom $value $reversed)))))

(= (_fuzz-list-take $values $count)
   (_fuzz-list-take-loop $values $count ()))

(= (_fuzz-list-drop $values $count)
   (if (or (<= $count 0) (== $values ()))
       $values
       (let* ((($value $tail) (decons-atom $values)))
         (_fuzz-list-drop $tail (- $count 1)))))

(= (_fuzz-list-remove-range $values $start $count)
   (append
     (_fuzz-list-take $values $start)
     (_fuzz-list-drop $values (+ $start $count))))

(= (_fuzz-add-shrink-value $candidate $current $values)
   (if (or
         (== $candidate $current)
         (is-member $candidate $values))
       $values
       (append $values (cons-atom $candidate ()))))

(= (_fuzz-halves $value)
   (if (<= $value 0)
       ()
       (let $next (trunc-math (/ $value 2))
         (cons-atom $value (_fuzz-halves $next)))))

(= (_fuzz-int-midpoint-values
     $current
     $direction
     $halves
     $values)
   (if (== $halves ())
       $values
       (let* ((($half $tail) (decons-atom $halves))
              ($candidate
               (- $current (* $direction $half)))
              ($next
               (_fuzz-add-shrink-value
                 $candidate
                 $current
                 $values)))
         (_fuzz-int-midpoint-values
           $current
           $direction
           $tail
           $next))))

(= (_fuzz-int-value-candidates $current $lower $upper $origin)
   (if (== $current $origin)
       ()
       (let* (($distance (abs-math (- $current $origin)))
              ($direction (if (> $current $origin) 1 -1))
              ($first-half (trunc-math (/ $distance 2)))
              ($with-origin
               (_fuzz-add-shrink-value
                 $origin
                 $current
                 ()))
              ($with-midpoints
               (_fuzz-int-midpoint-values
                 $current
                 $direction
                 (_fuzz-halves $first-half)
                 $with-origin))
              ($with-lower
               (_fuzz-add-shrink-value
                 $lower
                 $current
                 $with-midpoints)))
         (_fuzz-add-shrink-value
           $upper
           $current
           $with-lower))))

(= (_fuzz-int-decision-candidates-loop
     $values
     $lower
     $upper
     $origin
     $reversed)
   (if (== $values ())
       (reverse $reversed)
       (let* ((($value $tail) (decons-atom $values)))
         (_fuzz-int-decision-candidates-loop
           $tail
           $lower
           $upper
           $origin
           (cons-atom
             (_fuzz-int-decision
               $lower
               $upper
               $origin
               $value)
             $reversed)))))

(= (_fuzz-int-decision-candidates $decision)
   (switch $decision
     (((Decision
        Int
        (Bounds $lower $upper)
        (Origin $origin)
        (Value $current)
        ())
       (_fuzz-int-decision-candidates-loop
         (_fuzz-int-value-candidates
           $current
           $lower
           $upper
           $origin)
         $lower
         $upper
         $origin
         ()))
      ($bad ()))))

(= (_fuzz-wrap-first-child-candidates
     $kind
     $metadata
     $selection
     $candidates
     $tail
     $reversed)
   (if (== $candidates ())
       (reverse $reversed)
       (let* ((($candidate $rest) (decons-atom $candidates))
              ($children (cons-atom $candidate $tail)))
         (_fuzz-wrap-first-child-candidates
           $kind
           $metadata
           $selection
           $rest
           $tail
           (cons-atom
             (Decision
               $kind
               $metadata
               $selection
               $children)
             $reversed)))))

(= (_fuzz-choice-root-candidates $decision)
   (switch $decision
     (((Decision $kind $metadata $selection $children)
       (if (or
             (== $kind Bool)
             (or
               (== $kind Element)
               (or
                 (== $kind Frequency)
                 (== $kind Option))))
           (if (== $children ())
               ()
               (let* ((($choice $tail) (decons-atom $children)))
                 (_fuzz-wrap-first-child-candidates
                   $kind
                   $metadata
                   $selection
                   (_fuzz-int-decision-candidates $choice)
                   $tail
                   ())))
           ()))
      ($bad ()))))

; Lists remove the largest legal chunks first, then smaller chunks.
(= (_fuzz-list-removal-candidates-at
     $minimum
     $maximum
     $length
     $length-lower
     $length-upper
     $length-origin
     $items
     $chunk
     $start
     $reversed)
   (if (>= $start $length)
       (reverse $reversed)
       (let* (($available (- $length $start))
              ($removed (min $chunk $available))
              ($new-length (- $length $removed))
              ($remaining
               (_fuzz-list-remove-range
                 $items
                 $start
                 $removed))
              ($next-start (+ $start $chunk)))
         (if (< $new-length $minimum)
             (_fuzz-list-removal-candidates-at
               $minimum
               $maximum
               $length
               $length-lower
               $length-upper
               $length-origin
               $items
               $chunk
               $next-start
               $reversed)
             (let* (($length-decision
                      (_fuzz-int-decision
                        $length-lower
                        $length-upper
                        $length-origin
                        $new-length))
                    ($children
                      (cons-atom
                        $length-decision
                        $remaining))
                    ($candidate
                      (Decision
                        List
                        (Bounds $minimum $maximum)
                        (Length $new-length)
                        $children)))
               (_fuzz-list-removal-candidates-at
                 $minimum
                 $maximum
                 $length
                 $length-lower
                 $length-upper
                 $length-origin
                 $items
                 $chunk
                 $next-start
                 (cons-atom $candidate $reversed)))))))

(= (_fuzz-list-removal-candidates-sizes
     $minimum
     $maximum
     $length
     $length-lower
     $length-upper
     $length-origin
     $items
     $sizes
     $candidates)
   (if (== $sizes ())
       $candidates
       (let* ((($chunk $tail) (decons-atom $sizes))
              ($for-size
               (_fuzz-list-removal-candidates-at
                 $minimum
                 $maximum
                 $length
                 $length-lower
                 $length-upper
                 $length-origin
                 $items
                 $chunk
                 0
                 ())))
         (_fuzz-list-removal-candidates-sizes
           $minimum
           $maximum
           $length
           $length-lower
           $length-upper
           $length-origin
           $items
           $tail
           (append $candidates $for-size)))))

(= (_fuzz-list-root-candidates $decision)
   (switch $decision
     (((Decision
        List
        (Bounds $minimum $maximum)
        (Length $length)
        $children)
       (if (== $children ())
           ()
           (let* ((($length-decision $items)
                    (decons-atom $children)))
             (switch $length-decision
               (((Decision
                  Int
                  (Bounds $length-lower $length-upper)
                  (Origin $length-origin)
                  (Value $seen-length)
                  ())
                 (if (and
                       (== $length $seen-length)
                       (> $length $minimum))
                     (_fuzz-list-removal-candidates-sizes
                       $minimum
                       $maximum
                       $length
                       $length-lower
                       $length-upper
                       $length-origin
                       $items
                       (_fuzz-halves (- $length $minimum))
                       ())
                     ()))
      ($bad ()))))))
      ($bad ()))))

(= (_fuzz-generic-removal-candidates-at
     $kind
     $metadata
     $selection
     $children
     $length
     $chunk
     $start
     $reversed)
   (if (>= $start $length)
       (reverse $reversed)
       (let* (($available (- $length $start))
              ($removed (min $chunk $available))
              ($remaining
               (_fuzz-list-remove-range
                 $children
                 $start
                 $removed))
              ($candidate
               (Decision
                 $kind
                 $metadata
                 $selection
                 $remaining)))
         (_fuzz-generic-removal-candidates-at
           $kind
           $metadata
           $selection
           $children
           $length
           $chunk
           (+ $start $chunk)
           (cons-atom $candidate $reversed)))))

(= (_fuzz-generic-removal-candidates-sizes
     $kind
     $metadata
     $selection
     $children
     $length
     $sizes
     $candidates)
   (if (== $sizes ())
       $candidates
       (let* ((($chunk $tail) (decons-atom $sizes))
              ($for-size
               (_fuzz-generic-removal-candidates-at
                 $kind
                 $metadata
                 $selection
                 $children
                 $length
                 $chunk
                 0
                 ())))
         (_fuzz-generic-removal-candidates-sizes
           $kind
           $metadata
           $selection
           $children
           $length
           $tail
           (append $candidates $for-size)))))

(= (_fuzz-collection-root-candidates $decision)
   (let $lists (_fuzz-list-root-candidates $decision)
     (if (== $lists ())
         (switch $decision
           (((Decision
              Filter
              $metadata
              $selection
              $children)
             (let $count (length $children)
               (if (> $count 0)
                   (_fuzz-generic-removal-candidates-sizes
                     Filter
                     $metadata
                     $selection
                     $children
                     $count
                     (_fuzz-halves $count)
                     ())
                   ())))
            ((Decision
              Recursive
              $metadata
              $selection
              $children)
             (if (> (length $children) 0)
                 (cons-atom
                   (Decision
                     Recursive
                     $metadata
                     $selection
                     ())
                   ())
                 ()))
            ($bad ())))
         $lists)))

(= (_fuzz-numeric-root-candidates $decision)
   (_fuzz-int-decision-candidates $decision))

(= (_fuzz-wrap-child-candidates
     $kind
     $metadata
     $selection
     $prefix
     $tail
     $candidates
     $reversed)
   (if (== $candidates ())
       (reverse $reversed)
       (let* ((($candidate $rest)
                (decons-atom $candidates))
              ($children
               (append
                 $prefix
                 (cons-atom $candidate $tail))))
         (_fuzz-wrap-child-candidates
           $kind
           $metadata
           $selection
           $prefix
           $tail
           $rest
           (cons-atom
             (Decision
               $kind
               $metadata
               $selection
               $children)
             $reversed)))))

(= (_fuzz-child-shrink-candidates-loop
     $kind
     $metadata
     $selection
     $remaining
     $prefix
     $candidates)
   (if (== $remaining ())
       $candidates
       (let ($child $tail) (decons-atom $remaining)
         (let $root-candidates
               (_fuzz-built-in-root-candidates $child)
           (let $nested-candidates
                 (switch $child
                   (((Decision
                      $child-kind
                      $child-metadata
                      $child-selection
                      $child-children)
                     (_fuzz-child-shrink-candidates-loop
                       $child-kind
                       $child-metadata
                       $child-selection
                       $child-children
                       ()
                       ()))
                    ($bad ())))
             (let $custom-candidates
                   (_fuzz-custom-root-candidates $child)
               (let $child-candidates
                     (_fuzz-deduplicate-trees
                       (append
                         $root-candidates
                         (append
                           $nested-candidates
                           $custom-candidates)))
                 (let $wrapped
                       (_fuzz-wrap-child-candidates
                         $kind
                         $metadata
                         $selection
                         $prefix
                         $tail
                         $child-candidates
                         ())
                   (_fuzz-child-shrink-candidates-loop
                     $kind
                     $metadata
                     $selection
                     $tail
                     (append
                       $prefix
                       (cons-atom $child ()))
                     (append $candidates $wrapped))))))))))

(= (_fuzz-child-shrink-candidates $decision)
   (switch $decision
     (((Decision $kind $metadata $selection $children)
       (_fuzz-child-shrink-candidates-loop
         $kind
         $metadata
         $selection
         $children
         ()
         ()))
      ($bad ()))))

(= (_fuzz-valid-custom-shrink-candidates
     $results
     $request
     $candidates)
   (if (== $results ())
       $candidates
       (let* ((($result $tail) (decons-atom $results))
              ($next
               (switch $result
                 ((($request) $candidates)
                  ((Decision
                     $kind
                     $metadata
                     $selection
                     $children)
                   (append
                     $candidates
                     (cons-atom $result ())))
                  ($bad $candidates)))))
         (_fuzz-valid-custom-shrink-candidates
           $tail
           $request
           $next))))

(= (_fuzz-custom-root-candidates $decision)
   (switch $decision
     (((Decision
        Custom
        (CustomGenerator
          (Name $name)
          (Arguments $arguments))
        $selection
        $children)
       (let* (($request
                (ShrinkChoices
                  $name
                  $arguments
                  $decision))
              ($results (collapse $request)))
         (_fuzz-valid-custom-shrink-candidates
           $results
           $request
           ())))
      ($bad ()))))

(= (_fuzz-deduplicate-trees $trees)
   (_fuzz-deduplicate-exact $trees))

(= (_fuzz-built-in-root-candidates $decision)
   (let $collections
         (_fuzz-collection-root-candidates $decision)
     (let $choices
           (_fuzz-choice-root-candidates $decision)
       (let $numeric
             (_fuzz-numeric-root-candidates $decision)
         (append
           $collections
           (append $choices $numeric))))))

; The output order is the public shrink relation.
(= (_fuzz-shrink-candidates $decision)
   (switch $decision
     (((Decision $kind $metadata $selection $children)
       (let $root-candidates
             (_fuzz-built-in-root-candidates $decision)
         (let $child-candidates
               (_fuzz-child-shrink-candidates $decision)
           (let $custom-candidates
                 (_fuzz-custom-root-candidates $decision)
             (_fuzz-deduplicate-trees
               (append
                 $root-candidates
                 (append
                   $child-candidates
                   $custom-candidates)))))))
      ($bad ()))))
