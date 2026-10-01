----------------------------- MODULE ContextSafety -----------------------------
EXTENDS Integers, FiniteSets
CONSTANT MaxGeneration
VARIABLES enabled, store, generation, revision, draft, submitted,
          pending, results,
          durableOutputs, persistedRefs, mirror, accepted, acceptedFresh, cancelled
vars == <<enabled, store, generation, revision, draft, submitted,
          pending, results,
          durableOutputs, persistedRefs, mirror, accepted, acceptedFresh, cancelled>>
Init == /\ enabled = TRUE /\ store = TRUE /\ generation = 0 /\ revision = 0
        /\ draft = -1 /\ submitted = -1 /\ pending = {"call"} /\ results = {}
        /\ durableOutputs = {} /\ persistedRefs = {} /\ mirror = TRUE
        /\ accepted = FALSE /\ acceptedFresh = TRUE /\ cancelled = FALSE
Refresh == /\ generation < MaxGeneration /\ generation' = generation + 1
           /\ mirror' = TRUE /\ accepted' = FALSE
           /\ UNCHANGED <<enabled,store,revision,draft,submitted,pending,results,
                         durableOutputs,persistedRefs,acceptedFresh,cancelled>>
Begin == /\ draft' = revision
         /\ UNCHANGED <<enabled,store,generation,revision,submitted,pending,results,
                       durableOutputs,persistedRefs,mirror,accepted,acceptedFresh,cancelled>>
Submit == /\ draft >= 0 /\ submitted' = draft /\ draft' = -1
          /\ UNCHANGED <<enabled,store,generation,revision,pending,results,
                        durableOutputs,persistedRefs,mirror,accepted,acceptedFresh,cancelled>>
Consume == /\ submitted >= 0 /\ submitted' = -1
           /\ accepted' = (enabled /\ store /\ submitted = revision)
           /\ acceptedFresh' = (submitted = revision)
           /\ revision' = IF enabled /\ store /\ submitted = revision THEN revision + 1 ELSE revision
           /\ UNCHANGED <<enabled,store,generation,draft,pending,results,durableOutputs,persistedRefs,mirror,cancelled>>
Complete == /\ pending # {} /\ results' = results \cup pending /\ pending' = {}
            /\ UNCHANGED <<enabled,store,generation,revision,draft,submitted,durableOutputs,persistedRefs,mirror,accepted,acceptedFresh,cancelled>>
SaveOutput == /\ durableOutputs' = {"output"}
              /\ UNCHANGED <<enabled,store,generation,revision,draft,submitted,pending,results,
                            persistedRefs,mirror,accepted,acceptedFresh,cancelled>>
Persist == /\ "output" \in durableOutputs /\ persistedRefs' = {"output"}
           /\ UNCHANGED <<enabled,store,generation,revision,draft,submitted,pending,results,
                         durableOutputs,mirror,accepted,acceptedFresh,cancelled>>
DeleteMirror == /\ mirror' = FALSE /\ store' = FALSE /\ cancelled' = FALSE
                /\ UNCHANGED <<enabled,generation,revision,draft,submitted,pending,results,
                              durableOutputs,persistedRefs,accepted,acceptedFresh>>
Toggle == /\ enabled' = ~enabled /\ cancelled' = FALSE
          /\ UNCHANGED <<store,generation,revision,draft,submitted,pending,results,
                        durableOutputs,persistedRefs,mirror,accepted,acceptedFresh>>
Compact == /\ cancelled' = (enabled /\ store)
           /\ UNCHANGED <<enabled,store,generation,revision,draft,submitted,pending,results,
                         durableOutputs,persistedRefs,mirror,accepted,acceptedFresh>>
Invalidate == /\ revision' = revision + 1 /\ accepted' = FALSE
              /\ UNCHANGED <<enabled,store,generation,draft,submitted,pending,results,
                            durableOutputs,persistedRefs,mirror,acceptedFresh,cancelled>>
Next == Invalidate \/ Refresh \/ Begin \/ Submit \/ Consume \/ Complete \/ SaveOutput \/ Persist \/ DeleteMirror \/ Toggle \/ Compact
Spec == Init /\ [][Next]_vars
FreshEdits == accepted => acceptedFresh
ExecutionClosure == pending \cap results = {} /\ pending \cup results = {"call"}
DurableRecall == persistedRefs \subseteq durableOutputs
OffTransparent == (~enabled \/ ~store) => ~cancelled
Bound == revision <= 2
=============================================================================
