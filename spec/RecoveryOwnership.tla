--------------------------- MODULE RecoveryOwnership ---------------------------
EXTENDS Integers, FiniteSets, Sequences, TLC
CONSTANTS BadMetadataCopy, BadParallelRead, BadRedirect, BadPublish
VARIABLES generation, keys, selected, captured, pending, materialized, peak, published, metadata
vars == <<generation, keys, selected, captured, pending, materialized, peak, published, metadata>>
Ids == 1..3
Init == /\ generation = 0 /\ keys = [i \in Ids |-> 0]
        /\ selected = [i \in Ids |-> 0] /\ captured = {} /\ pending = Ids
        /\ materialized = {} /\ peak = 0 /\ published = FALSE
        /\ metadata = IF BadMetadataCopy THEN {"selected", "unrelated"} ELSE {"selected"}
Read == /\ pending # {} /\ (materialized = {} \/ BadParallelRead)
        /\ \E i \in pending:
           /\ (keys[i] = selected[i] \/ BadRedirect)
           /\ materialized' = materialized \cup {i}
           /\ peak' = IF Cardinality(materialized') > peak THEN Cardinality(materialized') ELSE peak
           /\ pending' = pending \ {i}
        /\ UNCHANGED <<generation, keys, selected, captured, published, metadata>>
Capture == /\ materialized # {} /\ captured' = captured \cup materialized
           /\ materialized' = {} /\ UNCHANGED <<generation, keys, selected, pending, peak, published, metadata>>
Rewrite == /\ generation = 0 /\ materialized = {} /\ ~published /\ generation' = 1 /\ keys' = [i \in Ids |-> 1]
           /\ UNCHANGED <<selected, captured, pending, materialized, peak, published, metadata>>
Publish == /\ pending = {} /\ materialized = {} /\ (generation = 0 \/ BadPublish)
           /\ published' = TRUE /\ UNCHANGED <<generation, keys, selected, captured, pending, materialized, peak, metadata>>
Next == Read \/ Capture \/ Rewrite \/ Publish
Spec == Init /\ [][Next]_vars
MetadataScope == metadata \subseteq {"selected"}
OneCandidate == peak <= 1
ExactRead == materialized = {} \/ generation = 0
FencedPublication == ~published \/ generation = 0
=============================================================================
