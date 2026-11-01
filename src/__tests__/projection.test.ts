import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { digestMessages } from "../context-document.ts";
import {
	applyProjection,
	createProjectionCheckpoint,
	recoverProjectionFromRetryErrors,
} from "../projection.ts";
import {
	LIVE_CONTEXT_STATE,
	initialLiveContextState,
	reconstructLiveContextState,
	resetProjectionState,
	toOutcomeEntry,
} from "../state.ts";
import type { LiveContextMessage } from "../types.ts";

const raw: LiveContextMessage[] = [
	{ role: "user", content: "task", timestamp: 1 },
	{ role: "assistant", content: [{ type: "text", text: "large investigation" }], timestamp: 2 },
	{ role: "user", content: "tool output".repeat(100), timestamp: 3 },
];
const projected: LiveContextMessage[] = [
	raw[0],
	{ role: "custom", customType: "live-context-projection", content: "Investigation summary", display: false, timestamp: 2 },
];

function checkpoint(revision = 1) {
	return createProjectionCheckpoint({
		revision,
		sourceMessages: raw,
		projectedMessages: projected,
		beforeEstimate: 1_200,
		afterEstimate: 30,
		createdAt: "2026-08-29T00:00:00.000Z",
	});
}

describe("projection rebasing", () => {
	test("replaces the source prefix and appends the raw suffix", () => {
		const suffix = [
			{ role: "assistant", content: [{ type: "text", text: "new turn" }], timestamp: 4 },
			{ role: "user", content: "new result", timestamp: 5 },
		];
		const result = applyProjection([...raw, ...suffix], checkpoint());
		assert.equal(result.valid, true);
		if (!result.valid) return;
		assert.deepEqual(result.messages, [...projected, ...suffix]);
		assert.deepEqual(result.suffix, suffix);
	});

	test("fails closed when the raw prefix changed", () => {
		const changed = raw.map((message) => ({ ...message }));
		changed[1] = { ...changed[1], content: "changed outside projection" };
		const result = applyProjection(changed, checkpoint());
		assert.equal(result.valid, false);
		assert.deepEqual(result.messages, changed);
		assert.match(result.valid ? "" : result.reason, /no longer matches/);
	});

	test("fails closed when the raw context is shorter than the anchor", () => {
		const result = applyProjection(raw.slice(0, 1), checkpoint());
		assert.equal(result.valid, false);
		assert.match(result.valid ? "" : result.reason, /shorter/);
	});

	test("no checkpoint returns a defensive top-level copy", () => {
		const result = applyProjection(raw, undefined);
		assert.equal(result.valid, true);
		assert.notEqual(result.messages, raw);
		assert.deepEqual(result.messages, raw);
	});

	test("checkpoint creation verifies JSON serialization", () => {
		const created = checkpoint();
		assert.doesNotThrow(() => JSON.stringify(created));
		assert.equal(created.sourceDigest, digestMessages(raw));
	});

	test("an entry bookmark decides the prefix without reading its messages", () => {
		const source = (ids: string[]) => ({
			length: ids.length,
			sourceEntryIdAt: (index: number) => ids[index],
			digest() { throw new Error("the prefix digest must not be needed"); },
			slice: (start: number, end = ids.length) => ids.slice(start, end).map((id) => ({ role: "user", content: id, timestamp: 1 })),
		});
		const created = { ...checkpoint(), sourceMessageCount: 2, sourceEntryId: "b" };
		assert.equal(applyProjection(source(["a", "b", "c"]), created).valid, true);
		assert.equal(applyProjection(source(["a", "x", "c"]), created).valid, false);
	});

	test("a checkpoint or source without a bookmark still compares the digest", () => {
		const created = checkpoint();
		assert.equal(created.sourceEntryId, undefined);
		assert.equal(applyProjection(raw, created).valid, true);
		assert.equal(applyProjection(raw, { ...created, sourceEntryId: "b" }).valid, true);
	});

	test("checkpoints record the entry behind their last source message", () => {
		const created = createProjectionCheckpoint({
			revision: 1, projectedMessages: [], beforeEstimate: 1, afterEstimate: 1,
			sourceMessages: { length: 2, sourceEntryIdAt: (index: number) => ["a", "b"][index], digest: () => "0".repeat(64), slice: () => [] },
		});
		assert.equal(created.sourceEntryId, "b");
	});

	test("canonical message digests ignore object key order", () => {
		const left = [{ role: "user", content: "x", timestamp: 1 }];
		const right = [{ timestamp: 1, content: "x", role: "user" }];
		assert.equal(digestMessages(left), digestMessages(right));
	});

	test("recovers retry errors persisted by Pi but removed from its live agent state", () => {
		const anchorSource: LiveContextMessage[] = [
			{ role: "user", content: "task", timestamp: 1 },
			{ role: "assistant", content: "initial answer", stopReason: "stop", timestamp: 2 },
		];
		const anchor = createProjectionCheckpoint({
			revision: 1,
			sourceMessages: anchorSource,
			projectedMessages: anchorSource,
			beforeEstimate: 20,
			afterEstimate: 20,
		});
		const successfulRetry: LiveContextMessage = {
			role: "assistant",
			content: "retry succeeded",
			stopReason: "stop",
			timestamp: 4,
		};
		const targetSource = [...anchorSource, successfulRetry];
		const targetProjection: LiveContextMessage[] = [
			anchorSource[0],
			{ role: "custom", content: "work completed", timestamp: 4 },
		];
		const target = createProjectionCheckpoint({
			revision: 2,
			sourceMessages: targetSource,
			projectedMessages: targetProjection,
			beforeEstimate: 30,
			afterEstimate: 10,
		});
		const persistedRetryError: LiveContextMessage = {
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: "fetch failed",
			timestamp: 3,
		};
		const laterError: LiveContextMessage = {
			role: "assistant",
			content: [],
			stopReason: "error",
			errorMessage: "later terminal error",
			timestamp: 4.5,
		};
		const suffix: LiveContextMessage = { role: "user", content: "next task", timestamp: 5 };
		const resumedRaw = [...anchorSource, persistedRetryError, successfulRetry, laterError, suffix];

		assert.equal(applyProjection(resumedRaw, target).valid, false);
		const recovered = recoverProjectionFromRetryErrors(resumedRaw, target, [anchor, target]);
		assert.equal(recovered.valid, true);
		if (!recovered.valid) return;
		assert.equal(recovered.removedErrorCount, 1);
		assert.equal(recovered.anchorRevision, 1);
		assert.deepEqual(recovered.messages, [...targetProjection, laterError, suffix]);
		assert.deepEqual(recovered.suffix, [laterError, suffix]);
	});

	test("retry recovery never ignores a changed non-error message", () => {
		const anchor = checkpoint(1);
		const target = createProjectionCheckpoint({
			revision: 2,
			sourceMessages: [...raw, { role: "assistant", content: "success", stopReason: "stop", timestamp: 4 }],
			projectedMessages: projected,
			beforeEstimate: 1_300,
			afterEstimate: 30,
		});
		const resumed = [
			...raw,
			{ role: "assistant", content: [], stopReason: "error", errorMessage: "fetch failed", timestamp: 3.5 },
			{ role: "assistant", content: "different success", stopReason: "stop", timestamp: 4 },
		];
		const recovered = recoverProjectionFromRetryErrors(resumed, target, [anchor, target]);
		assert.equal(recovered.valid, false);
	});
});

