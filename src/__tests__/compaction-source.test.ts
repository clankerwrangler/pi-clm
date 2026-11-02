import assert from "node:assert/strict";
import { test } from "node:test";
import { compactionSource } from "../compaction-source.ts";
import { createProjectionCheckpoint } from "../projection.ts";
import type { LiveContextMessage } from "../types.ts";

test("accepted compaction source keeps the lifetime prefix cold and authentic suffix descriptors", () => {
	const suffix: LiveContextMessage[] = [{ role: "user", content: "new question" }, { role: "assistant", content: [{ type: "text", text: "answer" }] }];
	let reads = 0, current = true;
	const source = { length: 80002, contributions: Array.from({ length: 80002 }, (_, i) => ({ key: `k${i}`, sourceEntryId: `e${i}` })),
		read: (i: number) => { reads++; assert(i >= 80000); return suffix[i - 80000]; }, validate() {} };
	const checkpoint = { ...createProjectionCheckpoint({ revision: 1, sourceMessages: [], projectedMessages: [{ role: "user", content: "accepted notes" }], beforeEstimate: 10, afterEstimate: 1 }), sourceEntryId: "e79999", sourceMessageCount: 80000 };
	const result = compactionSource(source, checkpoint, { headFraction: 0.6 }, () => { if (!current) throw new Error("expired"); });
	assert.equal(reads, 2);
	assert.equal(result.length, 3);
	assert.deepEqual(result.readAll(), [...checkpoint.projectedMessages, ...suffix]);
	assert.deepEqual(result.contributions.slice(1).map(item => item.key), ["k80000", "k80001"]);
	assert.equal("sourceEntryId" in result.contributions[0], false);
	current = false;
	assert.throws(() => result.read(1), /expired/);
});

test("compaction purpose cannot certify capped suffix content or a moved accepted bookmark", () => {
	const messages: LiveContextMessage[] = [{ role: "user", content: "old" }, { role: "toolResult", toolCallId: "c", content: [{ type: "text", text: "long".repeat(1000) }] }];
	const source = { length: 2, contributions: [{ key: "a", sourceEntryId: "a" }, { key: "b", sourceEntryId: "b" }], read: (i: number) => messages[i], validate() {} };
	const checkpoint = { ...createProjectionCheckpoint({ revision: 1, sourceMessages: [messages[0]], projectedMessages: [messages[0]], beforeEstimate: 1, afterEstimate: 1 }), sourceEntryId: "a" };
	const capped = compactionSource(source, checkpoint, { maxCharacters: 100, headFraction: 0.6 }, () => {});
	assert.notEqual(capped.contributions.at(-1)?.key, "b");
	assert.throws(() => compactionSource(source, { ...checkpoint, sourceEntryId: "moved" }, { headFraction: 0.6 }, () => {}), /moved/);
});
