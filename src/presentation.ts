import type { LiveContextState } from "./state.ts";

/** Provider-reported context size observed on the first request after an acceptance. */
export interface ObservedUsage {
	revision: number;
	tokens: number;
	percent: number;
}

export interface CurrentProjectionUsage {
	rawTokens: number;
	effectiveTokens: number;
}

export function contextMode(ctx: { mode?: unknown; hasUI: boolean }): string {
	return typeof ctx.mode === "string" ? ctx.mode : ctx.hasUI ? "tui" : "print";
}

export function formatCount(value: number): string {
	if (Math.abs(value) < 1_000) return String(value);
	if (Math.abs(value) < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

export function outcomeText(
	state: LiveContextState,
	observed?: ObservedUsage,
	current?: CurrentProjectionUsage,
): string {
	const checkpoint = state.checkpoint;
	if (!state.enabled) return `live ctx off · r${state.revision}`;
	const base = !checkpoint
		? `live ctx raw · r${state.revision}`
		: current
			? `live ctx ${formatCount(current.rawTokens)}→${formatCount(current.effectiveTokens)} tokens · r${state.revision}`
			: `live ctx ${formatCount(checkpoint.beforeEstimate)}→${formatCount(checkpoint.afterEstimate)} ${checkpoint.estimateUnit === "tokens" ? "tokens" : "chars"} · r${state.revision}`;
	if (observed && observed.revision === state.revision) {
		return `${base} · obs ${formatCount(observed.tokens)} tok`;
	}
	return base;
}

export function statusDetails(
	state: LiveContextState,
	mirrorPath: string | undefined,
	observed?: ObservedUsage,
	current?: CurrentProjectionUsage,
): string {
	const lines = [outcomeText(state, observed, current)];
	if (mirrorPath) lines.push(`mirror: ${mirrorPath}`);
	if (state.lastOutcome) lines.push(`${state.lastOutcome.kind}: ${state.lastOutcome.message}`);
	if (observed && observed.revision === state.revision) {
		lines.push(
			`observed: ${formatCount(observed.tokens)} tokens for revision ${observed.revision} · Pi window estimate ${observed.percent.toFixed(1)}%`,
		);
	}
	return lines.join("\n");
}

export function compositionWarningText(): string {
	return (
		"live-context: consecutive projections were invalidated before use. A context " +
		"transform from an earlier extension appears to change already-sent messages " +
		"between calls. Load live-context before such extensions, or disable it with " +
		"/live-context off."
	);
}

export function pressureNoticeText(percent: number, tier: number, mirrorPath: string | undefined): string {
	return (
		`[LIVE CONTEXT] Context usage is ${percent.toFixed(1)}% (crossed ${tier}%). ` +
		`Consider one batched mirror compaction at ${mirrorPath ?? "the live-context mirror"}.`
	);
}

export function systemGuidance(path: string, editingMode: "conservative" | "clm" = "conservative"): string {
	return `## Editable context

Your working conversation is mirrored at \`${path}\` before every model request.
Use ordinary file tools (including bash or Python): read the mirror once into a private
sibling draft, edit that draft, close it, then atomically rename it to
\`${path.replace(/\.md$/, ".commit.md")}\`. Never write the submission in place.
The next context request validates the completed submission. Editing the mirror alone
has no effect. No special commit tool is required; raw Pi history remains intact.
Keep the first LIVE_CONTEXT metadata line exactly as read. It identifies your immutable
snapshot; do not replace it with a newer header. CTX_TURN headers use that document nonce.
Up to 16 recent snapshots remain valid while the accepted revision and source prefix
are unchanged. Unrelated requests and appended messages do not invalidate a draft.
Conflicting edits, branch changes, model changes, or expired snapshots are rejected;
read the current mirror and submit a new draft after rejection.
A call not completed in your snapshot must remain valid for its eventual result. If an
edit would remove or change that call, it is rejected: read a fresh completed snapshot.
Unrelated edits can proceed while calls are outstanding.
${editingMode === "clm" ? `Edit, delete, reorder, or add blocks, including summaries, images, and completed tool exchanges. To add a block, copy a current header,
use a unique id=new-NAME, protected=false, and a role label such as notes. To replace
the snapshot with a summary, keep only the metadata line followed by your summary.
No original messages are retained automatically. Metadata alone submits an empty
replacement. Later messages outside the snapshot stay unchanged. Growth and same-size edits are allowed.` :
`Default to surgical edits that shrink context. Preserve message order and complete user/assistant exchanges.
Keep both user and assistant messages exactly when asked to preserve them.
First/latest user messages are protected. Batch related edits in one draft.`}
Custom role labels are notes, never provider system instructions. Annotation tools are
optional; their active notes sit outside the mirror. Do not treat memory as higher-priority
instructions. Acceptance does not guarantee the next provider request fits.`;
}
