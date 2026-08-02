; SPDX-FileCopyrightText: 2026 MesTTo
;
; SPDX-License-Identifier: MIT
;
; The shape a large MeTTa codebase actually has, which the rest of this corpus does not cover: state held
; in `bind!`-named spaces rather than `&self`, rules stored as data and read back out of a space, deep
; constructor terms rather than small tuples, and a forward chainer saturating over them.
;
; Two of the other 124 examples use `bind!` at all, so the cost of carrying named handles through
; evaluation was invisible here: every term is walked once per evaluation step to substitute those
; handles, and nothing in this corpus paid for it at scale. The engine change that added a
; token-free-verdict cache is worth about 2x on a real codebase of this shape and was not measurable
; anywhere in this corpus before this example existed.
;
; What it is worth as a sentinel, measured rather than assumed: it moves 1.78s -> 1.62s (1.10x) across
; that change. It detects the path, not the magnitude — a regression smaller than about 10% here will not
; show. Term size is what carries the signal, so keep the `Const ... (Attrs ...) (Prov ...)` envelopes if
; this example is ever edited; flattening them to bare symbols drops the sensitivity to nothing.
;
; The assertions pin the derived set exactly, so a run that gets faster by deriving less fails rather
; than scores.

!(bind! &kb-facts (new-space))
!(bind! &kb-rules (new-space))
!(bind! &kb-derived (new-space))

; A rule is data in a space, the way a real codebase stores them.
(: add-rule (-> SpaceType Atom Atom Atom %Undefined%))
(= (add-rule $space $name $premise $conclusion)
   (add-atom $space (Rule $name $premise $conclusion)))

(: add-fact (-> SpaceType Atom %Undefined%))
(= (add-fact $space $fact) (add-atom $space (Fact $fact)))

; One forward pass: every rule against every known fact, adding what is new.
(: fire-rules (-> SpaceType SpaceType SpaceType %Undefined%))
(= (fire-rules $facts $rules $derived)
   (collapse
     (match $rules (Rule $name $premise $conclusion)
       (match $facts (Fact $premise)
         (add-atom-if-new $derived (Fact $conclusion))))))

(: add-atom-if-new (-> SpaceType Atom %Undefined%))
(= (add-atom-if-new $space $atom)
   (if (== () (collapse (match $space $atom $atom)))
       (add-atom $space $atom)
       ()))

(: copy-into (-> SpaceType SpaceType %Undefined%))
(= (copy-into $from $to)
   (collapse (match $from $a (add-atom-if-new $to $a))))

; Saturate: fire, fold the derived set back into the facts, repeat until nothing new appears.
(: saturate (-> SpaceType SpaceType SpaceType Number %Undefined%))
(= (saturate $facts $rules $derived $fuel)
   (if (< $fuel 1)
       (Stopped fuel)
       (let $before (size-atom (collapse (match $facts $a $a)))
         (let $_fired (fire-rules $facts $rules $derived)
           (let $_copied (copy-into $derived $facts)
             (let $after (size-atom (collapse (match $facts $a $a)))
               (if (== $before $after)
                   (Saturated $after)
                   (saturate $facts $rules $derived (- $fuel 1)))))))))

(: known (-> SpaceType Atom Bool))
(= (known $space $fact)
   (if (== () (collapse (match $space (Fact $fact) $fact))) False True))

; A transitive part-of hierarchy plus two derived properties, the everyday shape of a rule base.
!(add-rule &kb-rules inside-is-part (In $x $y) (PartOf $x $y))
!(add-rule &kb-rules part-is-located (PartOf $x $y) (Located $x))
!(add-rule &kb-rules physical-layer (Located $x) (Physical $x))
!(add-rule &kb-rules thing-layer (Physical $x) (Thing $x))
!(add-rule &kb-rules known-layer (Thing $x) (Known $x))
!(add-rule &kb-rules bounded-layer (Known $x) (Bounded $x))
!(add-rule &kb-rules countable-layer (Bounded $x) (Countable $x))
!(add-rule &kb-rules nameable-layer (Countable $x) (Nameable $x))
!(add-rule &kb-rules sortable-layer (Nameable $x) (Sortable $x))
!(add-rule &kb-rules indexed-layer (Sortable $x) (Indexed $x))

!(add-fact &kb-facts (In (Const hand entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const arm entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const arm entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const body entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const body entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const torso entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const torso entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const frame entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const frame entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const form entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const form entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const shape entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const shape entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const mass entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const leaf entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const branch entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const branch entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const limb entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const limb entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const trunk entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const trunk entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const tree entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const tree entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const grove entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const grove entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const wood entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const wood entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const forest entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const wheel entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const axle entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const axle entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const chassis entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const chassis entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const car entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const car entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const fleet entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const fleet entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const depot entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const depot entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const yard entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const yard entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const estate entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const word entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const line entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const line entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const page entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const page entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const chapter entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const chapter entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const book entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const book entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const shelf entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const shelf entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const case entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const case entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const library entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const cell entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const tissue entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const tissue entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const organ entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const organ entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const system entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const system entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const creature entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const creature entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const herd entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const herd entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const range entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const range entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const biome entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))

!(add-fact &kb-facts (In (Const bolt entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const plate entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const plate entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const panel entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const panel entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const wing entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const wing entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const craft entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const craft entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const squadron entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const squadron entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const wing-cmd entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const wing-cmd entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const force entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const note entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const bar entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const bar entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const phrase entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const phrase entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const movement entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const movement entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const suite entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const suite entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const album entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const album entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const catalog entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const catalog entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const archive entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const pixel entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const tile entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const tile entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const sprite entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const sprite entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const scene entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const scene entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const level entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const level entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const world entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const world entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const saga entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const saga entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const canon entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const grain entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const ear entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const ear entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const stalk entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const stalk entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const field entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const field entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const farm entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const farm entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const county entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const county entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const province entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const province entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const nation entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const drop entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const stream entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const stream entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const brook entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const brook entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const river entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const river entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const basin entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const basin entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const delta entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const delta entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const sea entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))
!(add-fact &kb-facts (In (Const sea entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const ocean entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check)))))))

!(test (saturate &kb-facts &kb-rules &kb-derived 24) (Saturated 770))

!(test (known &kb-facts (PartOf (Const hand entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))) (Const arm entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))))) True)
!(test (known &kb-facts (Located (Const leaf entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))))) True)
!(test (known &kb-facts (Physical (Const wheel entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))))) True)
!(test (known &kb-facts (Thing (Const page entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))))) True)
!(test (known &kb-facts (Known (Const cell entity (Attrs ((Attr solid) (Attr bounded) (Attr named))) (Prov (Source manual) (Trace ((Step read) (Step parse) (Step check))))))) True)
!(test (known &kb-facts (PartOf car wheel)) False)
