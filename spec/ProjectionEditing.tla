-------------------------- MODULE ProjectionEditing --------------------------
EXTENDS Naturals, Sequences, FiniteSets
VARIABLES category, mode, closed, fresh, suffix, operation, target,
          archive, execution, projected, accepted, applied
vars == <<category, mode, closed, fresh, suffix, operation, target,
          archive, execution, projected, accepted, applied>>
Categories == {"summary", "branchSummary", "custom", "image", "signedThinking", "plain"}
Operations == {"keep", "edit", "delete", "reorder", "summary", "empty"}
Source == IF closed THEN <<"task", "call", category, "result", "latest">>
          ELSE <<"task", "call", category, "latest">>
OriginalExecution == [call |-> IF closed THEN "completed" ELSE "pending", dispatches |-> 1]
Replace(s, i, value) == [j \in 1..Len(s) |-> IF j = i THEN value ELSE s[j]]
Delete(s, i) == SelectSeq(s, LAMBDA v : v # s[i])
Draft == CASE operation = "keep" -> Source
           [] operation = "edit" -> Replace(Source, target, "note")
           [] operation = "delete" -> Delete(Source, target)
           [] operation = "reorder" -> [i \in 1..Len(Source) |-> Source[Len(Source) + 1 - i]]
           [] operation = "summary" -> <<"summaryNote">>
           [] OTHER -> <<>>
Index(s, value) == CHOOSE i \in 1..Len(s) : s[i] = value
Has(s, value) == value \in {s[i] : i \in 1..Len(s)}
(* A missing result is legal only if it was not present in the snapshot. *)
ValidCall(s) == Has(s, "call") /\
  (IF Has(s, "result") THEN Index(s, "call") < Index(s, "result") ELSE ~closed)
Normalize(s) == [i \in 1..Len(s) |-> IF s[i] \in {"call", "result"} /\ ~ValidCall(s) THEN "note" ELSE s[i]]
Proposed == Normalize(Draft)
InFlightSafe == closed \/ Has(Proposed, "call")
ConservativeAllowed == operation = "keep" \/
  (operation \in {"edit", "delete"} /\ target # 1 /\ target # Len(Source))
Allowed == fresh /\ InFlightSafe /\ (mode = "clm" \/ ConservativeAllowed)
Init == /\ category \in Categories /\ mode \in {"clm", "conservative"}
        /\ closed \in BOOLEAN /\ fresh \in BOOLEAN
        /\ suffix \in {<<>>, <<"newUser">>, <<"unseenResult", "newUser">>}
        /\ operation \in Operations /\ target \in 1..Len(Source)
        /\ archive = Source \o suffix /\ execution = OriginalExecution
        /\ projected = Source \o suffix /\ accepted = FALSE /\ applied = FALSE
Apply == /\ ~applied /\ applied' = TRUE /\ accepted' = Allowed
         /\ projected' = (IF Allowed THEN Proposed ELSE Source) \o suffix
         /\ UNCHANGED <<category, mode, closed, fresh, suffix, operation, target, archive, execution>>
Next == Apply \/ (applied /\ UNCHANGED vars)
Spec == Init /\ [][Next]_vars
ArchiveExact == archive = Source \o suffix
NoReplay == execution = OriginalExecution
SuffixExact == SubSeq(projected, Len(projected) - Len(suffix) + 1, Len(projected)) = suffix
FreshOnly == accepted => fresh
InFlightAdmission == applied /\ ~closed /\ ~Has(Proposed, "call") => ~accepted /\ projected = Source \o suffix
BroadProgress == applied /\ fresh /\ closed /\ mode = "clm" => accepted /\ projected = Proposed \o suffix
UnrelatedProgress == applied /\ fresh /\ ~closed /\ mode = "clm" /\ InFlightSafe => accepted
SummaryProgress == applied /\ fresh /\ closed /\ mode = "clm" /\ operation = "summary" => projected = <<"summaryNote">> \o suffix
EmptyProgress == applied /\ fresh /\ closed /\ mode = "clm" /\ operation = "empty" => projected = suffix
RetainedExact == applied /\ operation = "keep" => projected = Source \o suffix
ReplayOrder == accepted /\ Has(Proposed, "result") => Has(Proposed, "call") /\ Index(Proposed, "call") < Index(Proposed, "result")
=============================================================================
