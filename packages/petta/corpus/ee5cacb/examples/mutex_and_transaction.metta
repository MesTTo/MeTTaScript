!(add-atom &temp (cnt 37))

;This only works predictable single-threaded, else there is a data race:
(= (sloppyinc)
   (match &temp (cnt $x)
          ((remove-atom &temp (cnt $x))
           (let $inc (+ $x 1)
                     (add-atom &temp (cnt $inc))))))

;To protect from data reace we can use a mutex:
(= (mutexinc)
   (with_mutex testmutex
               (match &temp (cnt $x)
                      ((remove-atom &temp (cnt $x))
                       (let $inc (+ $x 1)
                            (add-atom &temp (cnt $inc)))))))

;Additionally we support transactions, the following illlustrates that remove-atom is undone if the nondet branch fails:
(= (Transaction_rollback_fail_to_inc)
   (transaction (match &temp (cnt $x)
                       ((remove-atom &temp (cnt $x))
                        (let $inc (+ $x 1)
                             (add-atom &temp (cnt $inc)))
                        (empty)))))

;even though swipl is threadsafe and will also not deadlock, this would cause aforementioned race condition between reading and writing:
;!(hyperpose ((sloppyinc) (sloppyinc) (sloppyinc) (sloppyinc) (sloppyinc)))

;while this is fine as all places modifying the (cnt $n) relation simultaneously (mutexinc only in this case) use the same mutex:
!(hyperpose ((mutexinc) (mutexinc) (mutexinc) (mutexinc) (mutexinc)))
!(test (collapse (get-atoms &temp)) ((cnt 42)))

;This won't affect the cnt since the transaction is setup to fail:
!(Transaction_rollback_fail_to_inc)
!(test (collapse (get-atoms &temp)) ((cnt 42)))
