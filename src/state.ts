import {
	isStoredProjectedMessages,
	readStoredMessages,
	storeCheckpointMessages,
	type StoredProjectionCheckpoint,
} from "./checkpoint-store.ts";
import type { ProjectionCheckpoint } from "./projection.ts";
import type { ContextEditTrace, LiveContextMessage } from "./types.ts";

export const LIVE_CONTEXT_STATE = "live-context-state";

export interface LiveContextState {
	version: 1;
	enabled: boolean;
	revision: number;
	checkpoint?: ProjectionCheckpoint;
	event?: {
		kind: "enabled" | "disabled";
		at: string;
	};
	lastOutcome?: {
		kind: "applied" | "rejected" | "reset";
		message: string;
		beforeEstimate?: number;
		afterEstimate?: number;
		estimateUnit?: "characters" | "tokens";
		at: string;
	};
}

export interface SessionEntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
}

export function initialLiveContextState(): LiveContextState {
	return { version: 1, enabled: true, revision: 0 };
}

function isMessageArray(value: unknown): value is LiveContextMessage[] {
	return (
		Array.isArray(value) &&
		value.every(
			(message) =>
				Boolean(message) &&
				typeof message === "object" &&
				typeof (message as LiveContextMessage).role === "string",
		)
	);
}

function isContextEditTrace(value: unknown): value is ContextEditTrace {
	if (!value || typeof value !== "object") return false;
	const trace = value as Partial<ContextEditTrace>;
	if (
		trace.version !== 1 ||
		!Number.isInteger(trace.sourceRevision) ||
		(trace.sourceRevision ?? -1) < 0 ||
		!Number.isInteger(trace.sourceMessageCount) ||
		(trace.sourceMessageCount ?? -1) < 0 ||
		!Number.isInteger(trace.outputMessageCount) ||
		(trace.outputMessageCount ?? -1) < 0 ||
		!Array.isArray(trace.sources) ||
		!Array.isArray(trace.additions)
	) return false;
	const sourceKinds = new Set(["kept", "edited", "removed", "restored", "normalized"]);
	return trace.sources.every((item) =>
		Boolean(item) &&
		typeof item === "object" &&
		Number.isInteger(item.sourceIndex) &&
		item.sourceIndex >= 0 &&
		item.sourceIndex < trace.sourceMessageCount! &&
		sourceKinds.has(item.kind) &&
		(item.outputIndex === undefined ||
			(Number.isInteger(item.outputIndex) && item.outputIndex >= 0 && item.outputIndex < trace.outputMessageCount!)),
	) && trace.additions.every((item) =>
		Boolean(item) &&
		typeof item === "object" &&
		item.kind === "added" &&
		Number.isInteger(item.outputIndex) &&
		item.outputIndex >= 0 &&
		item.outputIndex < trace.outputMessageCount!,
	);
}

export function isProjectionCheckpoint(value: unknown): value is ProjectionCheckpoint {
	if (!value || typeof value !== "object") return false;
	const checkpoint = value as Partial<ProjectionCheckpoint>;
	return (
		checkpoint.version === 1 &&
		Number.isInteger(checkpoint.revision) &&
		Number.isInteger(checkpoint.sourceMessageCount) &&
		(checkpoint.sourceMessageCount ?? -1) >= 0 &&
		typeof checkpoint.sourceDigest === "string" &&
		/^[a-f0-9]{64}$/.test(checkpoint.sourceDigest) &&
		isMessageArray(checkpoint.projectedMessages) &&
		typeof checkpoint.beforeEstimate === "number" &&
		typeof checkpoint.afterEstimate === "number" &&
		(checkpoint.estimateUnit === undefined || checkpoint.estimateUnit === "characters" || checkpoint.estimateUnit === "tokens") &&
		typeof checkpoint.createdAt === "string" &&
		(checkpoint.editTrace === undefined || isContextEditTrace(checkpoint.editTrace))
	);
}

function isStoredProjectionCheckpoint(value: unknown): value is StoredProjectionCheckpoint {
	if (!value || typeof value !== "object") return false;
	const { projectedMessageStore, ...rest } = value as Partial<StoredProjectionCheckpoint>;
	return isStoredProjectedMessages(projectedMessageStore) &&
		!Object.hasOwn(rest, "projectedMessages") &&
		isProjectionCheckpoint({ ...rest, projectedMessages: [] });
}

function hasStateFields(state: Partial<Omit<LiveContextState, "checkpoint">>): boolean {
	return (
		state.version === 1 &&
		typeof state.enabled === "boolean" &&
		Number.isInteger(state.revision) &&
		(state.event === undefined || (
			Boolean(state.event) &&
			(state.event.kind === "enabled" || state.event.kind === "disabled") &&
			typeof state.event.at === "string"
		))
	);
}

