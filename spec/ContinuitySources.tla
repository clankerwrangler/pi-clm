----------------------- MODULE ContinuitySources -----------------------
EXTENDS Naturals, FiniteSets
VARIABLES branch, retention, resolved, sourceState, phase, requested,
          pointers, pins, unavailable
vars == <<branch, retention, resolved, sourceState, phase, requested,
          pointers, pins, unavailable>>
Annotations == {"a1", "a2", "a3"}
Source == [a1 |-> "e1", a2 |-> "e1", a3 |-> "e2"]
AnnotationBranch == [a1 |-> "left", a2 |-> "left", a3 |-> "right"]
Active == {a \in Annotations : AnnotationBranch[a] = branch /\
             a \notin resolved /\ retention[a] # "archive"}
PinAnnotations == {a \in Active : retention[a] = "pin"}
Init == /\ branch \in {"left", "right"}
        /\ retention \in [Annotations -> {"pin", "continuity", "archive"}]
        /\ resolved \in SUBSET Annotations
        /\ sourceState \in [{"e1", "e2"} -> {"valid", "missing", "changed"}]
        /\ phase = "input" /\ requested = {} /\ pointers = {}
        /\ pins = {} /\ unavailable = {}
Lookup == /\ phase = "input" /\ phase' = "done"
          /\ requested' = {Source[a] : a \in PinAnnotations}
          /\ pointers' = Active
          /\ pins' = {a \in PinAnnotations : sourceState[Source[a]] = "valid"}
          /\ unavailable' = {a \in PinAnnotations : sourceState[Source[a]] # "valid"}
          /\ UNCHANGED <<branch, retention, resolved, sourceState>>
Next == Lookup
Spec == Init /\ [][Next]_vars
BranchLocal == phase = "done" => pointers = Active
PinSourcesOnly == phase = "done" => requested = {Source[a] : a \in PinAnnotations}
MissingAndChangedVisible == phase = "done" =>
  unavailable = {a \in PinAnnotations : sourceState[Source[a]] # "valid"}
ExactPinParity == phase = "done" =>
  pins = {a \in PinAnnotations : sourceState[Source[a]] = "valid"}
ResolvedAndArchiveSilent == pointers \cap
  {a \in Annotations : a \in resolved \/ retention[a] = "archive"} = {}
=============================================================================
