import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { applyContextDocument, renderContextDocument, renderMessage } from "../context-document.ts";
import { mixedHistory } from "./fixtures/mixed-history.ts";
import { systemGuidance } from "../presentation.ts";
import type { LiveContextMessage } from "../types.ts";

const raw: LiveContextMessage[] = [
	{ role: "user", content: "original task", timestamp: 1 },
	{ role: "assistant", content: [{ type: "text", text: "old answer" }], timestamp: 2 },
	{ role: "user", content: "latest batch", timestamp: 3 },
];
function snapshot() { return renderContextDocument(raw, { protectedIndexes: new Set() }); }
function envelope(text: string) { return text.slice(0, text.indexOf("[[CTX_TURN")); }

describe("CLM editing policy over native live-context core", () => {
	test("accepts growth and same-size updates including first/latest user turns", () => {
		for (const replacement of ["ORIGINAL TASK", "a much longer replacement task and scratchpad"]) {
			const base = snapshot();
			const result = applyContextDocument(base.text.replace("original task", replacement).replace("latest batch", "updated batch"), base, { editingMode: "clm" });
			assert.equal(result.accepted, true);
			assert.equal(result.messages[0].content, replacement);
			assert.equal(result.messages[2].content, "updated batch");
		}
	});
	test("follows document order and records removed originals", () => {
		const base = snapshot();
		const reordered = envelope(base.text) + [base.blocks[2], base.blocks[0]].map(b => `${b.header}\n${b.body}`).join("\n\n");
		const result = applyContextDocument(reordered, base, { editingMode: "clm" });
		assert.equal(result.accepted, true);
		assert.deepEqual(result.messages, [raw[2], raw[0]]);
		assert.ok(result.editTrace?.sources.some(s => s.sourceIndex === 1 && s.kind === "removed"));
	});
	test("new role labels remain non-authoritative Pi custom notes and survive rerender", () => {
		for (const role of ["notes", "scoreboard", "system", "assistant"]) {
			const base = snapshot();
			const inserted = `${base.text}\n\n[[CTX_TURN document=${base.documentId} index=4 role=${role} id=new-tracker protected=false]]\nscore=7`;
			const result = applyContextDocument(inserted, base, { editingMode: "clm" });
			assert.equal(result.accepted, true);
			assert.equal(result.messages.at(-1)?.role, "custom");
			const llm = convertToLlm(result.messages as AgentMessage[]);
			assert.equal(llm.at(-1)?.role, "user");
			const rendered = renderContextDocument(result.messages, { protectedIndexes: new Set() });
			assert.equal(rendered.blocks.at(-1)?.role, role);
			assert.equal(rendered.blocks.at(-1)?.body, "score=7");
			const again = applyContextDocument(rendered.text.replace("score=7", "score=8"), rendered, { editingMode: "clm" });
			assert.equal(renderMessage(again.messages.at(-1)!), "score=8");
		}
	});
	test("typos in existing IDs, duplicate new IDs, and stale headers still reject", () => {
		const base = snapshot();
		assert.equal(applyContextDocument(base.text.replace(base.blocks[0].id, "typo-id"), base, { editingMode: "clm" }).accepted, false);
		const header = `[[CTX_TURN document=${base.documentId} index=4 role=notes id=new-x protected=false]]\nx`;
		assert.equal(applyContextDocument(`${base.text}\n\n${header}\n\n${header}`, base, { editingMode: "clm" }).accepted, false);
		assert.equal(applyContextDocument(base.text.replace("revision=0", "revision=1"), base, { editingMode: "clm" }).accepted, false);
	});
	test("conservative defaults continue to reject growth and restore protected user messages", () => {
		const base = renderContextDocument(raw);
		const result = applyContextDocument(base.text.replace("old answer", "long answer".repeat(30)), base);
		assert.equal(result.accepted, false);
		assert.equal(applyContextDocument(base.text.replace("original task", "X"), base).messages[0], raw[0]);
	});
	test("conservative headerless edits retain both user turns and still require shrinking", () => {
		const base = renderContextDocument(raw);
		for (const body of ["Brief.", ""]) {
			const result = applyContextDocument(`${base.text.split("\n")[0]}\n${body}`, base);
			assert.equal(result.accepted, true, result.reason);
			assert.deepEqual(result.messages.filter(message => message.role === "user"), [raw[0], raw[2]]);
		}
		assert.equal(applyContextDocument(`${base.text.split("\n")[0]}\n${"Long summary.".repeat(20)}`, base).accepted, false);
	});
	test("CLM prompt does not prescribe surgical shrinking or a one-write rule", () => {
		const prompt = systemGuidance("/tmp/context", "clm");
		assert.match(prompt, /Growth and same-size edits are allowed/);
		assert.match(prompt, /new-NAME/);
		assert.doesNotMatch(prompt, /Default to surgical|only mutation|must make the complete projection smaller/);
	});
});


