import assert from "node:assert/strict";
import { test } from "node:test";

import { renderContextDocument } from "../context-document.ts";
import { MirrorStore } from "../mirror-store.ts";
import { createProjectionCheckpoint } from "../projection.ts";
import { digestMessages } from "../context-document.ts";
import { readdir } from "node:fs/promises";
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


test("source captures own exact old values, share 16 prefixes, and release files only after the final owner", async () => {
	const store = await MirrorStore.create("source-snapshot-test");
	try {
		const pool = new SnapshotMessages();
		const values: LiveContextMessage[] = [];
		let reads = 0;
		let live = true;
		const source = () => ({ length: values.length, contributions: values.map((_, index) => ({ key: `generation-1:${index}` })),
			read(index: number) { assert.ok(live); reads++; return values[index]; }, validate() { assert.ok(live); } });
		const profile = () => ({ tokens: 1, visible: true });
		const views = [];
		const originals = [];
		for (let index = 0; index < 16; index++) {
			values.push({ ...message(`payload-${index}`), optional: undefined, opaque: new Uint8Array([index]) });
			originals.push(structuredClone(values));
			views.push(pool.captureSource(source(), store, profile));
		}
		assert.equal(reads, 16, "appends must not hydrate the preceding 120 contributions");
		assert.equal(views[0].items[0], views[15].items[0]);
		// Persistence/expiration may destroy an unflushed source's last owned object.
		live = false; values[0].content = "overwritten at same ID/path";
		for (const [index, view] of views.entries()) {
			assert.deepEqual(view.readAll(), originals[index]);
			assert.equal(view.digest(), digestMessages(originals[index]));
			assert.equal(view.digest(1), digestMessages(originals[index].slice(0, 1)));
			assert.equal(view.items.every(item => item.value.file !== undefined), true);
		}
		pool.retainCaptured(views);
		assert.equal((await readdir(store.directory)).length, 16);
		pool.retainCaptured([views[15]]);
		assert.deepEqual(views[15].readAll(), originals[15]);
		pool.retainCaptured([]);
		assert.deepEqual(await readdir(store.directory), []);
	} finally { await store.cleanup(); }
});

test("captured documents share full-value payloads but preserve each frame and undefined fields", async () => {
	const store = await MirrorStore.create("source-document-test");
	try {
		const pool = new SnapshotMessages();
		const input = { ...message("body\n[[CTX_TURN quoted"), optional: undefined };
		const profile = () => ({ tokens: 1, visible: true });
		const documents = Array.from({ length: 16 }, (_, index) => pool.captureDocument([input], store, profile,
			{ revision: 0, documentSeed: `frame-${index}` }));
		assert.equal(new Set(documents.map(document => document.messages.items[0])).size, 1);
		assert.equal((await readdir(store.directory)).length, 2, "one message and one escaped body, not 16 whole document copies");
		for (const [index, document] of documents.entries()) {
			const expected = renderContextDocument([input], { revision: 0, documentSeed: `frame-${index}` });
			assert.equal(document.readText(), expected.text);
			assert.deepEqual(document.read(), { ...expected, text: expected.text });
		}
		input.content = "changed";
		pool.retainCaptured(documents);
		assert.equal(documents[0].read().messages[0].content, "body\n[[CTX_TURN quoted");
		assert.equal(Object.hasOwn(documents[0].read().messages[0], "optional"), true);
		const plain = pool.captureDocument([message("body\n[[CTX_TURN quoted")], store, profile, { documentSeed: "without-undefined" });
		assert.notEqual(plain.messages.items[0], documents[0].messages.items[0], "canonical equality is not full-value equivalence");
		pool.retainCaptured([]);
		assert.deepEqual(await readdir(store.directory), []);
	} finally { await store.cleanup(); }
});

test("failed capture publishes nothing and cannot retain a borrowed source or delete an existing owner", async () => {
	const store = await MirrorStore.create("source-failure-test");
	try {
		const pool = new SnapshotMessages(); const profile = () => ({ tokens: 1, visible: true });
		const kept = pool.captureValues([message("kept")], store, profile);
		const write = store.writeSnapshot.bind(store); let writes = 0;
		store.writeSnapshot = bytes => { if (++writes === 2) throw new Error("synthetic disk failure"); return write(bytes); };
		const input = [message("new-a"), message("new-b")];
		assert.throws(() => pool.captureValues(input, store, profile), /synthetic disk failure/);
		assert.equal(input[1].content, "new-b");
		assert.deepEqual(kept.readAll(), [message("kept")]);
		assert.equal((await readdir(store.directory)).length, 1, "unpublished captures must release their partial files");
		pool.retainCaptured([kept]);
	} finally { await store.cleanup(); }
});


test("canonical final and projected captures share exact file values while preserving separate prefix cursors", async () => {
	const store = await MirrorStore.create("source-final-owner-test");
	try {
		const pool = new SnapshotMessages(); const profile = () => ({ tokens: 1, visible: true });
		let reads = 0;
		const source = (prefix: string) => ({ length: 1, contributions: [{ key: prefix }],
			read() { reads++; return message("unchanged exact value"); }, validate() {} });
		const projected = pool.captureSource(source("projected"), store, profile);
		const canonical = pool.captureSource(source("canonical"), store, profile);
		assert.equal(projected.items[0].value, canonical.items[0].value);
		assert.equal((await readdir(store.directory)).length, 1);
		pool.retainCaptured([projected, canonical]);
		const nextProjected = pool.captureSource(source("projected"), store, profile, projected);
		const nextCanonical = pool.captureSource(source("canonical"), store, profile, canonical);
		assert.equal(reads, 2, "both frozen identities are captured once, not at each source-space transition");
		assert.equal(nextProjected.digest(), nextCanonical.digest());
		pool.retainCaptured([nextCanonical]);
		assert.deepEqual(nextCanonical.readAll(), [message("unchanged exact value")]);
		pool.retainCaptured([]); assert.deepEqual(await readdir(store.directory), []);
	} finally { await store.cleanup(); }
});


test("historical checkpoint payloads remain exact file-backed owners across draft pruning and later input mutation", async () => {
	const store = await MirrorStore.create("snapshot-checkpoint-history");
	try {
		const pool = new SnapshotMessages();
		const checkpoint = createProjectionCheckpoint({ revision: 7, sourceMessages: [message("raw source")],
			projectedMessages: [{ ...message("old projected body"), additional: undefined }], beforeEstimate: 20, afterEstimate: 10 });
		const expected = structuredClone(checkpoint);
		const captured = pool.captureCheckpoint(checkpoint, store);
		assert.deepEqual(Object.keys(captured.frame).sort(), ["revision", "sourceDigest", "sourceMessageCount"]);
		assert.ok(captured.value.file);
		checkpoint.projectedMessages[0].content = "mutated newer working value";
		pool.retainCaptured([captured]);
		assert.deepEqual(captured.read(), expected);
		assert.equal(Object.hasOwn(captured.read().projectedMessages[0], "additional"), true);
		pool.retainCaptured([]);
		assert.deepEqual(await readdir(store.directory), []);
	} finally { await store.cleanup(); }
});
