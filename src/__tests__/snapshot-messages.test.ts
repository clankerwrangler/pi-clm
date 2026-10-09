import assert from "node:assert/strict";
import { test } from "node:test";

import { SnapshotMessages } from "../snapshot-messages.ts";
import type { LiveContextMessage } from "../types.ts";

const message = (text: string): LiveContextMessage => ({ role: "user", id: "same-id", content: text, timestamp: 1 });

test("fresh message identities share exact immutable content across retained drafts", () => {
	const pool = new SnapshotMessages();
	const input = message("retained payload");
	const first = pool.capture([input]);
	for (let request = 0; request < 20; request++) assert.equal(pool.capture([structuredClone(input)])[0], first[0]);
	assert.notEqual(first[0], input);
	input.content = "changed in place";
	const changed = pool.capture([input]);
	assert.notEqual(changed[0], first[0]);
	assert.equal(first[0].content, "retained payload");
	assert.equal(changed[0].content, "changed in place");
});

test("canonical digest matches still require full content equality", () => {
	const pool = new SnapshotMessages();
	const plain = message("payload");
	const withUndefined = { ...plain, additional: undefined };
	const [left, right] = pool.capture([plain, withUndefined]);
	assert.notEqual(left, right);
	assert.equal(Object.hasOwn(left!, "additional"), false);
	assert.equal(Object.hasOwn(right!, "additional"), true);
});

test("only live owners retain reusable copies, including older changed snapshots", () => {
	const pool = new SnapshotMessages();
	const old = pool.capture([message("old")]);
	const current = pool.capture([message("current")]);
	pool.retain([...old, ...current]);
	assert.equal(pool.capture([message("old")])[0], old[0]);
	pool.retain(current);
	assert.notEqual(pool.capture([message("old")])[0], old[0]);
	assert.equal(pool.capture([message("current")])[0], current[0]);
	pool.clear();
	assert.notEqual(pool.capture([message("current")])[0], current[0]);
	assert.equal(old[0].content, "old");
});


test("nested source mutations cannot change an older snapshot", () => {
	const pool = new SnapshotMessages();
	const input = { role: "user", content: [{ type: "image", mimeType: "image/png", data: "payload" }],
		details: { nested: { values: [1, 2], signed: "opaque" } }, timestamp: 1 };
	const before = structuredClone(input);
	const [saved] = pool.capture([input]);
	input.content[0].data = "changed";
	input.details.nested.values.push(3);
	input.details.nested.signed = "changed";
	assert.deepEqual(saved, before);
	assert.notEqual(pool.capture([input])[0], saved);
	assert.equal(pool.capture([before])[0], saved);
});
