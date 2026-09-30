import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	applyContextDocument,
	escapeStructuralLines,
	renderContextDocument,
	unescapeStructuralLines,
} from "../context-document.ts";
import type { LiveContextMessage } from "../types.ts";

const base: LiveContextMessage[] = [
	{ role: "user", content: "task", timestamp: 1 },
	{ role: "assistant", content: [{ type: "text", text: "working" }], timestamp: 2 },
];
const clm = { editingMode: "clm" as const };

describe("stable document nonce (CLM mode)", () => {
	test("nonce is constant across renders with new messages until the seed (accepted revision) changes", () => {
		const a = renderContextDocument(base, { revision: 0, protectedIndexes: new Set(), documentSeed: "s:raw" });
		const grown = [...base, { role: "user", content: "more", timestamp: 3 } as LiveContextMessage];
		const b = renderContextDocument(grown, { revision: 0, protectedIndexes: new Set(), documentSeed: "s:raw" });
		assert.equal(a.documentId, b.documentId);
		assert.notEqual(a.baselineDigest, b.baselineDigest);
		assert.equal(a.blocks[0]!.header, b.blocks[0]!.header, "block header read on call N is valid on call N+1");
		const c = renderContextDocument(grown, { revision: 1, protectedIndexes: new Set(), documentSeed: "s:digest-after-edit" });
		assert.notEqual(c.documentId, b.documentId);
		const perRender = renderContextDocument(grown, { revision: 0, protectedIndexes: new Set() });
		assert.notEqual(perRender.documentId, b.documentId, "without a seed the nonce is per render, as before");
	});
	test("a document whose metadata line carries an older baseline is rejected", () => {
		const first = renderContextDocument(base, { revision: 0, protectedIndexes: new Set(), documentSeed: "s" });
		const grown = [...base, { role: "user", content: "more", timestamp: 3 } as LiveContextMessage];
		const current = renderContextDocument(grown, { revision: 0, protectedIndexes: new Set(), documentSeed: "s" });
		// Model copied the first line from an earlier read, then edited a body.
		const staleMeta = current.text.replace(current.text.split("\n")[0]!, first.text.split("\n")[0]!).replace("working", "done");
		const result = applyContextDocument(staleMeta, current, clm);
		assert.equal(result.accepted, false);
		assert.match(result.reason ?? "", /metadata/);
	});
	test("rejections name the expected revision and nonce", () => {
		const current = renderContextDocument(base, { revision: 2, protectedIndexes: new Set(), documentSeed: "s" });
		const wrong = current.text.replace("revision=2", "revision=1");
		const result = applyContextDocument(wrong, current, clm);
		assert.equal(result.accepted, false);
		assert.match(result.reason ?? "", new RegExp(`expected revision 2, document ${current.documentId.slice(0, 12)}`));
		const unknown = current.text.replace(/id=1-[a-f0-9]+/, "id=1-deadbeef0000");
		assert.match(applyContextDocument(unknown, current, clm).reason ?? "", /prefix a new block's id with new-/);
	});
	test("live headers quoted inside a tool result are escaped in the mirror and never parsed as blocks", () => {
		const first = renderContextDocument(base, { revision: 0, protectedIndexes: new Set(), documentSeed: "s" });
		const quoted = `$ head -3 LIVE_CONTEXT.md\n${first.text.split("\n").slice(0, 3).join("\n")}\n${first.blocks[0]!.header}`;
		const withTool: LiveContextMessage[] = [
			...base,
			{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }], timestamp: 3 },
			{ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: quoted }], isError: false, timestamp: 4 },
		];
		const snapshot = renderContextDocument(withTool, { revision: 0, protectedIndexes: new Set(), documentSeed: "s" });
		assert.equal(snapshot.blocks.length, 4);
		const toolBody = snapshot.blocks[3]!.body;
		assert.match(toolBody, /\\\[\[LIVE_CONTEXT /);
		assert.match(toolBody, /\\\[\[CTX_TURN /);
		// Untouched: identity, the original tool result object survives.
		const identity = applyContextDocument(snapshot.text, snapshot, clm);
		assert.equal(identity.accepted, true);
		assert.equal(identity.messages[3], withTool[3]);
		// Edited: the escaped lines are restored in the resulting text.
		const edited = snapshot.text.replace("$ head -3 LIVE_CONTEXT.md", "$ head -3 (trimmed)");
		const result = applyContextDocument(edited, snapshot, clm);
		assert.equal(result.accepted, true);
		const text = JSON.stringify(result.messages[3]!.content);
		assert.match(text, /\[\[CTX_TURN document=/);
		assert.doesNotMatch(text, /\\\\\[\[CTX_TURN/);
	});
	test("escape/unescape round-trip, including already-escaped lines", () => {
		const body = "[[CTX_TURN document=x]]\n\\[[LIVE_CONTEXT v]]\nplain [[CTX_TURN not at line start";
		const escaped = escapeStructuralLines(body);
		assert.equal(escaped, "\\[[CTX_TURN document=x]]\n\\\\[[LIVE_CONTEXT v]]\nplain [[CTX_TURN not at line start");
		assert.equal(unescapeStructuralLines(escaped), body);
	});
	test("a headerless whole-file rewrite is accepted as one notes block after the first user turn", () => {
		const withTool: LiveContextMessage[] = [
			{ role: "user", content: "find the secrets", timestamp: 1 },
			{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }], timestamp: 2 },
			{ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "SECRET=42" }], isError: false, timestamp: 3 },
			{ role: "user", content: "continue", timestamp: 4 },
		];
		const snapshot = renderContextDocument(withTool, { revision: 0, protectedIndexes: new Set(), documentSeed: "s" });
		const summary = "# Context Summary\n## Found so far\n- f01: SECRET=42\n<!-- Budget: 20000/20000 -->";
		const result = applyContextDocument(`${snapshot.text.split("\n")[0]}\n${summary}`, snapshot, clm);
		assert.equal(result.accepted, true);
		assert.equal(result.messages.length, 2);
		assert.equal(result.messages[0], withTool[0], "task statement kept verbatim");
		assert.equal(result.messages[1]!.role, "custom");
		assert.match(String(result.messages[1]!.content), /\[context role=notes\]\n# Context Summary/);
		assert.match(result.diagnostics.join(" "), /Accepted a headerless rewrite/);
		assert.deepEqual(result.editTrace?.sources.filter((s) => s.kind === "removed").map((s) => s.sourceIndex), [1, 2, 3]);
		// A pasted metadata line on top of free text is fine too (it is stripped).
		const withMeta = `${snapshot.text.split("\n")[0]}\n\n${summary}`;
		assert.equal(applyContextDocument(withMeta, snapshot, clm).accepted, true);
		// Conservative mode still rejects.
		const conservative = renderContextDocument(withTool, { revision: 0 });
		assert.equal(applyContextDocument(summary, conservative, {}).accepted, false);
		// Whitespace-only is not a rewrite.
		assert.equal(applyContextDocument("   \n", snapshot, clm).accepted, false);
	});
	test("metadata rejections quote the exact first line to paste back", () => {
		const current = renderContextDocument(base, { revision: 1, protectedIndexes: new Set(), documentSeed: "s" });
		const wrong = current.text.replace("revision=1", "revision=0");
		const result = applyContextDocument(wrong, current, clm);
		assert.equal(result.accepted, false);
		assert.ok(result.reason?.endsWith(`The first line must be exactly: ${current.text.split("\n")[0]}`), result.reason);
	});
});
