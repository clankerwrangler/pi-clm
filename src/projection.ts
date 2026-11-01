import { digestMessages } from "./context-document.ts";
import type { ContextEditTrace, LiveContextMessage } from "./types.ts";

/** A captured prefix supplies exact hashes and owned full-value range reads. */
export type ProjectionSource = LiveContextMessage[] | {
	readonly length: number;
	sourceEntryIdAt?(index: number): string | undefined;
	readonly partialDigest?: boolean;
	digest(count?: number): string;
	slice(start: number, end?: number): LiveContextMessage[];
};

export function projectionDigest(messages: ProjectionSource, count = messages.length): string {
	return Array.isArray(messages) ? digestMessages(messages.slice(0, count)) : messages.digest(count);
}

function sourceEntryIdAt(messages: ProjectionSource, index: number): string | undefined {
	return Array.isArray(messages) ? undefined : messages.sourceEntryIdAt?.(index);
}

/** The prefix matches when its last message still comes from the recorded entry. */
function prefixMatches(messages: ProjectionSource, checkpoint: ProjectionCheckpoint): boolean {
	const entryId = sourceEntryIdAt(messages, checkpoint.sourceMessageCount - 1);
	if (entryId !== undefined && checkpoint.sourceEntryId !== undefined) return entryId === checkpoint.sourceEntryId;
	// A plain message array has no ids to compare, and a partial digest can't describe it.
	return checkpoint.sourceDigestPartial === true
		|| projectionDigest(messages, checkpoint.sourceMessageCount) === checkpoint.sourceDigest;
}

/** Whether two sources share their first `count` messages. */
export function samePrefix(left: ProjectionSource, right: ProjectionSource, count: number): boolean {
	const leftId = sourceEntryIdAt(left, count - 1), rightId = sourceEntryIdAt(right, count - 1);
	return leftId !== undefined && rightId !== undefined
		? leftId === rightId
		: projectionDigest(left, count) === projectionDigest(right, count);
}

export const PROJECTION_PREFIX_MISMATCH_REASON =
	"Raw context prefix no longer matches the projection checkpoint.";

export interface ProjectionCheckpoint {
	version: 1;
	revision: number;
	sourceMessageCount: number;
	sourceDigest: string;
	/** The session entry behind the last source message. Older checkpoints omit it. */
	sourceEntryId?: string;
	/** sourceDigest covers only messages after an earlier bookmark, so no full source can match it. */
	sourceDigestPartial?: boolean;
	projectedMessages: LiveContextMessage[];
	beforeEstimate: number;
	afterEstimate: number;
	/** Older checkpoints omitted this field and stored character estimates. */
	estimateUnit?: "characters" | "tokens";
	createdAt: string;
	/** Provenance for the accepted edit that produced projectedMessages. */
	editTrace?: ContextEditTrace;
}

export type ProjectionAnchor = Pick<ProjectionCheckpoint, "revision" | "sourceMessageCount" | "sourceDigest">;

export type ProjectionApplication =
	| {
			valid: true;
			messages: LiveContextMessage[];
			suffix: LiveContextMessage[];
	  }
	| {
			valid: false;
			messages: LiveContextMessage[];
			reason: string;
	  };

export type ProjectionRecovery =
	| {
			valid: true;
			messages: LiveContextMessage[];
			suffix: LiveContextMessage[];
			removedErrorCount: number;
			anchorRevision?: number;
	  }
	| {
			valid: false;
			reason: string;
	  };

function isPersistedRetryError(message: LiveContextMessage): boolean {
	return message.role === "assistant" && message.stopReason === "error";
}

export function createProjectionCheckpoint(options: {
	revision: number;
	sourceMessages: ProjectionSource;
	projectedMessages: LiveContextMessage[];
	beforeEstimate: number;
	afterEstimate: number;
	estimateUnit?: "characters" | "tokens";
	createdAt?: string;
	editTrace?: ContextEditTrace;
}): ProjectionCheckpoint {
	const checkpoint: ProjectionCheckpoint = {
		version: 1,
		revision: options.revision,
		sourceMessageCount: options.sourceMessages.length,
		sourceDigest: projectionDigest(options.sourceMessages),
		sourceEntryId: sourceEntryIdAt(options.sourceMessages, options.sourceMessages.length - 1),
		...(!Array.isArray(options.sourceMessages) && options.sourceMessages.partialDigest ? { sourceDigestPartial: true } : {}),
		projectedMessages: [...options.projectedMessages],
		beforeEstimate: options.beforeEstimate,
		afterEstimate: options.afterEstimate,
		estimateUnit: options.estimateUnit,
		createdAt: options.createdAt ?? new Date().toISOString(),
		editTrace: options.editTrace,
	};

	// Fail at creation time rather than writing an unserializable custom session entry.
	JSON.stringify(checkpoint);
	return checkpoint;
}

