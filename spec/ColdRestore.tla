--------------------------- MODULE ColdRestore ---------------------------
EXTENDS Integers, Sequences, FiniteSets, TLC
CONSTANTS BadEagerHistory, BadExpiredRead
VARIABLES source, generation, planGeneration, planValues, hydrated, values, expected
vars == <<source, generation, planGeneration, planValues, hydrated, values, expected>>
Ids == {"active", "history"}
Init == /\ source = [id \in Ids |-> "A"] /\ generation = 0
        /\ planGeneration = -1 /\ planValues = source /\ hydrated = {}
        /\ values = <<>> /\ expected = <<>>
\* The oracle planValues is specification-only: runtime descriptors retain metadata,
\* not these payloads. The latest valid state/current checkpoint is genuine working
\* state; candidate historical records are validated only on an explicit read.
Restore == /\ planGeneration' = generation /\ planValues' = source
           /\ hydrated' = IF BadEagerHistory THEN Ids ELSE {"active"}
           /\ UNCHANGED <<source, generation, values, expected>>
ReadHistory == /\ Len(values) < 3 /\ planGeneration >= 0
               /\ (BadExpiredRead \/ planGeneration = generation)
               /\ values' = Append(values, source["history"])
               /\ expected' = Append(expected, planValues["history"])
               /\ UNCHANGED <<source, generation, planGeneration, planValues, hydrated>>
\* Reload/rewrite can replace bytes at the same source identity. Already captured
\* values remain immutable; an unread locator must reject instead of rebinding.
Overwrite == /\ generation < 2 /\ generation' = generation + 1
             /\ source' = [id \in Ids |-> IF source[id] = "A" THEN "B" ELSE "A"]
             /\ UNCHANGED <<planGeneration, planValues, hydrated, values, expected>>
Next == Restore \/ ReadHistory \/ Overwrite
Spec == Init /\ [][Next]_vars
ColdPayloadScope == hydrated \subseteq {"active"}
ExactCapturedValues == values = expected
=============================================================================
