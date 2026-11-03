; tests for alpha-unique-atom 

; 1 Basic duplicates with different variables
!(test (=alpha (alpha-unique-atom ((link $x human) (link $y human) (link $z human)))
               ((link $a human)))
       True)

!(test (=alpha (alpha-unique-atom ((parent $x human) (parent $y human) (child $z human)))
               ((parent $a human) (child $b human)))
       True)

; 2 Different functors
!(test (=alpha (alpha-unique-atom ((parent $x human) (child $y human) (friend $z human)))
               ((parent $a human) (child $b human) (friend $c human)))
       True)

!(test (=alpha (alpha-unique-atom ((likes $x) (hates $y) (knows $z)))
               ((likes $a) (hates $b) (knows $c)))
       True)

; 3 Nested structures
!(test (=alpha (alpha-unique-atom ((link (foo $x) human) (link (foo $y) human) (link (bar $z) human)))
               ((link (foo $a) human) (link (bar $b) human)))
       True)

!(test (=alpha (alpha-unique-atom ((parent (child $x) human) (parent (child $y) human) (parent (child $x) human)))
               ((parent (child $a) human)))
       True)

; 4 Mix of unique and duplicates
!(test (=alpha (alpha-unique-atom ((link $x human) (parent $x human) (link $y human) (parent $z human) (link $x human)))
               ((link $a human) (parent $a human)))
       True)

!(test (=alpha (alpha-unique-atom ((foo $x) (foo $y) (bar $x) (foo $x) (bar $y)))
               ((foo $a) (bar $a)))
       True)

; 5 Numbers and atoms
!(test (=alpha (alpha-unique-atom (1 2 2 3 1 4 4 5))
               (1 2 3 4 5))
       True)

!(test (=alpha (alpha-unique-atom (a b a c b d e a))
               (a b c d e))
       True)

; 6 Empty and single-element lists
!(test (=alpha (alpha-unique-atom ())
               ())
       True)

!(test (=alpha (alpha-unique-atom (1))
               (1))
       True)

!(test (=alpha (alpha-unique-atom ((link $x human)))
               ((link $a human)))
       True)

!(test (=alpha (alpha-unique-atom ($x))
               ($a))
       True)

!(test (=alpha (alpha-unique-atom (() ()))
               (()))
       True)

; 7 Repeated variables vs distinct variables
!(test (=alpha (alpha-unique-atom ((f $x $x) (f $a $b) (f $y $y) (f $c $d)))
               ((f $u $u) (f $v $w)))
       True)

; 8 Constants vs variables
!(test (=alpha (alpha-unique-atom ((f 1) (f $x) (f 1) (f $y)))
               ((f 1) (f $a)))
       True)

; 9 Deeply nested structures with variables
!(test (=alpha (alpha-unique-atom ((f (g (h $x))) (f (g (h $y))) (f (g (h 1)))))
               ((f (g (h $a))) (f (g (h 1)))))
       True)

; 10 Mixed atoms, numbers, and expressions
!(test (=alpha (alpha-unique-atom (5 5 (5) (5) (link $x) (link $y)))
               (5 (5) (link $a)))
       True)

; 11 Natural collision in 24-bit term_hash (reproduced data loss in old code)
!(test (=alpha (alpha-unique-atom ((item 1253) (item 1563)))
               ((item 1253) (item 1563)))
       True)

; 12 Natural collision in variant_hash forcing the bucket-collision path
; (item 817 $x) and (item 5406 $y) both produce variant_hash = 14145683
!(test (=alpha (alpha-unique-atom ((item 817 $x) (item 5406 $y) (item 817 $z)))
               ((item 817 $a) (item 5406 $b)))
       True)

; 13 Typed/typechecked function ensuring attributed variables pass through cleanly
(: typed-unique (-> Number Symbol (List Atom)))
(= (typed-unique $n $s) (alpha-unique-atom ((pair $n $s) (pair $n $s) (pair 1 a))))
!(test (=alpha (typed-unique 1 a)
               ((pair 1 a)))
       True)


