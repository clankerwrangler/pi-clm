----------------------------- MODULE Maintenance -----------------------------
EXTENDS Naturals, Sequences
VARIABLES phase, busy, valid, delivery, entries, admissions, prepared, requests
vars == <<phase, busy, valid, delivery, entries, admissions, prepared, requests>>
Maintenance == [role |-> "custom", kind |-> "clm-maintenance", source |-> "extension"]
User == [role |-> "user", kind |-> "input", source |-> "user"]
Init == /\ phase = "waiting" /\ busy \in BOOLEAN /\ valid = TRUE
        /\ delivery = "none" /\ entries = <<>> /\ admissions = 0
        /\ prepared = 0 /\ requests = 0
Idle == /\ busy /\ busy' = FALSE
        /\ UNCHANGED <<phase, valid, delivery, entries, admissions, prepared, requests>>
Invalidate == /\ phase \in {"waiting", "ready"} /\ valid' = FALSE
              /\ UNCHANGED <<phase, busy, delivery, entries, admissions, prepared, requests>>
Ready == /\ phase = "waiting" /\ ~busy /\ phase' = "ready"
         /\ UNCHANGED <<busy, valid, delivery, entries, admissions, prepared, requests>>
Race == /\ phase = "ready" /\ busy' = TRUE
        /\ UNCHANGED <<phase, valid, delivery, entries, admissions, prepared, requests>>
Send == /\ phase = "ready" /\ valid /\ phase' = "queued"
        /\ delivery' = IF busy THEN "followUp" ELSE "triggerTurn"
        /\ UNCHANGED <<busy, valid, entries, admissions, prepared, requests>>
Cancel == /\ phase = "ready" /\ ~valid /\ phase' = "cancelled"
          /\ UNCHANGED <<busy, valid, delivery, entries, admissions, prepared, requests>>
Deliver == /\ phase = "queued" /\ ~busy /\ phase' = "delivered"
           /\ entries' = <<Maintenance>>
           /\ UNCHANGED <<busy, valid, delivery, admissions, prepared, requests>>
Prepare == /\ phase = "delivered" /\ phase' = "prepared" /\ prepared' = 1
           /\ UNCHANGED <<busy, valid, delivery, entries, admissions, requests>>
Request == /\ phase = "prepared" /\ phase' = "finished" /\ requests' = 1
           /\ UNCHANGED <<busy, valid, delivery, entries, admissions, prepared>>
OrdinaryInput == /\ phase \in {"finished", "cancelled"} /\ phase' = "user"
                /\ entries' = Append(entries, User) /\ admissions' = 1
                /\ prepared' = prepared + 1 /\ requests' = requests + 1
                /\ UNCHANGED <<busy, valid, delivery>>
(* Duplicate commands while waiting/ready do nothing; no second maintenance entry. *)
Next == Idle \/ Invalidate \/ Ready \/ Race \/ Send \/ Cancel \/ Deliver \/ Prepare \/ Request \/ OrdinaryInput \/ UNCHANGED vars
Spec == Init /\ [][Next]_vars
NoUserAttribution == \A i \in 1..Len(entries): entries[i].kind = "clm-maintenance" => entries[i] = Maintenance
SingleMaintenance == Len(SelectSeq(entries, LAMBDA e: e.kind = "clm-maintenance")) <= 1
UserAdmissionOnly == admissions = Len(SelectSeq(entries, LAMBDA e: e.role = "user"))
PreparedBeforeRequest == requests <= prepared
NoStaleSend == phase = "cancelled" => entries = <<>> /\ requests = 0
TurnProgress == phase = "finished" => entries = <<Maintenance>> /\ requests = 1 /\ admissions = 0
UserProgress == phase = "user" => entries[Len(entries)] = User /\ admissions = 1 /\ requests = Len(entries)
=============================================================================
