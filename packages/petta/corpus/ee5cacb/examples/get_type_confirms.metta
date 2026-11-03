; Confirm %Undefined% only when it is a candidate or no type exists.
!(test (get-type 42) Number)
!(test (get-type foo) %Undefined%)
!(test (collapse (let %Undefined% (get-type 42) wrong)) ())
!(test (collapse (let %Undefined% (get-type "s") wrong)) ())

; A failed confirmation must not erase the types an atom actually has.
(: k A)
(: k B)
!(test (collapse (get-type k)) (A B))
!(test (collapse (let A (get-type k) found)) (found))
!(test (collapse (let C (get-type k) wrong)) ())
!(test (collapse (let %Undefined% (get-type k) wrong)) ())

; A requested type must not bypass the intrinsic kind's commitment.
(: 42 Shadow)
(: "s" Shadow)
(: True Shadow)
(: False Shadow)
!(test (collapse (let Shadow (get-type 42) wrong)) ())
!(test (collapse (let Shadow (get-type "s") wrong)) ())
!(test (collapse (let Shadow (get-type True) wrong)) ())
!(test (collapse (let Shadow (get-type False) wrong)) ())

; A parameter declared %Undefined% accepts an argument of any type, as in typed calls.
(: undefined-param (-> %Undefined% B))
(: typed-arg A)
!(test (get-type (undefined-param typed-arg)) B)
!(test (get-type (undefined-param 42)) B)
!(test (get-type (undefined-param untyped-arg)) B)
; A type variable bound to %Undefined% by the request is not such a parameter.
(: identity-type (-> $t $t))
!(test (collapse (let %Undefined% (get-type (identity-type 42)) wrong)) ())

; Confirming %Undefined% keeps every binding the value's types allow.
(: undefined-result (-> A %Undefined%))
(: (typed-pattern a) A)
(: (typed-pattern b) A)
!(test (collapse (let %Undefined% (get-type (undefined-result (typed-pattern $x))) $x)) (a b))

; An unbound request takes each type before it is bound, even when it occurs in the value.
(: to-a (-> Number A))
!(test (collapse (let $x (get-type (to-a $x)) $x)) (A))
