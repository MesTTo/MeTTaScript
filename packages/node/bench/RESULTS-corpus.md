# MeTTa-TS vs PeTTa — PeTTa example corpus

Wall-clock per example as a black-box subprocess (each engine's runtime startup included).
`speedup` = PeTTa / MeTTa-TS over examples both engines pass. `*` marks a non-pass run.

- examples: 107, both pass: 97, speedup median 2.03x, geomean 2.00x
- timeout 12s, runs 2 (min), MeTTa-TS --max-steps 100000000

**`matespace` / `matespace2` are PeTTa-specific, not a MeTTa-TS performance gap.** Their expected counts
(1063919, 1297533) come only from PeTTa's compilation to Prolog: native backtracking over a
globally-persistent atomspace with duplicate adds pruned by failure, which is not minimal-MeTTa semantics.
Run through `hyperon-experimental` itself, `(collapse (mate-space-demo K))` is empty, and LeaTTa agrees;
PeTTa, real Hyperon, and MeTTa-TS each compute a different result for the same program. No Hyperon-faithful
engine reproduces PeTTa's number, so these two are excluded from the speedup stats. The faithful rewrite of
the same workload, `matespacefast`, MeTTa-TS runs about 2.2x faster than PeTTa, byte-identical.

| example | PeTTa (ms) | MeTTa-TS (ms) | speedup | result |
|---|--:|--:|--:|---|
| and_or | 181 | 79 | 2.29x | pass |
| atomops | 181 | 86 | 2.11x | pass |
| builin_types | 182 | 84 | 2.18x | pass |
| callquoteevalreduce2 | 179 | 84 | 2.14x | pass |
| case | 181 | 84 | 2.16x | pass |
| case2 | 177 | 82 | 2.16x | pass |
| caseempty | 151 | 82 | 1.84x | pass |
| chain | 176 | 87 | 2.01x | pass |
| collapse | 157 | 84 | 1.86x | pass |
| comments | 179 | 82 | 2.17x | pass |
| constanthead | 179 | 82 | 2.20x | pass |
| curry | 159 | 99 | 1.60x | pass |
| cut | 162 | 85 | 1.90x | pass |
| empty | 181 | 83 | 2.17x | pass |
| eval | 178 | 92 | 1.94x | pass |
| factorial | 178 | 81 | 2.20x | pass |
| fib | 445 | 88 | 5.08x | pass |
| fibadd | 455 | 89 | 5.14x | pass |
| fibsmart | 182 | 85 | 2.14x | pass |
| fibsmartimport | 179 | 95 | 1.88x | pass |
| foldall | 182 | 105 | 1.74x | pass |
| foldallmatch | 177 | 90 | 1.97x | pass |
| foldallspacecount | 176 | 86 | 2.05x | pass |
| forall | 151 | 107 | 1.41x | pass |
| functiontypes | 160 | 86 | 1.86x | pass |
| greedy_chess | 12092\* (timeout) | 1675\* (ran) | - | timeout/ran |
| he_assert | 163 | 86 | 1.89x | pass |
| he_atomspace | 154 | 83 | 1.85x | pass |
| he_equalreduct | 169 | 80 | 2.10x | pass |
| he_error | 174 | 85 | 2.05x | pass |
| he_evaluation | 158 | 87 | 1.81x | pass |
| he_math | 181 | 92 | 1.97x | pass |
| he_minimalmetta | 1784 | 481 | 3.71x | pass |
| he_quoting | 182 | 83 | 2.20x | pass |
| he_types | 183 | 84 | 2.17x | pass |
| holfunctions | 180 | 96 | 1.88x | pass |
| hyperpose_primes | 1117 | 1043 | 1.07x | pass |
| identity | 182 | 82 | 2.23x | pass |
| if | 186 | 85 | 2.19x | pass |
| if2 | 180 | 83 | 2.17x | pass |
| if3 | 206 | 152 | 1.36x | pass |
| if4 | 259 | 100 | 2.60x | pass |
| ifcasenondet | 189 | 92 | 2.05x | pass |
| is_alpha_member_test | 177 | 96 | 1.84x | pass |
| iter | 178 | 89 | 2.00x | pass |
| lambda | 190 | 146 | 1.30x | pass |
| let_superpose_if_case | 200 | 124 | 1.61x | pass |
| letext | 192 | 139 | 1.38x | pass |
| letlet | 173 | 86 | 2.00x | pass |
| letstar | 167 | 86 | 1.95x | pass |
| listhead | 177 | 83 | 2.14x | pass |
| matchnested | 182 | 91 | 2.01x | pass |
| matchnested2 | 178 | 87 | 2.05x | pass |
| matchsingle | 158 | 86 | 1.84x | pass |
| matchtypes | 181 | 85 | 2.13x | pass |
| matespace | 3945 | 12042\* (timeout) | - | pass/timeout |
| matespace2 | 5621 | 12051\* (timeout) | - | pass/timeout |
| matespacefast | 4280 | 1950 | 2.20x | pass |
| math | 179 | 86 | 2.08x | pass |
| meta_types | 179 | 82 | 2.19x | pass |
| metta4_prog | 180 | 83 | 2.17x | pass |
| multicall | 175 | 90 | 1.95x | pass |
| multiset_operations | 165 | 86 | 1.92x | pass |
| mutex_and_transaction | 170 | 90 | 1.89x | pass |
| myinterpreter | 156 | 84 | 1.85x | pass |
| nars_direct | 195 | 86\* (fail) | - | pass/fail |
| nars_tuffy | 259 | 264\* (fail) | - | pass/fail |
| nilbc | 768 | 2125 | 0.36x | pass |
| once | 172 | 85 | 2.03x | pass |
| parametric_types | 181 | 83 | 2.17x | pass |
| parse | 175 | 82 | 2.13x | pass |
| patrick_iterate_fib | 181 | 106 | 1.71x | pass |
| patrick_iterate_quad | 401 | 152 | 2.64x | pass |
| peano | 1605 | 2483 | 0.65x | pass |
| peanofast | 537 | 93 | 5.78x | pass |
| permutations | 850 | 431 | 1.97x | pass |
| pln_direct | 197 | 82\* (fail) | - | pass/fail |
| pln_roman | 228 | 135\* (fail) | - | pass/fail |
| pln_tuffy | 200 | 306\* (fail) | - | pass/fail |
| plntest | 165 | 90 | 1.83x | pass |
| plntestdirect | 178 | 294\* (ran) | - | pass/ran |
| recursive_types | 177 | 84 | 2.10x | pass |
| recursive_types2 | 178 | 88 | 2.02x | pass |
| repr | 157 | 81 | 1.94x | pass |
| selfprog | 177 | 83\* (fail) | - | pass/fail |
| smartdispatch | 180 | 86 | 2.10x | pass |
| spacefunction | 164 | 84 | 1.95x | pass |
| spaces | 178 | 84 | 2.11x | pass |
| spaces2 | 177 | 86 | 2.06x | pass |
| spaces3 | 215 | 118 | 1.82x | pass |
| specializecyclic | 157 | 88 | 1.79x | pass |
| state | 171 | 83 | 2.07x | pass |
| streamops | 169 | 87 | 1.95x | pass |
| string | 183 | 79 | 2.31x | pass |
| supercollapse | 169 | 86 | 1.95x | pass |
| superpose_nested | 167 | 85 | 1.97x | pass |
| superpose_primes | 186 | 91 | 2.03x | pass |
| tabling_fib | 178 | 82 | 2.18x | pass |
| test_alpha_unique_atom | 166 | 91 | 1.83x | pass |
| test_string_comments | 179 | 88 | 2.04x | pass |
| tests | 159 | 92 | 1.73x | pass |
| tilepuzzle | 1573 | 388 | 4.05x | pass |
| translatorrule_fib | 170 | 83 | 2.05x | pass |
| twostage | 163 | 79 | 2.06x | pass |
| types | 176 | 88 | 2.00x | pass |
| types_dependent | 175 | 84 | 2.08x | pass |
| xor | 182 | 82 | 2.21x | pass |
