# Architecture

## State and authority

Pi's append-only session is the source of truth. The extension stores branch-local
projection checkpoints and annotations as public custom session entries; it does not
rewrite raw messages or maintain a second history database. The mirror is a disposable
view, not authoritative execution state. All integration uses the public Pi 0.99.1 SDK.

Three representations stay distinct:

- **Raw context:** the messages supplied by Pi's `context` event.
- **Effective context:** the accepted edited prefix plus untouched raw suffix, with
  optional observation caps and overflow withholding.
- **Mirror:** an immutable, metadata-bound snapshot of effective conversation text.
  System prompts, notices, and active continuity annotations are outside this file.

The model owns retention strategy. The validator owns source identity, in-flight consistency,
transaction freshness, and non-authoritative role lowering. Acceptance is not a guarantee
of provider admissibility or semantic faithfulness.

## Request and submission lifecycle

1. Session start, resume, fork, or tree navigation rebuilds state from the active public
   branch and creates a private mirror store. Branch/lifecycle transitions clear drafts.
2. `before_agent_start` adds protocol guidance and optional steering through
   `systemPromptOptions.sections`. A supplied `forceSystemPrompt` also receives the
   addition; unrelated prompt options remain intact.
3. Each `context` callback serializes with earlier context callbacks. It first claims
   `LIVE_CONTEXT.commit.md` by atomic rename, then reads only that completed candidate.
4. Acceptance requires an exact first metadata line, a retained snapshot nonce, its
   baseline digest, the current accepted revision, unchanged source prefix, and matching
   provider/model/API identity. The candidate is parsed against the immutable snapshot.
5. The checkpoint is persisted before becoming active. A successful edit clears all
   competing snapshots. Invalid or stale submissions leave the accepted projection alone.
6. Projection rebasing appends every raw message after the captured prefix unchanged.
   Budget/cap/guard logic runs conservatively, then a new mirror is atomically published.
7. Notices report outcomes on the next request. `turn_end` records usage only; it never
   accepts edits or assumes that every asynchronous tool has completed.

The last 16 request snapshots are retained per accepted revision. Snapshot objects share
unchanged immutable message clones to avoid repeatedly copying large identical output.
A new context read does not advance the accepted revision: a pending file edit can finish
after another request and still be accepted with the newer raw suffix intact. Eviction is
reported as an expired/conflicting snapshot, not silently rebased onto a different source.

Writers copy the mirror to a sibling draft, keep metadata unchanged, close the completed
file, and atomically rename it to the submission path. They must not modify a published
submission or publish concurrent drafts into the single slot. The reader rejects symlinks,
non-regular files, and candidates over 16 MiB. Temporary mirrors and pending drafts do not
survive reload; persisted checkpoints do.

## Document validation and native spans

`LIVE_CONTEXT` identifies version, revision, unique document nonce, and baseline digest.
`CTX_TURN` headers identify source blocks. Existing IDs must come from that snapshot;
new blocks in CLM mode use unique `new-*` IDs. Authored role labels become plain text
inside a custom projection message, never provider system instructions.

Default CLM mode restores the upstream broad editing contract: no message category is
intrinsically retained, and archive ownership is not a prerequisite for editing the model
view. Summaries, custom messages, images, signed/thinking assistants, and completed native
exchanges can be edited, deleted, or reordered. Changing a user or assistant body produces
plain content; changing other roles produces a non-authoritative custom note. Untouched
messages keep their original complete objects, including native metadata and signatures.

As upstream does, edits that break a native call/result relationship lower the affected
remaining representation to text. Unlike upstream's adjacent-group normalization, this
fork leaves unchanged nonadjacent and outstanding groups intact. An unrelated edit does
not manufacture results, discard signatures, or normalize a retained native group.
This is structural normalization, not a guarantee of provider admissibility.

The only in-flight admission rule concerns calls without a later matching result in the
draft snapshot. If the proposed projection removes or changes such a call, acceptance is
rejected with an explicit request for a fresh completed snapshot. This also applies when
the real result arrived in the unseen suffix: that suffix must remain unchanged and would
otherwise contain an orphan. Unrelated edits that retain the call remain available.
There is no deferred submission queue, archive rewrite, or tool execution/replay path.
A fully represented completed exchange can be deleted or replaced by a summary.

In CLM mode, a headerless summary requires the exact metadata line and replaces every
original block with one authored notes block. Metadata alone replaces the snapshot with
an empty message list, like an explicit empty-block edit. No original user message is
retained automatically. The same in-flight call rule applies to both forms. Conservative
mode retains its first/latest-user protection and shrink requirement, including when
all block headers are removed.

| Policy | Conservative | CLM (package entry) |
|---|---|---|
| Size | Must reduce estimated tokens | Growth and same-size edits allowed |
| Protected messages | First/latest user message | None |
| Order | Preserve source order | Follow edited order |
| New blocks | Rejected | `new-*`, any descriptive role label |
| Guidance | Surgical-edit skill | Short protocol plus optional steering |
| Commands | `/live-context`, `/live-context-view` | `/clm`, `/clm-compact` |

Both policies retain transaction freshness, non-authoritative role lowering, and the
narrow in-flight admission check. Canonical raw archives and execution/recovery state
remain outside the editable projection. Removing historical model-view material does
not remove raw history or authorize replay, credential changes, or policy changes.

