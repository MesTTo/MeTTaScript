# MeTTa-TS vs PeTTa — PeTTa example corpus

Wall-clock per example as a black-box subprocess (each engine's runtime startup included).
`speedup` = PeTTa / MeTTa-TS over examples both engines pass. `*` marks a non-pass run.

- examples: 105, both pass: 98, speedup median 1.63x, geomean 1.69x
- timeout 60s, runs 3 (min), MeTTa-TS --max-steps 100000000

| example                |        PeTTa (ms) | MeTTa-TS (ms) | speedup | result      |
| ---------------------- | ----------------: | ------------: | ------: | ----------- |
| and_or                 |               185 |            92 |   2.02x | pass        |
| atomops                |               180 |            99 |   1.81x | pass        |
| builin_types           |               167 |            91 |   1.85x | pass        |
| callquoteevalreduce2   |               144 |           102 |   1.41x | pass        |
| case                   |               174 |           117 |   1.49x | pass        |
| case2                  |               152 |            98 |   1.55x | pass        |
| caseempty              |               155 |            94 |   1.66x | pass        |
| chain                  |               159 |            91 |   1.75x | pass        |
| collapse               |               173 |            92 |   1.89x | pass        |
| comments               |               174 |            89 |   1.96x | pass        |
| constanthead           |               173 |            97 |   1.78x | pass        |
| curry                  |               165 |           116 |   1.43x | pass        |
| cut                    |               168 |           101 |   1.66x | pass        |
| empty                  |               178 |            96 |   1.86x | pass        |
| eval                   |               151 |           116 |   1.30x | pass        |
| factorial              |               162 |           144 |   1.12x | pass        |
| fib                    |               486 |            98 |   4.99x | pass        |
| fibadd                 |               471 |           107 |   4.39x | pass        |
| fibsmart               |               155 |           100 |   1.55x | pass        |
| fibsmartimport         |               184 |           101 |   1.81x | pass        |
| foldall                |               162 |           126 |   1.29x | pass        |
| foldallmatch           |               145 |           109 |   1.33x | pass        |
| foldallspacecount      |               151 |           108 |   1.40x | pass        |
| forall                 |               178 |           132 |   1.35x | pass        |
| functiontypes          |               174 |            95 |   1.83x | pass        |
| greedy_chess           | 15968\* (timeout) |  2084\* (ran) |       - | timeout/ran |
| he_assert              |               163 |            97 |   1.68x | pass        |
| he_atomspace           |               151 |            93 |   1.62x | pass        |
| he_equalreduct         |               181 |            94 |   1.92x | pass        |
| he_error               |               183 |            93 |   1.97x | pass        |
| he_evaluation          |               173 |           104 |   1.66x | pass        |
| he_math                |               183 |            98 |   1.85x | pass        |
| he_minimalmetta        |              1843 |          1272 |   1.45x | pass        |
| he_quoting             |               193 |           117 |   1.65x | pass        |
| he_types               |               181 |           109 |   1.67x | pass        |
| holfunctions           |               174 |           119 |   1.46x | pass        |
| hyperpose_primes       |              1165 |          1107 |   1.05x | pass        |
| identity               |               167 |           104 |   1.61x | pass        |
| if                     |               158 |           104 |   1.52x | pass        |
| if2                    |               162 |           100 |   1.63x | pass        |
| if3                    |               167 |           104 |   1.60x | pass        |
| if4                    |               163 |            99 |   1.64x | pass        |
| ifcasenondet           |               164 |           122 |   1.35x | pass        |
| is_alpha_member_test   |               170 |           118 |   1.44x | pass        |
| iter                   |               161 |           126 |   1.28x | pass        |
| lambda                 |               168 |           138 |   1.22x | pass        |
| let_superpose_if_case  |               180 |           122 |   1.47x | pass        |
| letext                 |               182 |           103 |   1.77x | pass        |
| letlet                 |               184 |           107 |   1.72x | pass        |
| letstar                |               162 |           103 |   1.57x | pass        |
| listhead               |               156 |           106 |   1.48x | pass        |
| matchnested            |               186 |           114 |   1.63x | pass        |
| matchnested2           |               185 |           120 |   1.54x | pass        |
| matchsingle            |               194 |           109 |   1.77x | pass        |
| matchtypes             |               187 |           107 |   1.74x | pass        |
| matespacefast          |              4603 |          3701 |   1.24x | pass        |
| math                   |               187 |           117 |   1.60x | pass        |
| meta_types             |               181 |           115 |   1.57x | pass        |
| metta4_prog            |               153 |           108 |   1.42x | pass        |
| multicall              |               153 |           114 |   1.35x | pass        |
| multiset_operations    |               166 |           100 |   1.66x | pass        |
| mutex_and_transaction  |               164 |           112 |   1.47x | pass        |
| myinterpreter          |               165 |           110 |   1.50x | pass        |
| nars_direct            |               166 |  102\* (fail) |       - | pass/fail   |
| nars_tuffy             |               242 |  108\* (fail) |       - | pass/fail   |
| nilbc                  |               773 |           748 |   1.03x | pass        |
| once                   |               152 |            95 |   1.61x | pass        |
| parametric_types       |               173 |            95 |   1.83x | pass        |
| parse                  |               177 |            90 |   1.96x | pass        |
| patrick_iterate_fib    |               178 |            93 |   1.92x | pass        |
| patrick_iterate_quad   |               338 |           167 |   2.03x | pass        |
| peano                  |              1645 |           304 |   5.41x | pass        |
| peanofast              |               571 |           134 |   4.25x | pass        |
| permutations           |               899 |           614 |   1.46x | pass        |
| pln_direct             |               194 |  100\* (fail) |       - | pass/fail   |
| pln_roman              |               208 |  108\* (fail) |       - | pass/fail   |
| pln_tuffy              |               204 |  116\* (fail) |       - | pass/fail   |
| plntest                |               155 |           104 |   1.49x | pass        |
| plntestdirect          |               178 |   358\* (ran) |       - | pass/ran    |
| recursive_types        |               156 |            99 |   1.58x | pass        |
| recursive_types2       |               161 |            98 |   1.63x | pass        |
| repr                   |               172 |            92 |   1.88x | pass        |
| selfprog               |               176 |            98 |   1.81x | pass        |
| smartdispatch          |               155 |           104 |   1.49x | pass        |
| spacefunction          |               149 |            96 |   1.55x | pass        |
| spaces                 |               149 |           103 |   1.45x | pass        |
| spaces2                |               154 |            97 |   1.59x | pass        |
| spaces3                |               174 |            98 |   1.78x | pass        |
| specializecyclic       |               176 |            99 |   1.78x | pass        |
| state                  |               174 |            91 |   1.91x | pass        |
| streamops              |               149 |            99 |   1.50x | pass        |
| string                 |               177 |            87 |   2.05x | pass        |
| supercollapse          |               177 |            97 |   1.83x | pass        |
| superpose_nested       |               177 |           103 |   1.72x | pass        |
| superpose_primes       |               153 |           104 |   1.47x | pass        |
| tabling_fib            |               178 |            95 |   1.87x | pass        |
| test_alpha_unique_atom |               169 |           105 |   1.62x | pass        |
| test_string_comments   |               168 |            96 |   1.75x | pass        |
| tests                  |               174 |           110 |   1.58x | pass        |
| tilepuzzle             |              1603 |           415 |   3.86x | pass        |
| translatorrule_fib     |               165 |            96 |   1.72x | pass        |
| twostage               |               153 |            95 |   1.61x | pass        |
| types                  |               180 |            96 |   1.87x | pass        |
| types_dependent        |               167 |           102 |   1.64x | pass        |
| xor                    |               173 |           102 |   1.69x | pass        |
