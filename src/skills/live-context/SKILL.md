---
name: live-context
description: Compact stale conversation history through Pi's private live-context mirror. Use when context pressure is high, tool outputs are large, or old exploration should be replaced by a durable summary.
---

# Live Context Management

Pi's live-context extension places the current model-visible conversation in the mirror
path named in the `## Editable context` section of the system prompt.

Use the mirror only when a meaningful batch compaction will improve future work. Do not
compact after every turn.

## Rules

1. Do **not** print or `cat` the entire mirror. Its contents are already in context.
2. Preserve the `[[LIVE_CONTEXT ...]]` line and every retained `[[CTX_TURN ...]]` header.
3. Never rewrite, remove, or move a `protected=true` turn; native/opaque spans remain exact.
   A completed text result paired with a protected call permits body-only edits: keep its
   header, role, and source order after the call. Do not delete it or replace it with a global
   summary; shorten its body instead.
4. Make one batched draft submission. This is an atomicity rule, **not** a request
   for one global summary. One submission should contain as many independent, localized block
   replacements or removals as the revision needs. Read-only inspection is never counted.
5. Default to a **surgical revision**: preserve message order and conversational structure,
   leave unrelated blocks unchanged, shorten stale bodies in place, and remove only
   clearly obsolete or redundant blocks. Do not repeatedly collapse the whole effective
   context into the same summary shape.
6. Preserve complete conversational units. If a user request remains relevant, normally
   retain its corresponding assistant analysis or replace that analysis with a local,
   specific summary at the same position. Do not keep only user messages while silently
   deleting all assistant-side reasoning and results.
7. Interpret retention language precisely:
   - "keep/preserve these messages" means retain the referenced user **and** assistant
     messages exactly unless the user narrows the roles;
   - "preserve the findings/analysis" permits a faithful semantic summary;
   - if the boundary or exactness is genuinely ambiguous, ask rather than choosing the
     most destructive interpretation.
8. Use one global consolidation only when the user explicitly requests deep/aggressive
   compression. Context pressure by itself is not permission to flatten every episode.
9. The complete result must have a lower Pi-estimated token count. Prefer removing large
   tool output and superseded exploration before compressing useful dialogue.
10. Preserve decisions, constraints, unresolved questions, file paths, commands still
    needed, test results, provenance that explains conclusions, and the next action.
11. Wait for the next `[LIVE CONTEXT]` notice to confirm whether the edit was accepted.

## Expected edit shape

Prefer a sparse patch over the existing conversation:

```text
before: user A -> assistant investigation A -> tool output -> user B -> assistant result B
after:  user A -> concise assistant A       -> user B      -> concise assistant B
```

Avoid flattening independent episodes into one synthetic message:

```text
avoid:  user A -> one global summary of everything -> user B
```

The concise assistant replacements should remain separate blocks near the requests they
answer. Existing good summaries should normally remain untouched in later revisions.

## Edit cost

An accepted edit changes the request prefix, so the provider re-processes everything
after the edit point on the next call and cached prefix tokens from that point on are
recomputed. Consequences:

- One large batched compaction costs less than several small edits.
- Compact stale early turns before a long, still-useful tail accumulates below them.
- Make replacement summaries detailed. The text after the edit is re-processed either
  way, so a thorough summary adds little cost and prevents repeated re-investigation.

## Recommended method

Copy the mirror once to a private sibling draft. Do not edit the mirror itself: another
request may refresh it while a tool is running. Keep the draft's metadata line unchanged.
List only headers carrying that draft's document nonce; body text can contain misleading
header-shaped examples.

```python
from pathlib import Path
import os, re, tempfile

mirror = Path("<mirror path from system prompt>")
fd, name = tempfile.mkstemp(prefix=".clm-draft-", dir=mirror.parent)
draft = Path(name)
with os.fdopen(fd, "w") as f:
    f.write(mirror.read_text())
lines = draft.read_text().splitlines()
meta = re.fullmatch(r"\[\[LIVE_CONTEXT .* document=([a-f0-9]{64}) baseline=[a-f0-9]{64}\]\]", lines[0])
if not meta:
    raise SystemExit("invalid live-context metadata")
doc = meta.group(1)
print(f"draft: {draft}")
print(lines[0])
for line in lines[1:]:
    if line.startswith(f"[[CTX_TURN document={doc} "):
        print(line)
```

Use the same private draft and exact IDs in the editing script. Replace only intended
bodies, without printing or retyping their old contents. For example:

```python
from pathlib import Path
import os, re

draft = Path("<private draft path from the previous step>")
s = draft.read_text()
turn_id = "<id from a CTX_TURN header in this draft>"
summary = "[summary: exact findings, decisions, files, and next action]"
pattern = rf"(^\[\[CTX_TURN [^\n]* id={re.escape(turn_id)} [^\n]*\]\]\n).*?(?=\n\n\[\[CTX_TURN |\Z)"
s, count = re.subn(pattern, lambda m: m.group(1) + summary, s, count=1, flags=re.M | re.S)
if count != 1:
    raise SystemExit(f"turn not found: {turn_id}")
draft.write_text(s)  # closes before publication
os.replace(draft, draft.with_name("LIVE_CONTEXT.commit.md"))
```

Apply all disjoint edits before publishing. The next context request claims the complete
submission; `turn_end` and a successful file write do not imply acceptance. Never write
the submission incrementally or change it after publication. Submit only one draft at a
time. The last 16 snapshots remain valid within an accepted revision: intervening context
reads and appended raw messages are safe, but conflicting edits, branch/model changes,
reload, or expiry reject the draft. Read a fresh snapshot after rejection.

Prefer several local replacements over flattening unrelated episodes. Retain complete
exchanges and delete only material whose value is captured nearby. Do not invent existing
IDs or duplicate blocks. Submissions must be regular files no larger than 16 MiB.

## Durable continuity annotations

When the optional helper tools are available, before removing or rewriting an exact
source that later work must revisit, call
`live_context_annotate` with the source block ID from its current `CTX_TURN` header:

- `pin` keeps a bounded exact textual source visible;
- `continuity` keeps its title, reason, next action, and recall ID visible while allowing
  the source to be summarized;
- `archive` keeps no normal-context pointer and is available only through bounded recall.

Use `live_context_recall` only when the source is needed. Resolve an annotation once its
future action is complete. An annotation complements a surgical edit; it is not a license
to collapse unrelated messages.

## What a durable summary should contain

```markdown
[summary]
Goal: ...
Constraints: ...
Findings:
- ...
Decisions:
- ...
Files and state:
- path: relevant status
Validation:
- command/result
Open questions:
- ...
Next action: ...
[/summary]
```

Prefer concrete state over narrative. A future model turn should be able to continue from
the summary without needing the removed output.
