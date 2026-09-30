----------------------------- MODULE ToolExposure -----------------------------
EXTENDS FiniteSets
VARIABLES exposure, loaded, active
vars == <<exposure, loaded, active>>
Init == /\ exposure = "direct" /\ loaded = FALSE /\ active = FALSE
Configure == /\ ~loaded /\ exposure' \in {"direct", "codemode", "invalid"}
             /\ UNCHANGED <<loaded, active>>
Load == /\ ~loaded /\ exposure \in {"direct", "codemode"}
        /\ loaded' = TRUE /\ active' = TRUE /\ UNCHANGED exposure
Deactivate == /\ loaded /\ active' = FALSE /\ UNCHANGED <<loaded, exposure>>
Next == Configure \/ Load \/ Deactivate
Spec == Init /\ [][Next]_vars
Declared == loaded /\ active /\ exposure = "direct"
Callable == loaded /\ (active \/ exposure = "codemode")
ValidLoad == loaded => exposure \in {"direct", "codemode"}
CodeMode == loaded /\ exposure = "codemode" => ~Declared /\ Callable
DefaultDirect == loaded /\ active /\ exposure = "direct" => Declared /\ Callable
=============================================================================
