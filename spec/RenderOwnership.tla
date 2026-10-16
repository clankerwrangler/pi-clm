------------------------ MODULE RenderOwnership ------------------------
EXTENDS Naturals, Sequences, FiniteSets, TLC
CONSTANTS Limit, MaxRequests, Share, Lazy, Release, ExactFraming
VARIABLES drafts, heap, pool, nextId, requests, lastRead, expectedRead
vars == <<drafts,heap,pool,nextId,requests,lastRead,expectedRead>>
\* A draft owns framing and a reference to an immutable body, never a joined
\* header/body fragment. Read materializes their ordered concatenation transiently.
Values == {"A","B"}
Refs(ds) == {ds[i].ref : i \in 1..Len(ds)}
Init == /\ drafts = <<>> /\ heap = [i \in {} |-> "A"] /\ pool = {}
        /\ nextId = 1 /\ requests = 0 /\ lastRead = <<>> /\ expectedRead = <<>>
Request(value) ==
  /\ requests < MaxRequests
  /\ LET matches == {id \in pool: heap[id] = value}
         reuse == Share /\ matches # {}
         id == IF reuse THEN CHOOSE candidate \in matches: TRUE ELSE nextId
         extended == Append(drafts,[nonce |-> requests,ref |-> id, expected |-> value, full |-> ~Lazy])
         ds == IF Len(extended) > Limit THEN Tail(extended) ELSE extended
     IN /\ drafts' = ds
        /\ heap' = LET h == IF reuse THEN heap ELSE heap @@ (id :> value) IN
           IF Release THEN [key \in Refs(ds) |-> h[key]] ELSE h
        /\ pool' = IF Release THEN Refs(ds) ELSE pool \cup {id}
        /\ nextId' = IF reuse THEN nextId ELSE nextId + 1
  /\ requests' = requests + 1 /\ UNCHANGED <<lastRead,expectedRead>>
Read(i) == /\ i \in 1..Len(drafts)
           /\ lastRead' = <<IF ExactFraming THEN drafts[i].nonce ELSE requests, heap[drafts[i].ref]>>
           /\ expectedRead' = <<drafts[i].nonce,drafts[i].expected>>
           /\ UNCHANGED <<drafts,heap,pool,nextId,requests>>
Reset == /\ drafts' = <<>> /\ pool' = IF Release THEN {} ELSE pool
         /\ heap' = (IF Release THEN [i \in {} |-> "A"] ELSE heap)
         /\ UNCHANGED <<nextId,requests,lastRead,expectedRead>>
Next == (\E value \in Values: Request(value)) \/ (\E i \in 1..Len(drafts): Read(i)) \/ Reset
Spec == Init /\ [][Next]_vars
Window == Len(drafts) <= Limit
ExactText == lastRead = expectedRead
SharedBodies == \A a,b \in pool: heap[a] = heap[b] => a = b
NoFullText == \A i \in 1..Len(drafts): ~drafts[i].full
OwnedOnly == pool = Refs(drafts)
FileOwnership == DOMAIN heap = pool
=============================================================================
