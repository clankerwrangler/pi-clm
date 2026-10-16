import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { access, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MirrorStore } from "../mirror-store.ts";

async function withParent<T>(fn: (parent: string) => Promise<T>): Promise<T> {
	const parent = await mkdtemp(join(tmpdir(), "live-context-store-test-"));
	try {
		return await fn(parent);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
}

describe("MirrorStore", () => {
	test("writes atomically with private directory and file modes", async () => {
		await withParent(async (parent) => {
			const store = await MirrorStore.create("session/with unsafe chars", parent);
			await store.write("revision one");
			assert.equal(await store.read(), "revision one");
			assert.equal(await readFile(store.filePath, "utf8"), "revision one");
			assert.equal((await stat(store.directory)).mode & 0o777, 0o700);
			assert.equal((await stat(store.filePath)).mode & 0o777, 0o600);

			await store.write("revision two");
			assert.equal(await store.read(), "revision two");
			await store.cleanup();
			await assert.rejects(access(store.directory));
		});
	});

	test("uses unique directories for concurrent sessions", async () => {
		await withParent(async (parent) => {
			const left = await MirrorStore.create("same-session", parent);
			const right = await MirrorStore.create("same-session", parent);
			assert.notEqual(left.directory, right.directory);
			await Promise.all([left.cleanup(), right.cleanup()]);
		});
	});

	test("creation sweeps stale mirror directories and keeps recent ones", async () => {
		await withParent(async (parent) => {
			const stale = join(parent, "pi-live-context-crashed-abc123");
			await mkdir(stale);
			await writeFile(join(stale, "LIVE_CONTEXT.md"), "orphaned");
			const past = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
			await utimes(stale, past, past);

			const recent = join(parent, "pi-live-context-running-def456");
			await mkdir(recent);
			const unrelated = join(parent, "unrelated-directory");
			await mkdir(unrelated);

			const store = await MirrorStore.create("session", parent);
			await assert.rejects(access(stale));
			await assert.doesNotReject(access(recent));
			await assert.doesNotReject(access(unrelated));
			await store.cleanup();
		});
	});

	test("cleanup is idempotent and disposed stores reject writes", async () => {
		await withParent(async (parent) => {
			const store = await MirrorStore.create("session", parent);
			await store.cleanup();
			await store.cleanup();
			assert.equal(await store.read(), undefined);
			await assert.rejects(store.write("late write"), /disposed/);
		});
	});
});


test("an exclusive snapshot create collision preserves the earlier owner's exact sole value", async () => {
	const store = await MirrorStore.create("snapshot-collision");
	const uuid = crypto.randomUUID;
	try {
		crypto.randomUUID = () => "00000000-0000-4000-8000-000000000000";
		syncBuiltinESMExports();
		const name = store.writeSnapshot(Buffer.from("original owned value"));
		assert.throws(() => store.writeSnapshot(Buffer.from("unpublished replacement")), { code: "EEXIST" });
		assert.equal(store.readSnapshot(name).toString(), "original owned value");
	} finally { crypto.randomUUID = uuid; syncBuiltinESMExports(); await store.cleanup(); }
});
