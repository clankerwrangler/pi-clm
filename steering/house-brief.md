You manage your future conversational context through the snapshot named in "Editable
context". Follow that section's draft-and-atomic-submission protocol. An accepted edit
changes what you see next; it does not rewrite the canonical session.

When to act
- Watch the [CLM BUDGET] notices; they state the estimated size of the next request and
  the provider-reported size of the previous one. Edit before you reach the reserve, not
  after: one turn with several large tool results can jump past the budget.
- Prefer one larger batched edit over many small ones. Each accepted edit changes the
  request prefix, so everything after the edit point is re-processed by the provider.

What to keep
- The task statement, the current plan, decisions and their reasons, verified facts with
  their sources (file paths, ids, commands), dead ends so you do not retry them, and the
  next action.
- Anything you will need verbatim (exact values, keys, quotes). Either keep it in the
  context, or offload it to a file and keep the path plus a one-line index; re-read on
  demand.

What to drop or shrink
- Raw tool output you have already extracted the facts from: replace the block body with a
  one-line summary of what the command was and what you learned.
- Superseded exploration, duplicated content, your own scratch reasoning once its
  conclusion is recorded.

How to edit
- Copy one mirror snapshot into a private sibling draft. Keep its first metadata line
  unchanged; never combine a newer header with an older body. List only headers from
  that snapshot's document nonce, not whole bodies.
- Edit draft bodies with a small Python script; keep retained headers. Delete a block by
  removing its header and body together. In conservative mode, keep protected user turns unchanged.
- To add a durable note, copy a current header with a unique id starting with `new-`
  (for example `id=new-tracker`) and a descriptive role such as `notes`. Update that note
  later rather than appending duplicates.
- A global summary keeps the exact metadata line but omits turn headers. Use sparingly:
  history is replaced; only the first user turn remains beside the summary.
- A call not completed in the snapshot must remain valid for its eventual result. Read
  a fresh completed snapshot before deleting or summarizing that exchange.
- Close the completed draft, then atomically rename it to the submission path. Do not
  write the submission incrementally or change the mirror directly. Wait for the next
  acceptance notice; after rejection, use a fresh snapshot.
- Read withheld tool output from the file path in its note using bounded file operations.
  Record the extracted fact before moving on.
- Keep a compact tracker (status, done/todo, key facts, next step).
- Never fabricate content in a summary. When unsure, retain the exact text or a verifiable source.
