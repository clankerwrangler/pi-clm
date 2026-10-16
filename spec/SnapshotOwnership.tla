-------------------------- MODULE SnapshotOwnership --------------------------
EXTENDS Naturals, Sequences, FiniteSets, TLC
CONSTANTS MaxDrafts, MaxRequests, Share, Validate, Release, BadResidentPayload, BadPublishFailure, BadCollisionCleanup
VARIABLES drafts, heap, pool, nextId, requests, resident, source, generation, canonical, history
vars == <<drafts, heap, pool, nextId, requests, resident, source, generation, canonical, history>>
Values == {"A", "B"}
Refs(ds) == {ds[i].ref : i \in 1..Len(ds)}
Owned(ds,c,hs) == Refs(ds) \cup Refs(hs) \cup (IF c.ref = 0 THEN {} ELSE {c.ref})
Init == /\ drafts = <<>> /\ heap = [i \in {} |-> "A"]
        /\ pool = {} /\ nextId = 1 /\ requests = 0
        /\ resident = {} /\ source = "A" /\ generation = 0 /\ canonical = [ref |-> 0, expected |-> "A"] /\ history = <<>>
Request(value) ==
  /\ requests < MaxRequests
  /\ LET matching == {id \in pool : ~Validate \/ heap[id] = value}
         reuse == Share /\ matching # {}
         id == IF reuse THEN CHOOSE candidate \in matching : TRUE ELSE nextId
         h == IF reuse THEN heap ELSE heap @@ (id :> value)
         extended == Append(drafts, [ref |-> id, expected |-> value])
         ds == IF Len(extended) > MaxDrafts THEN Tail(extended) ELSE extended
         owned == Owned(ds,canonical,history)
     IN /\ drafts' = ds
        /\ heap' = IF Release THEN [key \in owned |-> h[key]] ELSE h
        /\ pool' = IF Release THEN owned ELSE pool \cup {id}
        /\ nextId' = IF reuse THEN nextId ELSE nextId + 1
  /\ requests' = requests + 1
  /\ resident' = IF BadResidentPayload THEN Owned(drafts',canonical,history) ELSE {}
  /\ UNCHANGED <<source,generation,canonical,history>>
Reset == /\ drafts' = <<>> /\ history' = <<>> /\ canonical' = [ref |-> 0, expected |-> "A"] /\ pool' = IF Release THEN {} ELSE pool
         /\ resident' = {} /\ heap' = (IF Release THEN [i \in {} |-> "A"] ELSE heap)
         /\ UNCHANGED <<nextId, requests, source, generation>>
Overwrite == /\ generation < 2
  /\ source' = (IF source = "A" THEN "B" ELSE "A")
  /\ generation' = generation+1
  /\ UNCHANGED <<drafts,heap,pool,nextId,requests,resident,canonical,history>>
FailedCapture == /\ requests < MaxRequests
  /\ drafts' = (IF BadPublishFailure THEN Append(drafts,[ref |-> nextId, expected |-> source]) ELSE drafts)
  /\ requests' = requests+1
  /\ UNCHANGED <<heap,pool,nextId,resident,source,generation,canonical,history>>
CaptureFinal(value) ==
  /\ requests < MaxRequests
  /\ LET matching == {id \in pool : ~Validate \/ heap[id] = value}
         reuse == Share /\ matching # {}
         id == IF reuse THEN CHOOSE candidate \in matching : TRUE ELSE nextId
         h == IF reuse THEN heap ELSE heap @@ (id :> value)
         c == [ref |-> id, expected |-> value]
         owned == Owned(drafts,c,history)
     IN /\ canonical' = c
        /\ heap' = IF Release THEN [key \in owned |-> h[key]] ELSE h
        /\ pool' = IF Release THEN owned ELSE pool \cup {id}
        /\ nextId' = IF reuse THEN nextId ELSE nextId + 1
  /\ requests' = requests + 1
  /\ resident' = IF BadResidentPayload THEN Owned(drafts,canonical',history) ELSE {}
  /\ UNCHANGED <<drafts,source,generation,history>>
CaptureHistory(value) ==
  /\ requests < MaxRequests
  /\ LET matching == {id \in pool : ~Validate \/ heap[id] = value}
         reuse == Share /\ matching # {}
         id == IF reuse THEN CHOOSE candidate \in matching : TRUE ELSE nextId
         h == IF reuse THEN heap ELSE heap @@ (id :> value)
         hs == Append(history,[ref |-> id, expected |-> value])
         owned == Owned(drafts,canonical,hs)
     IN /\ history' = hs
        /\ heap' = IF Release THEN [key \in owned |-> h[key]] ELSE h
        /\ pool' = IF Release THEN owned ELSE pool \cup {id}
        /\ nextId' = IF reuse THEN nextId ELSE nextId + 1
  /\ requests' = requests + 1
  /\ resident' = IF BadResidentPayload THEN Owned(drafts,canonical,history') ELSE {}
  /\ UNCHANGED <<drafts,source,generation,canonical>>
CreateCollision(id) ==
  /\ id \in pool
  /\ heap' = IF BadCollisionCleanup THEN [key \in (DOMAIN heap \ {id}) |-> heap[key]] ELSE heap
  /\ UNCHANGED <<drafts,pool,nextId,requests,resident,source,generation,canonical,history>>
Next == (\E value \in Values : Request(value) \/ CaptureFinal(value) \/ CaptureHistory(value)) \/ Reset \/ Overwrite \/ FailedCapture \/ (\E id \in pool: CreateCollision(id))
Spec == Init /\ [][Next]_vars
TypeOK == /\ Len(drafts) <= MaxDrafts /\ pool \subseteq DOMAIN heap
          /\ Owned(drafts,canonical,history) \subseteq pool
Isolation == /\ \A i \in 1..Len(drafts) : heap[drafts[i].ref] = drafts[i].expected
             /\ \A i \in 1..Len(history) : heap[history[i].ref] = history[i].expected
             /\ IF canonical.ref = 0 THEN TRUE ELSE heap[canonical.ref] = canonical.expected
SharedPayload == \A left,right \in pool : heap[left] = heap[right] => left = right
OwnedOnly == pool = Owned(drafts,canonical,history)
FileOwnership == DOMAIN heap = pool
NoColdResidentPayload == resident = {}
=============================================================================
