
  (: empty-queue (-> Expression))
  (: enqueue (-> Atom Expression Expression))
  (: dequeue (-> Expression Expression))
  (: add-unique-or-fail (-> Grounded Atom %Undefined%))

  (@doc empty-queue
    (@desc "The empty queue: two empty stacks and a zero count")
    (@params ())
    (@return "A queue (queue () () 0) holding no elements"))
  (= (empty-queue) (queue () () 0))

  (@doc enqueue
    (@desc "Add an element to the back of the queue in amortized O(1) by pushing it onto the in-stack")
    (@params ((@param "Element to add") (@param "Queue")))
    (@return "The queue with the element appended at the back"))
  (= (enqueue $e $q)
     (let (queue $in $out $n) $q
       (queue (cons-atom $e $in) $out (+ $n 1))))

  (@doc dequeue
    (@desc "Remove the front element and return it paired with the rest of the queue. When the out-stack is empty it first reverses the in-stack onto the out-stack, the amortized step. Yields nothing on an empty queue")
    (@params ((@param "Queue")))
    (@return "(Pair <front element> <rest of the queue>), or no result when the queue is empty"))
  (= (dequeue $q)
     (let (queue $in $out $n) $q
       (if (== $out ())
           (if (== $in ())
               (empty)
               (let* (($rev (reverse $in)) (($h $t) (decons-atom $rev)))
                 (Pair $h (queue () $t (- $n 1)))))
           (let* ((($h $t) (decons-atom $out)))
             (Pair $h (queue $in $t (- $n 1)))))))

  (@doc add-unique-or-fail
    (@desc "Intern (s <repr of the expression>) into the space only if no equal key is already present, otherwise yield nothing. A fast set insertion keyed on the atom's textual form")
    (@params ((@param "Space") (@param "Expression to intern as a key")))
    (@return "The add-atom result when newly inserted, or no result when the key already exists"))
  (= (add-unique-or-fail $space $expression)
     (let $st (s (repr $expression))
       (if (== () (collapse (once (match $space $st True))))
           (add-atom $space $st)
           (empty))))
