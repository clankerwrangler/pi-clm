------------------------ MODULE RenderOwnership ------------------------
EXTENDS Naturals, Sequences, FiniteSets, TLC
CONSTANTS Limit, MaxRequests, MaxEdits, Share, Lazy, DirectLazy, RetainTail, Release, ExactFraming
VARIABLES drafts, direct, heap, pool, nextId, requests, edits, tailPayload, lastRead, expectedRead
vars == <<drafts,direct,heap,pool,nextId,requests,edits,tailPayload,lastRead,expectedRead>>
\* Drafts and the direct-write comparison own immutable file-backed values.
\* Publication reuses its captured document; a changed candidate owns its exact
\* text even if rejected. Read materializes the text only for comparison.
\* A serialized completion tail owns no successful output; callers keep their
\* original independent result. Provider/request payloads are otherwise abstracted.
Values == {"A","B"}
Refs(ds) == {ds[i].ref : i \in 1..Len(ds)}
Owners(ds,dd) == Refs(ds \o dd)
Init == /\ drafts = <<>> /\ direct = <<>> /\ heap = [i \in {} |-> "A"] /\ pool = {}
        /\ nextId = 1 /\ requests = 0 /\ edits = 0 /\ tailPayload = FALSE /\ lastRead = <<>> /\ expectedRead = <<>>
Request(value) ==
  /\ requests < MaxRequests
  /\ LET matches == {id \in pool: heap[id] = value}
         reuse == Share /\ matches # {}
         id == IF reuse THEN CHOOSE candidate \in matches: TRUE ELSE nextId
         draft == [nonce |-> requests,ref |-> id, expected |-> value, full |-> ~Lazy]
         extended == Append(drafts,draft)
         ds == IF Len(extended) > Limit THEN Tail(extended) ELSE extended
         dd == <<[draft EXCEPT !.full = ~DirectLazy]>>
     IN /\ drafts' = ds /\ direct' = dd
        /\ heap' = LET h == IF reuse THEN heap ELSE heap @@ (id :> value) IN
           IF Release THEN [key \in Owners(ds,dd) |-> h[key]] ELSE h
        /\ pool' = IF Release THEN Owners(ds,dd) ELSE pool \cup {id}
        /\ nextId' = IF reuse THEN nextId ELSE nextId + 1
  /\ requests' = requests + 1 /\ tailPayload' = RetainTail /\ UNCHANGED <<edits,lastRead,expectedRead>>
DirectEdit(value) ==
  /\ Len(direct) = 1 /\ edits < MaxEdits
  /\ LET matches == {id \in pool: heap[id] = value}
         reuse == Share /\ matches # {}
         id == IF reuse THEN CHOOSE candidate \in matches: TRUE ELSE nextId
         dd == <<[nonce |-> requests,ref |-> id,expected |-> value,full |-> ~DirectLazy]>>
     IN /\ direct' = dd
        /\ heap' = LET h == IF reuse THEN heap ELSE heap @@ (id :> value) IN
           IF Release THEN [key \in Owners(drafts,dd) |-> h[key]] ELSE h
        /\ pool' = IF Release THEN Owners(drafts,dd) ELSE pool \cup {id}
        /\ nextId' = IF reuse THEN nextId ELSE nextId + 1
  /\ edits' = edits + 1 /\ tailPayload' = FALSE /\ UNCHANGED <<drafts,requests,lastRead,expectedRead>>
Read(owner) == /\ lastRead' = <<IF ExactFraming THEN owner.nonce ELSE requests, heap[owner.ref]>>
               /\ expectedRead' = <<owner.nonce,owner.expected>>
               /\ UNCHANGED <<drafts,direct,heap,pool,nextId,requests,edits,tailPayload>>
PruneDrafts == /\ drafts' = <<>>
               /\ pool' = IF Release THEN Refs(direct) ELSE pool
               /\ heap' = IF Release THEN [key \in Refs(direct) |-> heap[key]] ELSE heap
               /\ UNCHANGED <<direct,nextId,requests,edits,tailPayload,lastRead,expectedRead>>
Reset == /\ drafts' = <<>> /\ direct' = <<>> /\ pool' = IF Release THEN {} ELSE pool
         /\ heap' = (IF Release THEN [i \in {} |-> "A"] ELSE heap)
         /\ UNCHANGED <<nextId,requests,edits,tailPayload,lastRead,expectedRead>>
Next == (\E value \in Values: Request(value) \/ DirectEdit(value)) \/
        (\E i \in 1..Len(drafts): Read(drafts[i])) \/
        (\E i \in 1..Len(direct): Read(direct[i])) \/ PruneDrafts \/ Reset
Spec == Init /\ [][Next]_vars
Window == Len(drafts) <= Limit /\ Len(direct) <= 1
ExactText == lastRead = expectedRead
SharedBodies == \A a,b \in pool: heap[a] = heap[b] => a = b
NoFullText == \A i \in 1..Len(drafts): ~drafts[i].full
NoTailPayload == ~tailPayload
NoDirectFullText == \A i \in 1..Len(direct): ~direct[i].full
OwnedOnly == pool = Owners(drafts,direct)
FileOwnership == DOMAIN heap = pool
=============================================================================
