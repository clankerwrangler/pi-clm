---------------------------- MODULE ModeMigration ----------------------------
EXTENDS Naturals, Sequences
CONSTANT BadProof
VARIABLES prefixSame, suffixSame, boundarySafe, oldValid, nativeValid, fresh,
          applied, revision, archive, projected, intent
vars == <<prefixSame, suffixSame, boundarySafe, oldValid, nativeValid, fresh,
          applied, revision, archive, projected, intent>>
Proof == prefixSame /\ suffixSame /\ boundarySafe /\ oldValid /\ fresh
Suffix == <<"pendingUser">>
Init == /\ prefixSame \in BOOLEAN /\ suffixSame \in BOOLEAN
        /\ boundarySafe \in BOOLEAN /\ oldValid \in BOOLEAN
        /\ nativeValid \in BOOLEAN /\ fresh \in BOOLEAN
        /\ applied = FALSE /\ revision = 1 /\ intent = FALSE
        /\ archive = <<"rawA", "rawB", "pendingUser">>
        /\ projected = <<"acceptedSummary">> \o Suffix
SealIntent == /\ ~intent /\ ~nativeValid /\ (Proof \/ BadProof) /\ intent' = TRUE
              /\ UNCHANGED <<prefixSame, suffixSame, boundarySafe, oldValid, nativeValid, fresh, applied, revision, archive, projected>>
Migrate == /\ ~applied /\ ~nativeValid /\ intent /\ (Proof \/ BadProof)
           /\ applied' = TRUE /\ revision' = revision + 1 /\ nativeValid' = TRUE
           /\ UNCHANGED <<prefixSame, suffixSame, boundarySafe, oldValid, fresh, archive, projected, intent>>
Next == SealIntent \/ Migrate
Spec == Init /\ [][Next]_vars
ProvenOnly == applied => Proof
ArchiveExact == archive = <<"rawA", "rawB", "pendingUser">>
ViewExact == projected = <<"acceptedSummary">> \o Suffix
OnceOnly == revision <= 2
IntentBeforeAppend == applied => intent
=============================================================================
