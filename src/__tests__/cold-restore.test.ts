import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import liveContextExtension from "../index.ts";
import { createProjectionCheckpoint, PROJECTION_PREFIX_MISMATCH_REASON } from "../projection.ts";
import { LIVE_CONTEXT_STATE, reconstructLiveContextState } from "../state.ts";
import type { LiveContextMessage } from "../types.ts";

type Row = { id: string; parentId: string | null; timestamp: string; type: string; customType?: string; data?: unknown; message?: LiveContextMessage };
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
function fixture(records: Row[], raw: LiveContextMessage[], branch = records.map((_, index) => index)) {
	const handlers = new Map<string, Handler[]>(), notifications: string[] = [], statuses: string[] = [], reads: number[] = [], observations: number[] = [];
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	let generation = 0, fullReads = 0, allowFull = false;
	const pi = { events: createEventBus(), on(name: string, handler: Handler) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
		registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) { commands.set(name, command); }, registerTool() {},
		appendEntry(customType: string, data: unknown) { records.push({ type: "custom", id: `appended-${records.length}`, parentId: records.at(-1)?.id ?? null, timestamp: "2026-01-01", customType, data }); },
	} as unknown as ExtensionAPI;
	const ctx = { mode: "rpc", hasUI: true, cwd: process.cwd(), model: { contextWindow: 1000000 }, getSystemPrompt: () => "", getContextUsage: () => undefined,
		waitForIdle: async () => {}, isIdle: () => true,
		ui: { setStatus(_key: string, value: string | undefined) { if (value) statuses.push(value); }, notify(value: string) { notifications.push(value); } },
		sessionManager: { getSessionId: () => "cold-restore-public-fixture", getSessionFile: () => undefined, getLeafId: () => records[branch.at(-1) ?? -1]?.id ?? null, getTree: () => [], getEntry: (id: string) => records.find(row => row.id === id),
			getBranch() { fullReads++; assert.ok(allowFull, "cold restore requested full branch"); return branch.map(index => records[index]); },
			getEntries() { fullReads++; assert.ok(allowFull, "footer requested full archive"); return records; },
			buildSessionEntrySource() { const captured = generation, selected = [...branch], entries = records.map(({ type, customType }) => ({ type, customType }));
				const validate = () => assert.equal(generation, captured, "entry source expired");
				return { entries, branch: selected, validate, read(index: number) { validate(); reads.push(index); return structuredClone(records[index]); } }; },
			buildSessionSource() { return { length: raw.length, contributions: raw.map((message, index) => ({ key: String(index), role: message.role })), validate() {}, read(index: number) { observations.push(index); return structuredClone(raw[index]); } }; },
		},
	} as unknown as ExtensionContext;
	liveContextExtension(pi, { editingMode: "clm", overflow: { mode: "off" } });
	return { ctx, reads, observations, statuses, notifications, commands, get fullReads() { return fullReads; }, allowFull() { allowFull = true; }, expire() { generation++; },
		async emit(name: string, event: object = {}) { const values = []; for (const handler of handlers.get(name) ?? []) values.push(await handler({ type: name, ...event }, ctx)); return values; } };
}
const row = (id: string, data: unknown, parentId: string | null = null): Row => ({ type: "custom", customType: LIVE_CONTEXT_STATE, id, parentId, timestamp: "2026-01-01", data });
const raw: LiveContextMessage[] = [{ role: "user", content: "public task", timestamp: 1 }, { role: "assistant", content: "public answer", stopReason: "stop", usage: { input: 12000, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 12020 }, timestamp: 2 }];
const checkpoint = (revision: number, source = raw, content = `summary-${revision}`) => createProjectionCheckpoint({ revision, sourceMessages: source, projectedMessages: [{ role: "custom", customType: "notes", content, timestamp: 2 }], beforeEstimate: 100, afterEstimate: 10 });

