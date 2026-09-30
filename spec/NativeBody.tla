----------------------------- MODULE NativeBody -----------------------------
EXTENDS Naturals, FiniteSets
VARIABLES mode, operation, body, envelope, assistant, accepted
vars == <<mode, operation, body, envelope, assistant, accepted>>
Modes == {"signedComplete", "unmappedAssistant", "pending", "partial", "ambiguous", "opaqueResult", "unknownAssistant", "unmappedResult"}
Operations == {"body", "cap", "withhold", "delete", "role", "identity", "metadata", "invert", "reorder"}
OriginalEnvelope == [role |-> "toolResult", id |-> "call", name |-> "read", metadata |-> "exact", position |-> "sourceOrder", exists |-> TRUE]
Init == /\ mode \in Modes /\ operation = "body" /\ body = "large"
        /\ envelope = OriginalEnvelope /\ assistant = "exactSignedAssistant" /\ accepted = FALSE
Draft == /\ operation' \in Operations /\ accepted' = FALSE
         /\ UNCHANGED <<mode, body, envelope, assistant>>
Apply == /\ accepted' = (mode \in {"signedComplete", "unmappedAssistant"} /\ operation \in {"body", "cap", "withhold"})
         /\ body' = IF mode \in {"signedComplete", "unmappedAssistant"} /\ operation \in {"body", "cap", "withhold"} THEN "small" ELSE body
         /\ UNCHANGED <<mode, operation, envelope, assistant>>
Next == Draft \/ Apply
Spec == Init /\ [][Next]_vars
NativeIdentity == envelope = OriginalEnvelope /\ assistant = "exactSignedAssistant"
ProtectedExact == mode \notin {"signedComplete", "unmappedAssistant"} => body = "large"
BodyOnly == accepted => mode \in {"signedComplete", "unmappedAssistant"} /\ operation \in {"body", "cap", "withhold"}
=============================================================================