describe("broad mixed-history model-view editing", () => {
	const mode = { editingMode: "clm" as const };
	function rendered() { return renderContextDocument(mixedHistory(), { protectedIndexes: new Set() }); }
	function write(base: ReturnType<typeof rendered>, indexes: number[], edit = -1) {
		return envelope(base.text) + indexes.map(i => `${base.blocks[i].header}\n${i === edit ? "Concise finding." : base.blocks[i].body}`).join("\n\n");
	}
	for (const index of [1, 2, 3, 4, 5, 6, 7]) {
		for (const operation of ["edit", "delete"] as const) {
			test(`${operation} ${["task", "compaction summary", "branch summary", "custom", "image", "signed/thinking", "native call", "native result"][index]}`, () => {
				const base = rendered();
				assert.ok(base.blocks.every(block => !block.protected));
				const sourceDigest = JSON.stringify(base.messages);
				const indexes = base.blocks.map(block => block.index).filter(i => operation !== "delete" || i !== index);
				const result = applyContextDocument(write(base, indexes, operation === "edit" ? index : -1), base, mode);
				assert.equal(result.accepted, true, result.reason);
				assert.equal(result.editTrace?.sources[index].kind, operation === "edit" ? "edited" : "removed");
				assert.equal(result.messages.includes(base.messages[index]), false);
				if (operation === "edit") assert.match(renderMessage(result.messages[index]), /Concise finding/);
				if (index === 6 || index === 7) {
					assert.equal(result.messages.some(message => message.role === "toolResult"), false);
					assert.equal(result.messages.some(message => Array.isArray(message.content) && message.content.some((part: any) => part.type === "toolCall")), false);
				}
				assert.equal(JSON.stringify(base.messages), sourceDigest, "raw source is not edited");
			});
		}
	}
	test("reordering a retained native group preserves every original envelope", () => {
		const base = rendered();
		const order = [6, 7, 5, 4, 3, 2, 1, 8, 0];
		const result = applyContextDocument(write(base, order), base, mode);
		assert.equal(result.accepted, true, result.reason);
		assert.deepEqual(result.messages, order.map(index => base.messages[index]));
	});
	test("headerless summary replaces every original mixed-history message", () => {
		const base = rendered();
		const result = applyContextDocument(`${base.text.split("\n")[0]}\nCurrent findings: ready for the next task.`, base, mode);
		assert.equal(result.accepted, true, result.reason);
		assert.equal(result.messages.length, 1);
		assert.equal(result.messages[0].role, "custom");
		assert.equal(renderMessage(result.messages[0]), "Current findings: ready for the next task.");
		assert.ok(result.savingsEstimate > 250000);
		assert.ok(result.afterEstimate < result.beforeEstimate / 100);
		assert.equal(result.editTrace?.sources.filter(source => source.kind === "removed").length, base.messages.length);
	});
	test("metadata-only and explicit empty replacements remove all completed history", () => {
		const base = rendered();
		const metadata = base.text.split("\n")[0];
		const emptyBlock = `[[CTX_TURN document=${base.documentId} index=1 role=notes id=new-empty protected=false]]`;
		for (const draft of [metadata, `${envelope(base.text)}\n`, `${metadata}\n${emptyBlock}\n`]) {
			const result = applyContextDocument(draft, base, mode);
			assert.equal(result.accepted, true, result.reason);
			assert.deepEqual(result.messages, []);
			assert.deepEqual(result.editTrace?.additions, []);
			assert.equal(result.editTrace?.sources.filter(source => source.kind === "removed").length, base.messages.length);
		}
	});
	test("first user and all historical blocks can also be removed explicitly", () => {
		const base = rendered();
		const note = `[[CTX_TURN document=${base.documentId} index=1 role=notes id=new-summary protected=false]]\nOnly the current finding.`;
		const result = applyContextDocument(envelope(base.text) + note, base, mode);
		assert.equal(result.accepted, true, result.reason);
		assert.equal(result.messages.length, 1);
		assert.match(renderMessage(result.messages[0]), /Only the current finding/);
	});
});