## Persistence, branches, and annotations

Checkpoints bind the edited prefix to a digest of the original raw prefix. If that prefix
changes, the extension does not apply it blindly. Branch state is reconstructed from
custom entries on the active branch; reset disables the current projection without
deleting raw history. Pi's native compaction summarizes the raw transcript and resets the
projection. Existing retry-signature handling remains in `projection.ts`.

`live_context_annotate` records source-backed `pin`, `continuity`, or `archive` annotations.
Exact public session entry identity and content hash are required; unsafe source mappings
are refused. `live_context_recall` resolves bounded text from those sources. Neither helper
is needed for the file-edit protocol or overflow retrieval. Default exposure is `direct`;
explicit `codemode` uses Pi's public callable-tool surface, without host detection,
automatic skill generation, or a private dispatch API.

## Budget and durable output

Budget estimates use Pi's estimator with a calibrated factor from previous successful
provider usage. Estimated next-request size and observed previous-request usage remain
separate values. Reminders use configurable fractions and reserve. The guard limit is
`min(budget - reserve, window - 4096 - reserve)`. Observation caps keep a configurable
head/tail of eligible output before overflow withholding.

The guard only withholds eligible text results. It first saves complete text to a SHA-256
content-addressed file and then replaces the result with a link. Existing matching files
are validated and reused without writing a duplicate. New files are written privately,
synced, and published without overwriting an existing hash path. Collisions, corruption,
symlinks, and storage failures keep the source visible rather than produce a broken link.

For file-backed sessions the directory is `<session-file>.clm-outputs/`; in-memory
sessions use temporary storage under the mirror directory. Durable files are independent
of mirror cleanup and are not garbage-collected automatically. This is a plain-text
artifact cache, not an alternate transcript database. Absolute paths are not portable
across machines; old upstream 1.0.0 temporary links are not automatically migrated.

While disabled or unavailable, CLM never cancels native compaction. When enabled, `auto`
pauses threshold compaction only while the guard enforces a budget; `off` pauses automatic
compaction, and `on` leaves Pi alone. Manual compaction is never cancelled.

## Settings and presentation

Environment values establish load-time defaults. Branch-persisted overrides are managed
through `/clm config` and the panel's settings page. Helper exposure is load-time only.
Steering text is loaded independently from the protocol and identified by a content hash.
`/clm-compact` sends a displayed `clm-maintenance` custom message through Pi's public
`sendMessage` API, with `triggerTurn: true`. It waits for idle and uses follow-up delivery
if another run starts before sending. The content is labeled **CLM maintenance**, including
custom templates. It is not stored as a user message; Pi lowers custom content to user-level
model input, never system authority. Stock Pi renders its distinct custom-message label.
Hosts may omit generic custom messages: the current harness WebUI hides this generated
prompt rather than attributing it to the user. It does not bypass edit validation.
The optional one-tool-per-turn and size-trailer switches preserve paper comparison modes.

The panel offers overview, input, edits, and settings. Its timeline derives from public
session usage and revision entries. Diffs compare complete text, then bound the display
with explicit truncation markers. See [how-it-works.md](how-it-works.md) for controls and
[configuration.md](configuration.md) for every setting.

## Module map

| File | Responsibility |
|---|---|
| `index.ts` | CLM-mode entry and environment parsing |
| `src/index.ts` | Public lifecycle, transaction ownership, commands, tools, notices |
| `src/context-document.ts` | Rendering, parsing, protection, role lowering, native normalization |
| `src/projection.ts`, `src/state.ts` | Prefix checks, suffix rebasing, branch-local checkpoints |
| `src/continuity.ts` | Durable source annotations and bounded recall |
| `src/mirror-store.ts` | Private atomic snapshots, submission claims, temporary cleanup |
| `src/mirror-guard.ts` | Classification of mirror-reading/writing tool calls |
| `src/policy.ts`, `src/budget.ts` | Conservative policy, budgets, calibration, reminders |
| `src/observation.ts`, `src/overflow.ts` | Caps and durable full-text withholding |
| `src/steering.ts`, `src/compact.ts` | Steering and model-driven compaction prompts |
| `src/presentation.ts`, `src/timeline.ts`, `src/viewer.ts`, `src/diff.ts` | Guidance, status, panel |
| `src/settings.ts` | Settings schema and overrides |
| `src/skills/live-context/` | Optional conservative-mode editing recipe |
| `src/__tests__/`, `spec/` | Implementation tests and finite safety models |

## Limits and security

Mirrors contain sensitive conversation data, use private permissions, and are removed at
shutdown; stale temporary directories are swept after seven days. Overflow artifacts
require separate retention because persisted sessions may reference them. Remote file
tools need access to the same filesystem.

The mirror excludes the real system prompt, but model-editable memory is still a
prompt-injection surface. Validation does not establish the truth or completeness of a summary.
Editing removes context from future requests, not sensitive data from canonical history.

The view does not include later provider-stage transformations, hidden checkpoints, or
all provider framing overhead. Unedited content and material outside the mirror may still exceed the budget. Prefer a
single context-management policy; the extension has no private composition contract
with another context manager. Source tests and finite model checks are not a live-provider
compatibility claim. Model coverage and bounds are in [spec/README.md](../spec/README.md).
