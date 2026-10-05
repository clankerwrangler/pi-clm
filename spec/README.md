# Context models

These finite TLA+ models are checked before their corresponding implementation changes.
They abstract parsing, public SDK serialization, filesystem atomicity, and runtime services;
implementation and integration tests cover those boundaries separately.

From `spec/`, set `TLA_TOOLS_JAR` to the local TLA+ tools jar:

```sh
for model in ProjectionEditing ContextSafety ToolExposure Maintenance AutomaticCompactionPolicy; do
  java -XX:+UseParallelGC -cp "$TLA_TOOLS_JAR" tlc2.TLC -cleanup -workers 2 \
    -config "$model.cfg" "$model.tla"
done
```

## Model-view editing

`ProjectionEditing.tla` replaces the superseded native-body retention and native-order
models. CLM editing, deletion, reordering, and whole-summary replacement must make
progress across summaries, custom content, images, signed/thinking content, and plain
history. Completed groups can disappear; retained groups stay exact unless the edit
breaks their relationships. This is not an invariant that all historical native material
must remain in the model view.

The one in-flight admission case is explicit: removing or changing an outstanding call
rejects the proposal, including when its result is in a later unseen suffix. A fresh
completed snapshot enables broad replacement. Unrelated edits retaining the call succeed.
The raw archive, execution ledger/dispatch count, and unseen suffix remain unchanged.
Conservative mode is modeled separately from default CLM mode.

Headerless summaries contain only the authored note, and empty replacement removes all
snapshot messages. Neither form inserts the original task. Unseen suffixes remain exact;
open calls still require the in-flight admission rule. The first-user-restoration negative
control fails `SummaryProgress`.

The checked finite instance passed **11,664 generated / 7,776 distinct states**. A diagnostic
variant that restricts editing to plain content fails the progress invariant, so refusing
all mixed-content edits is not a valid solution. The model does not prove implementation
closure discovery, provider legality, or unbounded liveness.

## Submission, artifacts, and compaction

`ContextSafety.tla` models ordinary atomic file submission, independent context reads,
accepted revisions, raw execution completion, and the lifetime of overflow artifacts.
The obsolete equality between raw and projected native history has been removed: a
projection is not execution state. `Consume` cannot execute a tool or change raw closure.
The invariants cover fresh acceptance, disjoint pending/completed execution state,
durable references, and compaction transparency when CLM is disabled or unavailable.

The bounded instance has two context-read generations and at most two accepted or
invalidated revisions: **56,811 generated / 6,276 distinct states**, no violations.
TypeScript tests cover the actual metadata/source guards, 16-snapshot expiry, late
submissions, failure injection, persistence, and file lifetime.

## Automatic compaction policy

`AutomaticCompactionPolicy.tla` covers current enablement, mirror availability, editing
mode, native policy, budget/window availability, guard mode, and compaction reason.
Early and late decisions agree after policy changes; manual, disabled, unavailable,
and explicitly permitted paths remain available. The finite instance passed
**112,128 generated / 1,536 distinct states**. It abstracts callback scheduling and
runtime subscription lifetime; public event-bus integration tests cover those boundaries.

## Maintenance command

`Maintenance.tla` models the compact command waiting for idle, an idle-race follow-up,
stale-context cancellation, one custom-message delivery and prepared model request,
then ordinary user input on the same session. The generated message cannot enter user
admission or acquire user provenance. Duplicate commands while waiting are inert.
**60 generated / 23 distinct states**, no violations. This finite transition model does
not prove runtime scheduling or rendering; registered-command and rendering integration
tests check those boundaries separately.

## Optional helper exposure

`ToolExposure.tla` models default direct declarations, explicit code-mode callability,
and invalid configuration refusing to load: **16 generated / 7 distinct states**, no
violations. A stock-SDK test checks the actual public registry contract.
