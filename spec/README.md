# Context safety model

`ContextSafety.tla` models ordinary file submission, independent context reads,
accepted revisions, pending native work, and the lifetime of overflow artifacts.

```sh
cd spec
java -XX:+UseParallelGC -cp "$TLA_TOOLS_JAR" tlc2.TLC -cleanup -workers 2 \
  -config ContextSafety.cfg ContextSafety.tla
```

Use TLA+ Tools 1.7.4 (TLC 2.19). The checked finite instance has two context
read generations and at most two accepted or invalidated revisions. Before the
corresponding implementation, TLC explored 56,811 generated states and 6,276
distinct states, with no invariant violations.

| Model | Implementation |
|---|---|
| `Begin`, `Submit` | Copy one metadata-bound mirror; atomically rename the completed draft to `LIVE_CONTEXT.commit.md` |
| `Refresh` | Publish another request snapshot without advancing the accepted edit revision |
| `Consume` | Claim one submission, validate immutable baseline and current revision, then persist before activation |
| `Invalidate` | Branch/reset/off transition, conflicting edit, or incompatible source prefix/model |
| `Complete` | Raw appended result stays outside the edited prefix |
| `SaveOutput`, `Persist`, `DeleteMirror` | Publish session-owned output before persisting its path; mirror cleanup does not delete it |
| `Compact`, `Toggle` | Disabled or unavailable editing does not cancel compaction |

The invariants cover fresh acceptance, native call/result conservation, durable
references, and compaction transparency. This is an abstract finite safety check,
not a proof of filesystem atomicity, parser behavior, or unbounded liveness.
The TypeScript tests cover the actual parser, 16-snapshot expiry, late submissions
across intervening requests, failure injection, and file lifetime.

## Optional helper exposure

`ToolExposure.tla` models default direct declarations, explicit code-mode callability,
and invalid configuration refusing to load. It was checked before the exposure option
was implemented: 16 generated states, 7 distinct, no invariant violations. This models
the documented public SDK contract; a stock-SDK test checks the actual registry.

From `spec/`:

```sh
java -XX:+UseParallelGC -cp "$TLA_TOOLS_JAR" tlc2.TLC -cleanup -workers 2 \
  -config ToolExposure.cfg ToolExposure.tla
```

## Native ordering

`NativeOrder.tla` models editable complete pairs, nonadjacent results, pending calls,
and preexisting inverted/orphaned spans. It checks that reordering cannot introduce a
native inversion, while protected source structure is conserved. Checked before the
ordering fix: 395 generated states, 65 distinct, no invariant violations.

From `spec/`:

```sh
java -XX:+UseParallelGC -cp "$TLA_TOOLS_JAR" tlc2.TLC -cleanup -workers 2 \
  -config NativeOrder.cfg NativeOrder.tla
```

## Completed native result bodies

`NativeBody.tla` separates a completed mapped text body from the exact assistant and
result envelopes. Recognized public content cores may carry signatures or arbitrary
extra metadata, all preserved exactly. Mapping the assistant is not required when the
result maps independently. Unknown/malformed cores, pending/deferred/partial/unsettled
assistants, duplicate/unmatched/inverted/name-mismatched groups, and opaque/unmapped
results stay protected. Body edits, caps, and withholding preserve identity, metadata,
and order; ordinary metadata-free text remains editable.

Before the corresponding implementation, the refined finite model passed 174,178
generated states and 15,798 distinct states. `BodyProgress` requires actual shortening
of eligible bodies, not just safety through refusing every edit. Setting the diagnostic
constant `OverprotectMetadata` to `TRUE` reproduces a two-state `BodyProgress` violation;
the checked configuration sets it to `FALSE`. This model abstracts public-field parsing
and group discovery; implementation tests check malformed fields, exact envelopes,
source mapping, completed groups, caps, withholding, and rejected edits.

From `spec/`:

```sh
java -XX:+UseParallelGC -cp "$TLA_TOOLS_JAR" tlc2.TLC -cleanup -workers 2 \
  -config NativeBody.cfg NativeBody.tla
```
