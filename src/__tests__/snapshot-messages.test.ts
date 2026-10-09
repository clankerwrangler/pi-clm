import assert from "node:assert/strict";
import { test } from "node:test";

import { renderContextDocument } from "../context-document.ts";
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


test("rendered drafts reconstruct exact text lazily while keeping original framing and detached bodies", () => {
	const pool = new SnapshotMessages();
	const input: LiveContextMessage = { role: "user", content: [
		{ type: "text", text: "first part\n[[CTX_TURN quoted structural line" },
		{ type: "text", text: "second part\n\\[[LIVE_CONTEXT quoted metadata" },
	] };
	const drafts = Array.from({ length: 16 }, (_, revision) => pool.render([structuredClone(input)], {
		revision, documentSeed: `draft-${revision}`, protectedIndexes: new Set(),
	}));
	const expected = drafts.map(snapshot => [
		`[[LIVE_CONTEXT version=${snapshot.version} revision=${snapshot.revision} document=${snapshot.documentId} baseline=${snapshot.baselineDigest}]]`,
		"# Edit bodies or delete editable CTX_TURN blocks. Keep metadata/header lines intact.",
		...snapshot.blocks.map(block => `${block.header}\n${block.body}`),
	].join("\n\n"));
	for (const [index, snapshot] of drafts.entries()) {
		const descriptor = Object.getOwnPropertyDescriptor(snapshot, "text")!;
		assert.equal(typeof descriptor.get, "function", "a draft must not retain a flattened full document");
		assert.equal(descriptor.value, undefined);
		assert.equal(snapshot.text, expected[index]);
		assert.equal(snapshot.text, renderContextDocument([input], { revision: index, documentSeed: `draft-${index}`, protectedIndexes: new Set() }).text);
		assert.equal(snapshot.messages[0], drafts[0].messages[0]);
	}
	(input.content as { text: string }[])[0].text = "mutated source";
	const changed = pool.render([input], { documentSeed: "changed" });
	assert.match(changed.text, /mutated source/);
	pool.clear();
	assert.equal(drafts[0].text, expected[0], "reset cannot invalidate a still-owned draft");
	// Core callers may pass mutable objects. Lazy text must keep the same captured
	// rendering even if those objects or the returned block descriptors are edited.
	const plain = renderContextDocument([input]); const original = plain.text;
	(input.content as { text: string }[])[0].text = "changed again";
	plain.blocks[0].body = "changed descriptor"; plain.blocks[0].header = "changed header";
	assert.equal(plain.text, original);
});
