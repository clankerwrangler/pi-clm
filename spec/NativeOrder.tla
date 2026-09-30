----------------------------- MODULE NativeOrder -----------------------------
EXTENDS Naturals, Sequences, FiniteSets
VARIABLES original, draft, projected, native
vars == <<original, draft, projected, native>>
Orders == {<<"call">>, <<"call", "result">>, <<"call", "middle", "result">>, <<"result", "call">>, <<"result", "middle", "call">>}
Ordered(s) == Head(s) = "call"
Protected == Len(original) = 1 \/ ~Ordered(original)
Init == /\ original \in Orders /\ draft = original /\ projected = original /\ native = TRUE
Edit == /\ draft' \in Orders /\ UNCHANGED <<original, projected, native>>
Normalize == /\ projected' = IF Protected THEN original ELSE draft
             /\ native' = (Protected \/ (Ordered(draft) /\ Len(draft) > 1))
             /\ UNCHANGED <<original, draft>>
Next == Edit \/ Normalize
Spec == Init /\ [][Next]_vars
NoIntroducedInversion == native /\ ~Protected => Ordered(projected)
ProtectedConserved == Protected => projected = original /\ native
=============================================================================
