----------------------------- MODULE NativeBody -----------------------------
EXTENDS Naturals, FiniteSets
CONSTANT OverprotectMetadata
VARIABLES mode, operation, body, envelope, assistant, ordinaryText, accepted, applied
vars == <<mode, operation, body, envelope, assistant, ordinaryText, accepted, applied>>

Modes == [core : {"plain", "signed", "metadata", "unknown", "malformed"},
          assistantMapped : BOOLEAN, resultMapped : BOOLEAN,
          closure : {"closed", "pending", "deferred", "partial", "duplicateCall",
                     "duplicateResult", "unmatched", "inverted", "nameMismatch", "unsettled"},
          resultContent : {"plain", "opaque"}]
BodyOperations == {"body", "cap", "withhold"}
Operations == BodyOperations \cup {"delete", "role", "identity", "metadata", "invert", "reorder", "ordinaryText"}
OriginalEnvelope == [role |-> "toolResult", id |-> "call", name |-> "read",
                     metadata |-> "exact", position |-> "sourceOrder", exists |-> TRUE]
(* Mapping the assistant is not required: its whole envelope remains exact.
   Public required cores and authoritative closure, not extra metadata, admit a body. *)
Eligible == mode.core \in {"plain", "signed", "metadata"}
            /\ mode.resultMapped /\ mode.closure = "closed" /\ mode.resultContent = "plain"
CanEditBody == Eligible /\ ~(OverprotectMetadata /\ mode.core = "metadata")

Init == /\ mode \in Modes /\ operation = "body" /\ body = "large"
        /\ envelope = OriginalEnvelope /\ assistant = "exactAssistantWithAllMetadata"
        /\ ordinaryText = "large" /\ accepted = FALSE /\ applied = FALSE
Draft == /\ operation' \in Operations /\ accepted' = FALSE /\ applied' = FALSE
         /\ UNCHANGED <<mode, body, envelope, assistant, ordinaryText>>
Apply == /\ accepted' = ((CanEditBody /\ operation \in BodyOperations) \/ operation = "ordinaryText")
         /\ body' = IF CanEditBody /\ operation \in BodyOperations THEN "small" ELSE body
         /\ ordinaryText' = IF operation = "ordinaryText" THEN "small" ELSE ordinaryText
         /\ applied' = TRUE
         /\ UNCHANGED <<mode, operation, envelope, assistant>>
Next == Draft \/ Apply
Spec == Init /\ [][Next]_vars
NativeIdentity == envelope = OriginalEnvelope /\ assistant = "exactAssistantWithAllMetadata"
ProtectedExact == ~Eligible => body = "large"
BodyOnly == (accepted /\ operation # "ordinaryText") => Eligible /\ operation \in BodyOperations
BodyProgress == (applied /\ Eligible /\ operation \in BodyOperations) => accepted /\ body = "small"
OrdinaryEditability == (applied /\ operation = "ordinaryText") => accepted /\ ordinaryText = "small"
=============================================================================
