; eval compiles an anonymous function that arrives as data, and yields each result once.
(stored-call ((|-> ($y) (* $y 10)) 2))
!(test (collapse (match &self (stored-call $e) (eval $e))) (20))
(stored-fn (|-> ($y) (- $y 1)))
!(test (collapse (match &self (stored-fn $f) ((eval $f) 5))) (4))
!(test (collapse (eval ((|-> ($x) ((|-> ($y) (* $y 2)) $x)) 5))) (10))

; foldall wraps a match generator in an anonymous function, so evaluating one as data takes the same path.
(weight 1)
(weight 2)
!(test (collapse (eval (foldall + (match &self (weight $w) $w) 0))) (3))
