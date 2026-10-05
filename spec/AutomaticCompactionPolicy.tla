---------------------- MODULE AutomaticCompactionPolicy ----------------------
EXTENDS Naturals
VARIABLES mode, enabled, mirror, clm, guard, budget, window, reason, queried, early, late
vars == <<mode, enabled, mirror, clm, guard, budget, window, reason, queried, early, late>>
Policy == enabled /\ mirror /\ clm /\ reason # "manual" /\
          (mode = "off" \/ (mode = "auto" /\ reason = "threshold" /\ guard /\ (budget \/ window)))
Init == /\ mode \in {"auto", "off", "on"} /\ enabled \in BOOLEAN
        /\ mirror \in BOOLEAN /\ clm \in BOOLEAN /\ guard \in BOOLEAN
        /\ budget \in BOOLEAN /\ window \in BOOLEAN
        /\ reason \in {"manual", "threshold", "overflow"}
        /\ queried = FALSE /\ early = FALSE /\ late = FALSE
\* Configuration, navigation, model changes and mirror lifetime are read afresh.
Change == /\ queried /\ queried' = FALSE
          /\ mode' \in {"auto", "off", "on"} /\ enabled' \in BOOLEAN
          /\ mirror' \in BOOLEAN /\ clm' \in BOOLEAN /\ guard' \in BOOLEAN
          /\ budget' \in BOOLEAN /\ window' \in BOOLEAN
          /\ UNCHANGED <<reason, early, late>>
Query == /\ ~queried /\ queried' = TRUE /\ early' = Policy /\ late' = Policy
         /\ UNCHANGED <<mode, enabled, mirror, clm, guard, budget, window, reason>>
Next == Change \/ Query
Spec == Init /\ [][Next]_vars
OnePolicy == queried => early = late /\ early = Policy
ManualAvailable == queried /\ reason = "manual" => ~early
FallbackAvailable == queried /\ (~enabled \/ ~mirror \/ ~clm \/ mode = "on") => ~early
AutoOverflowAvailable == queried /\ mode = "auto" /\ reason = "overflow" => ~early
NoBudgetOrGuardFallback == queried /\ mode = "auto" /\ (~guard \/ (~budget /\ ~window)) => ~early
OffOwnsBothAutomaticReasons == queried /\ enabled /\ mirror /\ clm /\ mode = "off" /\ reason # "manual" => early
=============================================================================
