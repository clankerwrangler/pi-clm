--------------------------- MODULE FinalBoundary ---------------------------
EXTENDS TLC
VARIABLE s
vars == <<s>>
Init == s \in [kind : {"direct", "atomic"}, sourceMatches : BOOLEAN,
              phase : {"running", "result", "committed"}, candidate : {TRUE},
              accepted : {FALSE}, finalSeen : {FALSE}, safeFinal : {TRUE}]
Quiescent == s.phase = "committed"
\* Both entry points use this one validator. Only ordinary context is known to
\* be in the stable preceding transform's source space.
Consume(matches) == [s EXCEPT !.candidate = FALSE, !.accepted = matches]
Finish == /\ s.phase = "running" /\ s' = [s EXCEPT !.phase = "result"]
Commit == /\ s.phase = "result" /\ s' = [s EXCEPT !.phase = "committed"]
Context == /\ s.candidate /\ (s.kind = "atomic" \/ Quiescent)
           /\ s' = Consume(TRUE)
Final == /\ ~s.finalSeen
         /\ LET eligible == Quiescent /\ s.sourceMatches
                next == IF s.candidate /\ eligible THEN Consume(s.sourceMatches) ELSE s
            IN s' = [next EXCEPT !.finalSeen = TRUE,
                        !.safeFinal = s.safeFinal /\ (~(s.candidate /\ eligible) \/ Quiescent)]
Next == Finish \/ Commit \/ Context \/ Final
Spec == Init /\ [][Next]_vars
\* A canonical-space final hook cannot consume a next-context-valid candidate.
CandidateNotLost == s.candidate \/ s.accepted
FinalWaitsForCanonicalCompletion == s.safeFinal
=============================================================================