export function isLiveContextState(value: unknown): value is LiveContextState {
	if (!value || typeof value !== "object") return false;
	const state = value as Partial<LiveContextState>;
	return hasStateFields(state) && (state.checkpoint === undefined || isProjectionCheckpoint(state.checkpoint));
}

/** A session entry's state, whose checkpoint bodies may still be in the checkpoint store. */
export type PersistedLiveContextState = Omit<LiveContextState, "checkpoint"> & {
	checkpoint?: ProjectionCheckpoint | StoredProjectionCheckpoint;
};

export function isPersistedLiveContextState(value: unknown): value is PersistedLiveContextState {
	if (!value || typeof value !== "object") return false;
	const state = value as Partial<PersistedLiveContextState>;
	return hasStateFields(state) && (state.checkpoint === undefined ||
		isProjectionCheckpoint(state.checkpoint) || isStoredProjectionCheckpoint(state.checkpoint));
}

/**
 * Persist-safe copy whose checkpoint bodies live in the checkpoint store. Without a
 * store directory, or when storage fails, the inline form is returned unchanged.
 */
export function toPersistedEntry(state: LiveContextState, directory: string | undefined): PersistedLiveContextState {
	if (!state.checkpoint || !directory) return state;
	try {
		return { ...state, checkpoint: storeCheckpointMessages(state.checkpoint, directory) };
	} catch {
		return state;
	}
}

/**
 * Resolve an entry's state to its working form. A stored checkpoint whose bodies cannot
 * be read and verified is dropped, so the projection fails closed to raw context.
 */
export function readLiveContextState(value: unknown): LiveContextState | undefined {
	if (isLiveContextState(value)) return value;
	if (!isPersistedLiveContextState(value)) return undefined;
	const { checkpoint, ...rest } = value;
	if (!checkpoint || !isStoredProjectionCheckpoint(checkpoint)) return rest;
	const { projectedMessageStore, ...fields } = checkpoint;
	const projectedMessages = readStoredMessages(projectedMessageStore);
	return projectedMessages ? { ...rest, checkpoint: { ...fields, projectedMessages } } : rest;
}

export function reconstructLiveContextHistory(entries: SessionEntryLike[]): LiveContextState[] {
	return entries
		.filter((entry) => entry.type === "custom" && entry.customType === LIVE_CONTEXT_STATE)
		.flatMap((entry) => {
			const state = readLiveContextState(entry.data);
			return state ? [state] : [];
		});
}

/**
 * Persist-safe copy of the state without the checkpoint payload. Outcomes that do not
 * change the active checkpoint (rejections, on/off toggles) append this slim form so a
 * session file does not accumulate one full projected-transcript copy per outcome.
 */
export function toOutcomeEntry(state: LiveContextState): LiveContextState {
	const entry: LiveContextState = {
		version: 1,
		enabled: state.enabled,
		revision: state.revision,
	};
	if (state.event) entry.event = state.event;
	if (state.lastOutcome) entry.lastOutcome = state.lastOutcome;
	return entry;
}

/**
 * The branch already encodes Pi's active tree path, so the latest valid entry wins.
 * Checkpoint-neutral entries omit the checkpoint payload; the active checkpoint is the
 * newest persisted one whose revision equals the current revision. Acceptance writes
 * both with the same revision and a reset advances the revision past it, so a revision
 * mismatch on the newest stored checkpoint means no checkpoint is active.
 */
export function reconstructLiveContextState(entries: SessionEntryLike[]): LiveContextState {
	return reconstructLiveContextStateNewestFirst((function* () {
		for (let index = entries.length - 1; index >= 0; index--) yield entries[index];
	})());
}

/** Same state selection for lazy archive reads; stops before unrelated older payloads. */
export function reconstructLiveContextStateNewestFirst(entries: Iterable<SessionEntryLike>): LiveContextState {
	let latest: LiveContextState | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== LIVE_CONTEXT_STATE) continue;
		if (!isPersistedLiveContextState(entry.data)) continue;
		if (!latest) {
			latest = readLiveContextState(entry.data)!;
			if (latest.checkpoint || entry.data.checkpoint) return latest;
			continue;
		}
		if (!entry.data.checkpoint) continue;
		// Compare revisions before reading stored bodies for an inactive checkpoint.
		if (entry.data.checkpoint.revision !== latest.revision) return latest;
		const checkpoint = readLiveContextState(entry.data)!.checkpoint;
		return checkpoint ? { ...latest, checkpoint } : latest;
	}
	return latest ?? initialLiveContextState();
}

export function resetProjectionState(
	state: LiveContextState,
	message: string,
	at = new Date().toISOString(),
): LiveContextState {
	return {
		version: 1,
		enabled: state.enabled,
		revision: state.revision + 1,
		lastOutcome: { kind: "reset", message, at },
	};
}