describe("branch-local state reconstruction", () => {
	test("latest valid state on the supplied branch wins", () => {
		const first = { ...initialLiveContextState(), enabled: false };
		const latest = { ...initialLiveContextState(), revision: 2, checkpoint: checkpoint(2) };
		const reconstructed = reconstructLiveContextState([
			{ type: "custom", customType: LIVE_CONTEXT_STATE, data: first },
			{ type: "custom", customType: LIVE_CONTEXT_STATE, data: { invalid: true } },
			{ type: "custom", customType: LIVE_CONTEXT_STATE, data: latest },
		]);
		assert.deepEqual(reconstructed, latest);
	});

	test("another branch without an entry starts clean", () => {
		assert.deepEqual(reconstructLiveContextState([{ type: "message" }]), initialLiveContextState());
	});

	test("checkpoint-neutral outcome entries keep the active checkpoint", () => {
		const applied = { ...initialLiveContextState(), revision: 1, checkpoint: checkpoint(1) };
		const rejected = toOutcomeEntry({
			...applied,
			lastOutcome: { kind: "rejected", message: "edit grew", at: "2026-08-29T00:00:00.000Z" },
		});
		assert.equal("checkpoint" in rejected, false);
		const reconstructed = reconstructLiveContextState([
			{ type: "custom", customType: LIVE_CONTEXT_STATE, data: applied },
			{ type: "custom", customType: LIVE_CONTEXT_STATE, data: rejected },
		]);
		assert.equal(reconstructed.lastOutcome?.kind, "rejected");
		assert.deepEqual(reconstructed.checkpoint, applied.checkpoint);
	});

	test("a persisted reset after an acceptance leaves no active checkpoint", () => {
		const applied = { ...initialLiveContextState(), revision: 1, checkpoint: checkpoint(1) };
		const reset = resetProjectionState(applied, "native compaction", "2026-08-29T00:00:00.000Z");
		const reconstructed = reconstructLiveContextState([
			{ type: "custom", customType: LIVE_CONTEXT_STATE, data: applied },
			{ type: "custom", customType: LIVE_CONTEXT_STATE, data: reset },
		]);
		assert.equal(reconstructed.revision, 2);
		assert.equal(reconstructed.checkpoint, undefined);
	});

	test("reset clears the checkpoint and advances the revision", () => {
		const state = { ...initialLiveContextState(), revision: 4, checkpoint: checkpoint(4) };
		const reset = resetProjectionState(state, "native compaction", "2026-08-29T00:00:00.000Z");
		assert.equal(reset.revision, 5);
		assert.equal(reset.checkpoint, undefined);
		assert.equal(reset.lastOutcome?.kind, "reset");
	});
});