test("cold restore reads only the active checkpoint; footer never hydrates full history", async () => {
	const records = [row("old", { version: 1, enabled: true, revision: 1, checkpoint: checkpoint(1) }), row("active", { version: 1, enabled: true, revision: 2, checkpoint: checkpoint(2) }, "old"), row("sibling", { version: 1, enabled: false, revision: 99 }, "old")];
	const harness = fixture(records, raw, [0, 1]);
	try {
		await harness.emit("session_start"); assert.deepEqual(harness.reads, [1]); assert.equal(harness.fullReads, 0);
		assert.ok(harness.statuses.every(value => /r2$/.test(value))); assert.deepEqual(harness.observations, [1, 1]);
		harness.allowFull(); await harness.commands.get("clm")!.handler("status", harness.ctx);
		assert.ok(harness.fullReads > 0); assert.match(harness.notifications.at(-1)!, /summary|messages/);
		const result = await harness.emit("context", { messages: raw }); assert.match(JSON.stringify(result), /summary-2/);
		assert.deepEqual(harness.reads, [1]); // normal requests do not read historical checkpoints either
	} finally { await harness.emit("session_shutdown"); }
});

test("source restore retains slim outcomes, reset semantics and malformed-state fallback", async () => {
	for (const latest of [
		{ version: 1, enabled: false, revision: 3 },
		{ version: 1, enabled: true, revision: 4, lastOutcome: { kind: "reset", message: "user reset", at: "2026-01-01" } },
		{ version: 1, enabled: true, revision: 9, checkpoint: { ...checkpoint(9), projectedMessages: [null] } },
	]) {
		const records = [row("old", { version: 1, enabled: true, revision: 2, checkpoint: checkpoint(2) }), row("active", { version: 1, enabled: true, revision: 3, checkpoint: checkpoint(3) }, "old"), row("slim", latest, "active")];
		const expected = reconstructLiveContextState(records), harness = fixture(records, raw);
		try { await harness.emit("session_start"); assert.deepEqual(harness.reads, [2, 1]); assert.equal(harness.fullReads, 0); assert.match(harness.statuses.at(-1)!, new RegExp(`r${expected.revision}$`));
			const result = await harness.emit("context", { messages: raw }); assert.equal(JSON.stringify(result).includes("summary-3"), Boolean(expected.enabled && expected.checkpoint));
		} finally { await harness.emit("session_shutdown"); }
	}
});

function recoveryFixture() {
	const anchorSource = raw, answer: LiveContextMessage = { role: "assistant", content: "successful retry", stopReason: "stop", timestamp: 4 };
	const records = [row("anchor", { version: 1, enabled: true, revision: 5, checkpoint: checkpoint(5, anchorSource) }), row("target", { version: 1, enabled: true, revision: 6, checkpoint: checkpoint(6, [...anchorSource, answer], "recovered summary") }, "anchor"), row("reset", { version: 1, enabled: true, revision: 7, lastOutcome: { kind: "reset", message: PROJECTION_PREFIX_MISMATCH_REASON, at: "2026-01-01" } }, "target")];
	const withError = [...anchorSource, { role: "assistant", content: [], stopReason: "error", errorMessage: "offline fixture retry", timestamp: 3 } as LiveContextMessage, answer, { role: "user", content: "continue", timestamp: 5 } as LiveContextMessage];
	return { harness: fixture(records, anchorSource), withError };
}
test("historical candidates hydrate and capture only when retry recovery actually needs them", async () => {
	const { harness, withError } = recoveryFixture();
	try { await harness.emit("session_start"); assert.deepEqual(harness.reads, [2, 1]);
		const result = await harness.emit("context", { messages: withError }); assert.match(JSON.stringify(result), /recovered summary/); assert.match(JSON.stringify(result), /Recovered projection revision 6/);
		assert.deepEqual(harness.reads, [2, 1, 0, 1, 2]);
	} finally { await harness.emit("session_shutdown"); }
});
test("an unread historical locator rejects generation replacement instead of rebinding", async () => {
	const { harness, withError } = recoveryFixture();
	try { await harness.emit("session_start"); harness.expire();
		await assert.rejects(harness.emit("context", { messages: withError }), /entry source expired/); assert.deepEqual(harness.reads, [2, 1]);
	} finally { await harness.emit("session_shutdown"); }
});