/**
 * Replace the checkpoint's raw source prefix and retain every raw message appended after
 * it. A mismatch fails closed and returns the untouched raw context.
 */
export function applyProjection(
	rawMessages: ProjectionSource,
	checkpoint: ProjectionCheckpoint | undefined,
): ProjectionApplication {
	if (!checkpoint) {
		return { valid: true, messages: rawMessages.slice(0), suffix: [] };
	}
	if (checkpoint.version !== 1) {
		return { valid: false, messages: rawMessages.slice(0), reason: `Unsupported projection version: ${checkpoint.version}.` };
	}
	if (rawMessages.length < checkpoint.sourceMessageCount) {
		return {
			valid: false,
			messages: rawMessages.slice(0),
			reason: "Raw context is shorter than the projection source prefix.",
		};
	}

	if (!prefixMatches(rawMessages, checkpoint)) {
		return {
			valid: false,
			messages: rawMessages.slice(0),
			reason: PROJECTION_PREFIX_MISMATCH_REASON,
		};
	}

	const suffix = rawMessages.slice(checkpoint.sourceMessageCount);
	return {
		valid: true,
		messages: [...checkpoint.projectedMessages, ...suffix],
		suffix,
	};
}

/**
 * Pi persists failed assistant responses in JSONL before automatic retry, while its live
 * agent state removes those responses before retrying. A checkpoint accepted later in
 * that process therefore anchors to a prefix without the failed responses. On resume,
 * SessionManager reconstructs them and the otherwise unchanged prefix no longer hashes.
 *
 * Recover only when deleting assistant error responses after a cryptographically matching
 * older checkpoint (or from the beginning) makes the target checkpoint match exactly.
 * No user, successful assistant, or tool message is ever ignored by this compatibility
 * path. The caller should immediately rebase a recovered projection onto the resumed raw
 * transcript so future turns use the normal exact-prefix path again.
 */
export function recoverProjectionFromRetryErrors(
	rawMessages: LiveContextMessage[],
	checkpoint: ProjectionCheckpoint,
	history: readonly ProjectionAnchor[] = [],
): ProjectionRecovery {
	const direct = applyProjection(rawMessages, checkpoint);
	if (direct.valid) {
		return {
			...direct,
			removedErrorCount: 0,
		};
	}

	const candidates: Array<{ sourceMessageCount: number; sourceDigest?: string; revision?: number }> = [
		...history
			.filter((candidate) =>
				candidate.revision < checkpoint.revision &&
				candidate.sourceMessageCount <= checkpoint.sourceMessageCount &&
				rawMessages.length >= candidate.sourceMessageCount,
			)
			.sort((left, right) => right.sourceMessageCount - left.sourceMessageCount)
			.map((anchor) => ({
				sourceMessageCount: anchor.sourceMessageCount,
				sourceDigest: anchor.sourceDigest,
				revision: anchor.revision,
			})),
		{ sourceMessageCount: 0 },
	];
	const seenCounts = new Set<number>();

	for (const anchor of candidates) {
		if (seenCounts.has(anchor.sourceMessageCount)) continue;
		seenCounts.add(anchor.sourceMessageCount);
		const prefix = rawMessages.slice(0, anchor.sourceMessageCount);
		if (anchor.sourceDigest && digestMessages(prefix) !== anchor.sourceDigest) continue;
		const retainedSourceTail: LiveContextMessage[] = [];
		let cursor = anchor.sourceMessageCount;
		let removedErrorCount = 0;
		while (
			prefix.length + retainedSourceTail.length < checkpoint.sourceMessageCount &&
			cursor < rawMessages.length
		) {
			const message = rawMessages[cursor++];
			if (isPersistedRetryError(message)) removedErrorCount += 1;
			else retainedSourceTail.push(message);
		}
		if (removedErrorCount === 0) continue;

		// Only reconcile the target's source prefix. Later error responses are ordinary
		// suffix history and must not be silently removed by checkpoint recovery.
		const candidateMessages = [...prefix, ...retainedSourceTail, ...rawMessages.slice(cursor)];
		const recovered = applyProjection(candidateMessages, checkpoint);
		if (!recovered.valid) continue;
		return {
			...recovered,
			removedErrorCount,
			anchorRevision: anchor.revision,
		};
	}

	return {
		valid: false,
		reason: direct.reason,
	};
}
