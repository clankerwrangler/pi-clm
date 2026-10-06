--------------------------- MODULE MirrorLifecycle ---------------------------
EXTENDS Integers, FiniteSets, TLC
CONSTANT Tools
VARIABLE s
vars == <<s>>
IdleTools == [t \in Tools |-> "idle"]
Init == s = [epoch |-> 0, revision |-> 0, source |-> 0, mirrorSource |-> 0,
             mirrorRevision |-> 0, calls |-> IdleTools, generation |-> 0,
             io |-> "idle", ioGeneration |-> 0, ioEpoch |-> 0,
             text |-> "clean", failed |-> FALSE, atomic |-> FALSE,
             atomicSource |-> 0, atomicRevision |-> 0, tail |-> 0,
             accepted |-> 0, durable |-> 0, pendingSafe |-> TRUE,
             safeAccept |-> TRUE, safeRefresh |-> TRUE, readText |-> "clean", readSource |-> 0,
             readRevision |-> 0, acceptedPendingSafe |-> TRUE]
Running == {t \in Tools : s.calls[t] \in {"admitted", "running", "fault"}}
Executing == {t \in Tools : s.calls[t] \in {"running", "fault"}}
Uncommitted == {t \in Tools : s.calls[t] = "result"}
Completed == {t \in Tools : s.calls[t] = "committed"}
Admit(t) == /\ s.calls[t] = "idle" /\ s.generation < 3
            /\ s' = [s EXCEPT !.calls[t] = "admitted", !.generation = @ + 1]
\* Public tool_call awaits the current context operation before execute starts.
Execute(t) == /\ s.calls[t] = "admitted" /\ s.io = "idle"
              /\ s' = [s EXCEPT !.calls[t] = "running"]
Partial(t) == /\ s.calls[t] = "running"
              /\ s' = [s EXCEPT !.text = "partial"]
Write(t) == /\ s.calls[t] = "running"
            /\ s' = [s EXCEPT !.text = "complete"]
Result(t) == /\ s.calls[t] = "running" /\ s.text # "partial"
             /\ s' = [s EXCEPT !.calls[t] = "result"]
Fail(t) == /\ s.calls[t] \in {"admitted", "running", "fault"}
           /\ s' = [s EXCEPT !.calls[t] = "fault", !.failed = TRUE]
Exit(t) == /\ s.calls[t] = "fault"
           /\ s' = [s EXCEPT !.calls[t] = "result"]
CommitResult(t) == /\ s.calls[t] = "result"
                   /\ s' = [s EXCEPT !.calls[t] = "committed"]
BeginRead == /\ s.io = "idle" /\ Running = {} /\ Uncommitted = {}
             /\ s' = [s EXCEPT !.io = "read", !.ioGeneration = s.generation,
                               !.ioEpoch = s.epoch, !.readText = s.text,
                               !.readSource = s.mirrorSource, !.readRevision = s.mirrorRevision]
FreshIO == s.ioGeneration = s.generation /\ s.ioEpoch = s.epoch
FreshMirror == s.mirrorSource = s.source /\ s.mirrorRevision = s.revision
ReadDone == /\ s.io = "read"
            /\ s' = [s EXCEPT !.io = IF FreshIO /\ Running = {} THEN "validate" ELSE "idle"]
AcceptDirect == /\ s.io = "validate" /\ FreshIO /\ Running = {}
                /\ Uncommitted = {} /\ Completed # {} /\ ~s.failed
                /\ FreshMirror /\ s.readText = "complete" /\ s.pendingSafe
                /\ s.readSource = s.source /\ s.readRevision = s.revision
                /\ s.revision < 2
                /\ s' = [s EXCEPT !.revision = @ + 1, !.accepted = @ + 1,
                     !.durable = @ + 1, !.text = "clean", !.io = "idle",
                     !.safeAccept = s.safeAccept /\ Executing = {} /\ Uncommitted = {} /\ s.text = "complete",
                     !.acceptedPendingSafe = s.acceptedPendingSafe /\ s.pendingSafe]
\* Atomic publication is independent of active direct writers, but shares the
\* same source/revision, pending-call and durable-before-active validator.
Publish == /\ ~s.atomic
           /\ s' = [s EXCEPT !.atomic = TRUE, !.atomicSource = s.source,
                              !.atomicRevision = s.revision]
AcceptAtomic == /\ s.atomic /\ s.atomicSource = s.source
                /\ s.atomicRevision = s.revision /\ s.pendingSafe
                /\ s.revision < 2
                /\ s' = [s EXCEPT !.revision = @ + 1, !.accepted = @ + 1,
                                   !.durable = @ + 1, !.atomic = FALSE]
Refresh == /\ s.io = "validate" /\ FreshIO /\ Running = {} /\ Uncommitted = {}
           /\ (s.text = "clean" \/ s.failed \/ ~FreshMirror \/ ~s.pendingSafe)
           /\ s' = [s EXCEPT !.text = "clean", !.mirrorSource = s.source,
                    !.mirrorRevision = s.revision, !.io = "idle", !.failed = FALSE,
                    !.safeRefresh = s.safeRefresh /\ Executing = {}]
EndIO == /\ s.io # "idle" /\ s' = [s EXCEPT !.io = "idle"]
ChangeSource == /\ s.source < 1 /\ s' = [s EXCEPT !.source = @ + 1]
AppendTail == /\ s.tail < 1 /\ s' = [s EXCEPT !.tail = @ + 1]
UnsafeEdit == /\ s.pendingSafe /\ s' = [s EXCEPT !.pendingSafe = FALSE]
\* Reset abandons the old mirror path and fences delayed callbacks/I/O.
Reset == /\ s.epoch < 1
         /\ s' = [s EXCEPT !.epoch = @ + 1, !.calls = IdleTools,
                    !.text = "clean", !.failed = FALSE, !.atomic = FALSE,
                    !.mirrorSource = s.source, !.mirrorRevision = s.revision]
Next == (\E t \in Tools: Admit(t) \/ Execute(t) \/ Partial(t) \/ Write(t) \/
                       Result(t) \/ Fail(t) \/ Exit(t) \/ CommitResult(t)) \/
        BeginRead \/ ReadDone \/ AcceptDirect \/ Publish \/ AcceptAtomic \/
        Refresh \/ EndIO \/ ChangeSource \/ AppendTail \/ UnsafeEdit \/ Reset
Spec == Init /\ [][Next]_vars
NoPartialAcceptance == s.safeAccept
NoOverwriteOfWriter == s.safeRefresh
\* Acceptance abstracts a successful durable write and activation as one action.
\* Persistence failures and suffix contents are checked by implementation tests.
DurableBeforeActive == s.accepted = s.durable
PendingCallSafety == s.acceptedPendingSafe
=============================================================================
