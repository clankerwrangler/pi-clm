import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Agent } from "@earendil-works/pi-agent-core";
import {
	buildContextEntries, createAgentSession, DefaultResourceLoader, ModelRuntime,
	prepareCompactionFromSource, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { SessionManager as ProgrammaticSessionManager } from "@earendil-works/pi-coding-agent/programmatic";

import liveContextExtension from "../index.ts";
import { createProjectionCheckpoint } from "../projection.ts";
import { LIVE_CONTEXT_STATE } from "../state.ts";

// A mixed stock/fork graph can satisfy semver while losing the source contracts.
test("matched SDK exposes source APIs and shares direct/transitive Pi identities", () => {
	assert.equal(SessionManager, ProgrammaticSessionManager);
	assert.equal(typeof Agent.prototype.setMessageSource, "function");
	const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
	const overrides = manifest.pnpm.overrides;
	const identities = new Map<string, string>();
	const pending: string[] = [];
	function visit(name: string, from: string) {
		assert.equal(typeof overrides[name], "string", `${name} needs a matched snapshot override`);
		const path = realpathSync(findPackageJSON(name, from)!);
		const previous = identities.get(name);
		if (previous) assert.equal(path, previous, `${name} has more than one resolved identity`);
		else { identities.set(name, path); pending.push(path); }
	}
	for (const name of Object.keys(manifest.devDependencies)) {
		if (name.startsWith("@earendil-works/pi-")) visit(name, import.meta.url);
	}
	assert.ok(identities.size >= 4);
	while (pending.length) {
		const path = pending.pop()!;
		const pkg = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(pkg.version, "1.5.0", pkg.name);
		for (const name of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
			if (name.startsWith("@earendil-works/pi-") || name === "@earendil-works/chord") visit(name, path);
		}
	}
});

for (const restore of ["reader", "source", "legacy"] as const) {
	test(`matched SDK: ${restore} restoration, source dispatch and certified accepted compaction`, async (t) => {
		const directory = await mkdtemp(join(tmpdir(), "clm-sdk-integration-"));
		t.after(() => rm(directory, { recursive: true, force: true }));
		const path = join(directory, "synthetic.jsonl");
		const raw = ["original task", "old details", "new question", "latest question"].map((content, index) => ({
			role: "user" as const, content, timestamp: index + 1,
		}));
		const projected = [{ role: "user" as const, content: "accepted notes", timestamp: 2 }];
		const checkpoint = { ...createProjectionCheckpoint({
			revision: 1, sourceMessages: raw.slice(0, 2), projectedMessages: projected, beforeEstimate: 100, afterEstimate: 10,
		}), sourceEntryId: "message-1", sourceMessageCount: 2 };
		const entries = [
			...raw.slice(0, 2).map((message, index) => ({ type: "message", id: `message-${index}`, message })),
			{ type: "custom", id: "accepted", customType: LIVE_CONTEXT_STATE, data: { version: 1, enabled: true, revision: 1, checkpoint } },
			...raw.slice(2).map((message, index) => ({ type: "message", id: `message-${index + 2}`, message })),
		].map((entry, index, all) => ({ ...entry, parentId: index ? all[index - 1].id : null, timestamp: "2026-01-01T00:00:00Z" }));
		await writeFile(path, [
			JSON.stringify({ type: "session", version: 3, id: "clm-sdk-integration", cwd: directory, timestamp: "2026-01-01T00:00:00Z" }),
			...entries.map((entry) => JSON.stringify(entry)), "",
		].join("\n"), { mode: 0o600 });
		const manager = SessionManager.open(path, directory, directory, { entryRetention: { maxCachedBytes: 0 } });
		assert.equal(typeof manager.getSourceWatermark, "function");
		assert.equal(typeof manager.subscribeSourceWatermark, "function");
		const borrowedReader = manager.buildSessionEntryReader();
		assert.equal(borrowedReader.read(2, borrowedReader.getEntryHeader(2).key).id, "accepted");
		let readerCalls = 0, sourceCalls = 0;
		const reader = manager.buildSessionEntryReader.bind(manager), source = manager.buildSessionEntrySource.bind(manager);
		if (restore === "reader") t.mock.method(manager, "buildSessionEntryReader", () => { readerCalls++; return reader(); });
		else Object.defineProperty(manager, "buildSessionEntryReader", { value: undefined });
		if (restore === "legacy") Object.defineProperty(manager, "buildSessionEntrySource", { value: undefined });
		else t.mock.method(manager, "buildSessionEntrySource", () => { sourceCalls++; return source(); });

		let arrayContexts = 0, sourceContexts = 0, arrayEnds = 0, sourceEnds = 0;
		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: directory, agentDir: directory, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [(pi) => {
				liveContextExtension(pi, { editingMode: "clm", overflow: { mode: "off" } });
				pi.on("context", () => { arrayContexts++; });
				pi.on("context_source", () => { sourceContexts++; });
				pi.on("agent_end", () => { arrayEnds++; });
				pi.on("agent_end_source", () => { sourceEnds++; });
			}],
		});
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);
		const modelRuntime = await ModelRuntime.create({
			authPath: join(directory, "auth.json"), modelsPath: null,
			modelsStorePath: join(directory, "models-cache.json"), refreshOnCreate: false, allowModelNetwork: false,
		});
		const { session } = await createAgentSession({
			cwd: directory, agentDir: directory, modelRuntime, resourceLoader, contextMode: "source",
			sessionManager: manager, settingsManager,
		});
		try {
			await session.bindExtensions({ mode: "print" });
			const runner = session.extensionRunner;
			runner.onError((error) => { throw new Error(error.error); });
			if (restore === "reader") { assert.ok(readerCalls > 0); assert.equal(sourceCalls, 0); }
			if (restore === "source") assert.ok(sourceCalls > 0);
			const prompt = await runner.emitBeforeAgentStart({ messageType: "user", prompt: "continue" }, { cwd: directory });
			const mirror = prompt.systemPromptOptions.sections.editable_context.match(/mirrored at `([^`]+)`/)![1];
			const canonical = manager.buildSessionSource();
			const effective = await runner.emitContextSource(canonical);
			assert.deepEqual(effective.readAll(), [...projected, ...raw.slice(2)]);
			assert.equal(arrayContexts, 0, "source dispatch must not invoke this extension's array hooks");

			const draft = `${(await readFile(mirror, "utf8")).split("\n")[0]}\n\nPending next note.`;
			const submission = mirror.replace(/\.md$/, ".commit.md");
			await writeFile(submission, draft);
			const accepted = await runner.emitContextSource(canonical, { purpose: "compaction" });
			assert.deepEqual(accepted.readAll(), [...projected, ...raw.slice(2)]);
			assert.equal(await readFile(submission, "utf8"), draft, "compaction must leave pending edits untouched");
			const branch = manager.getBranch();
			const preparation = prepareCompactionFromSource(accepted, {
				source: canonical,
				entries: buildContextEntries(branch).map((entry) => ({
					id: entry.id, type: entry.type, role: entry.type === "message" ? entry.message.role : undefined,
					position: branch.findIndex((item) => item.id === entry.id),
				})),
				readEntry: (id) => manager.getEntry(id)!,
			}, { enabled: true, reserveTokens: 0, keepRecentTokens: 100000 });
			assert.equal(preparation.preparation?.firstKeptEntryId, "message-2");
			assert.deepEqual(preparation.preparation?.messagesToSummarize, projected);

			const next = await runner.emitContextSource(canonical);
			assert.match(JSON.stringify(next.readAll()), /Pending next note/);
			assert.throws(() => accepted.validate(), /changed|expired/);
			await runner.emitAgentEndSource(manager.buildSessionSource());
			assert.equal(sourceEnds, 1); assert.equal(arrayEnds, 0);
			assert.ok(sourceContexts >= 3);
			manager.setSessionFile(path);
			assert.throws(() => borrowedReader.validate(), /expired/);
			assert.match(JSON.stringify(next.readAll()), /Pending next note/, "captured output survives SDK reload");
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	});
}
