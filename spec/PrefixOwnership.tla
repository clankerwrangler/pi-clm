-------------------- MODULE PrefixOwnership --------------------
EXTENDS Naturals, Sequences, FiniteSets, TLC
CONSTANTS MaxCaptures, BadCopyUnchanged, BadReuseChanged, BadPublicAlias, BadExpiredPublish
VARIABLES owners, pending, raw, generation, captures, corrupt, lastFresh, lastCopies
vars == <<owners,pending,raw,generation,captures,corrupt,lastFresh,lastCopies>>
Sources == {<<"A">>, <<"A","B">>, <<"A","C">>, <<"B">>}
Prefix(s,i) == SubSeq(s,1,i)
SamePrefix(p,s,i) == i <= Len(p.values) /\ Prefix(p.values,i) = Prefix(s,i)
Empty == [values |-> <<>>, states |-> <<>>]
Idle == [active |-> FALSE, previous |-> Empty, values |-> <<>>, generation |-> 0]
Build(p,s,n) == [i \in 1..Len(s) |->
  IF (SamePrefix(p,s,i) /\ ~BadCopyUnchanged) \/ (BadReuseChanged /\ i <= Len(p.values))
  THEN p.states[i] ELSE [id |-> <<n,i>>, value |-> Prefix(s,i)]]
Copied(p,s) == Cardinality({i \in 1..Len(s) : ~SamePrefix(p,s,i) \/ BadCopyUnchanged})
Needed(p,s) == Cardinality({i \in 1..Len(s) : ~SamePrefix(p,s,i)})
Init == /\ owners = <<>> /\ pending = Idle /\ raw = <<"A">> /\ generation = 0
        /\ captures = 0 /\ corrupt = {} /\ lastFresh = TRUE /\ lastCopies = 0
Begin(p) == /\ pending = Idle /\ captures < MaxCaptures
            /\ pending' = [active |-> TRUE, previous |-> p, values |-> raw, generation |-> generation]
            /\ UNCHANGED <<owners,raw,generation,captures,corrupt,lastFresh,lastCopies>>
Publish == /\ pending.active /\ (pending.generation = generation \/ BadExpiredPublish)
           /\ owners' = Append(owners,[id |-> captures+1, values |-> pending.values,
                         states |-> Build(pending.previous,pending.values,captures+1)])
           /\ lastFresh' = (pending.generation = generation)
           /\ lastCopies' = Copied(pending.previous,pending.values) - Needed(pending.previous,pending.values)
           /\ captures' = captures+1 /\ pending' = Idle
           /\ UNCHANGED <<raw,generation,corrupt>>
Fail == /\ pending.active /\ pending' = Idle
        /\ UNCHANGED <<owners,raw,generation,captures,corrupt,lastFresh,lastCopies>>
Close(i) == /\ i \in 1..Len(owners)
            /\ owners' = SelectSeq(owners,LAMBDA o: o.id # owners[i].id)
            /\ UNCHANGED <<pending,raw,generation,captures,corrupt,lastFresh,lastCopies>>
Rebase(s) == /\ generation = 0 /\ generation' = 1 /\ raw' = s
             /\ UNCHANGED <<owners,pending,captures,corrupt,lastFresh,lastCopies>>
PublicEdit(i,j) == /\ i \in 1..Len(owners) /\ j \in 1..Len(owners[i].states)
                  /\ corrupt' = (IF BadPublicAlias THEN corrupt \cup {owners[i].states[j].id} ELSE corrupt)
                  /\ UNCHANGED <<owners,pending,raw,generation,captures,lastFresh,lastCopies>>
Next == (\E p \in {Empty} \cup {owners[i] : i \in 1..Len(owners)} : Begin(p))
        \/ Publish \/ Fail \/ (\E i \in 1..Len(owners) : Close(i))
        \/ (\E s \in Sources : Rebase(s))
        \/ (\E i \in 1..Len(owners) : \E j \in 1..Len(owners[i].states) : PublicEdit(i,j))
Spec == Init /\ [][Next]_vars
CapturedExact == \A i \in 1..Len(owners) : \A j \in 1..Len(owners[i].states) :
    owners[i].states[j].value = Prefix(owners[i].values,j) /\ owners[i].states[j].id \notin corrupt
FreshPublication == lastFresh
NoRedundantPrivateCopies == lastCopies = 0
=============================================================================
