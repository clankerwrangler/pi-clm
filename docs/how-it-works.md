# How pi-clm works

pi-clm lets the model edit its future conversational context without rewriting Pi's
session history. It uses stock Pi public APIs and ordinary local file operations.

## Snapshot and submission

Before each request, pi-clm writes a private `LIVE_CONTEXT.md` snapshot:

```text
[[LIVE_CONTEXT version=1 revision=2 document=<nonce> baseline=<digest>]]

[[CTX_TURN document=<nonce> index=1 role=user id=1-b1ba26e534cb protected=false]]
Count lines of two commands.

[[CTX_TURN document=<nonce> index=2 role=notes id=new-tracker protected=false]]
TASK TRACKER
- ...
```

1. Read or copy one snapshot into a private draft beside the mirror.
2. Edit the draft with Bash, Python, or another ordinary file tool. Keep its first
   metadata line exactly, together with the headers of retained blocks.
3. Close the completed draft, then **atomically rename** it to `LIVE_CONTEXT.commit.md`
   in the same directory. Do not write that submission path incrementally.
4. The next context request claims and validates the submission. A `[LIVE CONTEXT]`
   notice reports acceptance or rejection. Saving or finishing a tool is not acceptance.

The mirror itself is read-only input to this protocol: direct changes to it are ignored.
Explicit submission prevents a request or turn-end event from accepting a partially
written file while an asynchronous editor is still running. Only one submission slot
exists; do not submit competing drafts concurrently.

The last **16 request snapshots** of the current accepted revision remain eligible.
Unrelated requests and new raw messages do not conflict: an older draft can be accepted
while preserving all messages appended after its source prefix. A conflicting accepted
edit, changed source prefix/model, branch transition, reset, disabling, reload, or snapshot
expiry rejects the old draft. Read the new mirror and prepare a new draft after rejection.
Submissions are limited to 16 MiB.

In default CLM mode, all historical blocks may shrink, grow, be removed, or be reordered,
including summaries, images, custom messages, signed/thinking assistants, and completed
tool exchanges. New blocks use `id=new-…`; their role labels are descriptive text, not
system-message authority. For a whole-context summary, keep the exact metadata line
and replace all turn headers and bodies with your summary. Only the authored summary
remains; no original user or other messages are inserted automatically. To submit an
empty replacement, keep only the metadata line. Messages appended after the selected
snapshot stay unchanged.

Unchanged native groups retain their original structure, even with nonadjacent results.
Editing or partially deleting a completed group can turn its remaining call/result
representation into ordinary text, as in upstream CLM. There is no mandatory historical
retention by content type or archive ownership. The separate conservative mode keeps
first/latest user turns, source order, and a shrink requirement.

One in-flight constraint applies: a call not completed in the draft snapshot must remain
valid in the proposed projection, because its result may arrive after that snapshot.
An edit that removes or changes it is rejected with a fresh-completed-snapshot notice;
it is not queued for later acceptance. Unrelated edits still work. Read a new snapshot
containing the completed exchange before deleting or summarizing that exchange. Later
raw messages are appended unchanged; projection edits never execute or replay tools.

## What runs without the model

- **Overflow guard:** over budget, eligible old tool-result text is replaced with a note
  linking to a full-text file. File-backed sessions store content-addressed files under
  `<session-file>.clm-outputs/`, outside the disposable mirror. Ordinary file tools can
  read them; the optional recall tool is not required. Failed saves keep the source text.
- **Calibration:** provider-reported usage adjusts the character-based estimate.

The default compaction policy pauses Pi's threshold compaction only while CLM is enabled,
its mirror is available, and the guard enforces a budget. `/clm off` leaves every native
compaction reason untouched. Manual `/compact` still summarizes raw history and resets
the projection; `/clm-compact` asks the model to submit its own edit instead.

## The panel

`/clm` opens the panel; `/clm overview|input|edits|settings` opens a page directly
(outside the TUI it prints the page). `1–4` or `Tab` switch pages, `q` closes.

- **overview** — context size per request, the budget as a dashed line, and the points
  where an edit was accepted. It opens on the latest request; `← →` step through
  compaction points (the chart pans to keep the selection centred) and back to now; `z`
  cycles the x axis between **all** (the whole history fitted into the width, the default;
  peak per bucket), **detail** (one column per request, panning) and **turns** (one column
  per user turn); `Enter` opens a compaction point in **edits** (or, at now, the current
  input).
- **input** — how much of the raw transcript the model currently sees, and the effective
  message list.
- **edits** — per revision, every message before and after. `Enter` expands a message into
  a side-by-side diff (changed words highlighted; one column below 60 columns), `a`
  expands all, `↑ ↓` scroll through a long diff, `← →` switch revisions.
- **settings** — sizes, the guard limit and files above the settings list; `↑ ↓` select and
  `Enter` changes a setting (cycles its choices, or asks for a value). Changes apply at
  once and are saved in the session; see [configuration.md](configuration.md).

## Storage and safety

Mirror files contain conversation data, with private directory/file permissions under
the OS temporary directory. They are removed at shutdown. Durable overflow files use
private permissions and survive shutdown, resume, and projection reset. They are not
automatically garbage-collected; retain them as long as any session references them.
In-memory sessions have only temporary output storage.

Branches copied on the same host can continue reading the original artifact paths.
Moving a session to another machine does not relocate absolute links: preserve the
referenced files and paths when moving it. Already-broken temporary links written by
upstream 1.0.0 are not repaired automatically; the original result may still exist in the
canonical session history.

Model-editable memory is a prompt-injection surface. The real system prompt stays out
of the mirror and authored roles become plain text, but the extension cannot judge
whether the model has discarded a fact it needs. Remote tool backends need access to
the same filesystem to use the protocol. No helper-tool bridge is required for editing
or reading overflow files. Optional annotation/recall tools are described in the
[configuration guide](configuration.md).

## Further reading

[architecture.md](architecture.md) describes the system as implemented: the request
lifecycle, the mirror format, validation, persistence and branches, the budget, the
overflow guard, settings, the panel, and the design notes and known limitations.
