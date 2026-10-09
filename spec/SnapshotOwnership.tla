-------------------------- MODULE SnapshotOwnership --------------------------
EXTENDS Naturals, Sequences, FiniteSets, TLC
CONSTANTS MaxDrafts, MaxRequests, Share, Validate, Release
VARIABLES drafts, heap, pool, nextId, requests
vars == <<drafts, heap, pool, nextId, requests>>
Values == {"A", "B"}
Refs(ds) == {ds[i].ref : i \in 1..Len(ds)}
Init == /\ drafts = <<>> /\ heap = [i \in {} |-> "A"]
        /\ pool = {} /\ nextId = 1 /\ requests = 0
Request(value) ==
  /\ requests < MaxRequests
  /\ LET matching == {id \in pool : ~Validate \/ heap[id] = value}
         reuse == Share /\ matching # {}
         id == IF reuse THEN CHOOSE candidate \in matching : TRUE ELSE nextId
         h == IF reuse THEN heap ELSE heap @@ (id :> value)
         extended == Append(drafts, [ref |-> id, expected |-> value])
         ds == IF Len(extended) > MaxDrafts THEN Tail(extended) ELSE extended
         owned == Refs(ds)
     IN /\ drafts' = ds
        /\ heap' = h
        /\ pool' = IF Release THEN owned ELSE pool \cup {id}
        /\ nextId' = IF reuse THEN nextId ELSE nextId + 1
  /\ requests' = requests + 1
Reset == /\ drafts' = <<>> /\ pool' = IF Release THEN {} ELSE pool
         /\ UNCHANGED <<heap, nextId, requests>>
Next == (\E value \in Values : Request(value)) \/ Reset
Spec == Init /\ [][Next]_vars
TypeOK == /\ Len(drafts) <= MaxDrafts /\ pool \subseteq DOMAIN heap
          /\ Refs(drafts) \subseteq pool
Isolation == \A i \in 1..Len(drafts) : heap[drafts[i].ref] = drafts[i].expected
SharedPayload == \A left,right \in pool : heap[left] = heap[right] => left = right
OwnedOnly == pool = Refs(drafts)
=============================================================================
