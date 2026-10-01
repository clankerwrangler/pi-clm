import { createHash } from "node:crypto";

import { selectProtectedMessageIndexes, shouldAcceptShrink } from "./policy.ts";
import type {
	ApplyDocumentOptions,
	ApplyDocumentResult,
	ContextDocumentSnapshot,
	ContextEditSourceKind,
	ContextEditTrace,
	DocumentBlock,
	LiveContextMessage,
} from "./types.ts";

const DOCUMENT_VERSION = 1;
// Metadata is valid only as the first line. An example copied into a message body must
// never be mistaken for the active document envelope.
const META_RE =
	/^\[\[LIVE_CONTEXT version=(\d+) revision=(\d+) document=([a-f0-9]{64}) baseline=([a-f0-9]{64})\]\](?:\r?\n|$)/;

interface ParsedBlock {
	index: number;
	id: string;
	role: string;
	protected: boolean;
	body: string;
}

interface ParsedDocument {
	version?: number;
	revision?: number;
	documentId?: string;
	baselineDigest?: string;
	blocks: ParsedBlock[];
	preamble: string;
	duplicateIds: string[];
	malformedCurrentHeaders: string[];
}

function normalizeJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeJson);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, item]) => item !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, item]) => [key, normalizeJson(item)]),
		);
	}
	return value;
}

export function canonicalMessage(message: LiveContextMessage): string {
	return JSON.stringify(normalizeJson(message));
}

export function digestMessages(messages: LiveContextMessage[]): string {
	const hash = createHash("sha256");
	for (const message of messages) {
		hash.update(canonicalMessage(message));
		hash.update("\n");
	}
	return hash.digest("hex");
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((part) => {
			if (typeof part === "string") return part;
			if (!part || typeof part !== "object") return String(part ?? "");
			const block = part as Record<string, unknown>;
			if (block.type === "text" && typeof block.text === "string") return block.text;
			if (block.type === "thinking" && typeof block.thinking === "string") {
				return `[thinking]\n${block.thinking}`;
			}
			if (block.type === "toolCall") {
				const name = typeof block.name === "string" ? block.name : "tool";
				return `[tool call: ${name}]\n${JSON.stringify(normalizeJson(block.arguments ?? {}))}`;
			}
			if (block.type === "image") {
				const mimeType =
					typeof block.mimeType === "string"
						? block.mimeType
						: typeof (block.source as Record<string, unknown> | undefined)?.mediaType === "string"
							? String((block.source as Record<string, unknown>).mediaType)
							: "unknown";
				return `[image: ${mimeType}; data omitted]`;
			}
			return JSON.stringify(normalizeJson(block));
		})
		.filter(Boolean)
		.join("\n");
}

export function renderMessage(message: LiveContextMessage): string {
	const parts: string[] = [];
	let content = textFromContent(message.content);
	const contextRole = (message.details as { contextRole?: unknown } | undefined)?.contextRole;
	if (message.role === "custom" && message.customType === "live-context-projection" && typeof contextRole === "string") {
		const prefix = `[context role=${contextRole}]\n`;
		if (content.startsWith(prefix)) content = content.slice(prefix.length);
	}
	if (content) parts.push(content);

	if (message.role === "bashExecution") {
		if (typeof message.command === "string") parts.push(`[command]\n${message.command}`);
		if (typeof message.output === "string" && message.output) parts.push(`[output]\n${message.output}`);
	}
	if (message.role === "branchSummary" || message.role === "compactionSummary") {
		if (typeof message.summary === "string") parts.push(message.summary);
	}

	// Legacy/OpenAI-shaped messages are accepted by the pure core as well.
	const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
	for (const toolCall of toolCalls) {
		if (!toolCall || typeof toolCall !== "object") continue;
		const fn = (toolCall as Record<string, unknown>).function as Record<string, unknown> | undefined;
		if (!fn) continue;
		parts.push(`[tool call: ${String(fn.name ?? "tool")}]\n${String(fn.arguments ?? "")}`);
	}

	return parts.join("\n\n").trim();
}

export function estimateContextCharacters(messages: LiveContextMessage[]): number {
	return messages.reduce((total, message) => total + renderMessage(message).length, 0);
}

function blockId(message: LiveContextMessage, index: number): string {
	const digest = createHash("sha256").update(canonicalMessage(message)).digest("hex").slice(0, 12);
	return `${index + 1}-${digest}`;
}

function documentId(baselineDigest: string, revision: number): string {
	return createHash("sha256")
		.update(`pi-live-context:${DOCUMENT_VERSION}:${revision}:${baselineDigest}`)
		.digest("hex");
}

/**
 * Structural lines inside a body are escaped when the document nonce is stable across
 * renders (CLM mode). With a per-render nonce this was unnecessary: a header the model
 * printed on one call could never match the nonce of the next render. With a per-revision
 * nonce, a `head -5 LIVE_CONTEXT.md` tool result would contain live headers, so they are
 * neutralised with a leading backslash at render time and restored when a body is edited.
 */
const STRUCTURAL_LINE_RE = /^(\\*)(\[\[(?:CTX_TURN|LIVE_CONTEXT) )/gm;

export function escapeStructuralLines(body: string): string {
	return body.replace(STRUCTURAL_LINE_RE, (_match, slashes: string, start: string) => `\\${slashes}${start}`);
}

export function unescapeStructuralLines(body: string): string {
	return body.replace(STRUCTURAL_LINE_RE, (_match, slashes: string, start: string) =>
		slashes.length > 0 ? `${slashes.slice(1)}${start}` : `${slashes}${start}`,
	);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface RenderContextDocumentOptions {
	revision?: number;
	protectedIndexes?: Set<number>;
	additionalProtectedIndexes?: Set<number>;
	/**
	 * When set, the document nonce is derived from this seed and the revision instead of
	 * the rendered baseline, so it stays constant between accepted edits even as new
	 * messages arrive. Header ids a model reads on one call remain valid on the next.
	 * Bodies are then escaped so live headers quoted inside tool output stay inert.
	 */
	documentSeed?: string;
}

export function renderContextDocument(
	messages: LiveContextMessage[],
	options: RenderContextDocumentOptions = {},
): ContextDocumentSnapshot {
	const revision = options.revision ?? 0;
	const protectedIndexes = intrinsicProtectedIndexes(messages, new Set([
		...(options.protectedIndexes ?? selectProtectedMessageIndexes(messages)),
		...(options.additionalProtectedIndexes ?? []),
	]));
	const baselineDigest = digestMessages(messages);
	const stable = options.documentSeed !== undefined;
	const currentDocumentId = documentId(stable ? `seed:${options.documentSeed}` : baselineDigest, revision);
	const blocks: DocumentBlock[] = messages.map((source, index) => {
		const id = blockId(source, index);
		const authoredRole = (source.details as { contextRole?: unknown } | undefined)?.contextRole;
		const role = source.role === "custom" && source.customType === "live-context-projection" &&
			typeof authoredRole === "string" && /^[A-Za-z][A-Za-z0-9_-]*$/.test(authoredRole)
			? authoredRole : source.role;
		const protectedBlock = protectedIndexes.has(index);
		return {
			index,
			id,
			role,
			protected: protectedBlock,
			header: `[[CTX_TURN document=${currentDocumentId} index=${index + 1} role=${role} id=${id} protected=${protectedBlock}]]`,
			body: stable ? escapeStructuralLines(renderMessage(source)) : renderMessage(source),
			source,
		};
	});
	const renderedBlocks = blocks.map((block) => `${block.header}\n${block.body}`);
	const text = [
		`[[LIVE_CONTEXT version=${DOCUMENT_VERSION} revision=${revision} document=${currentDocumentId} baseline=${baselineDigest}]]`,
		"# Edit bodies or delete editable CTX_TURN blocks. Keep metadata/header lines intact. Results paired with protected calls permit body-only edits.",
		...renderedBlocks,
	].join("\n\n");

	return {
		version: DOCUMENT_VERSION,
		revision,
		baselineDigest,
		documentId: currentDocumentId,
		stableDocument: stable,
		text,
		messages: [...messages],
		blocks,
	};
}

function parseDocument(text: string, snapshot: ContextDocumentSnapshot): ParsedDocument {
	const metadata = META_RE.exec(text);
	const blockRe = new RegExp(
		`^\\[\\[CTX_TURN document=${escapeRegExp(snapshot.documentId)} index=(\\d+) role=([A-Za-z][A-Za-z0-9_-]*) id=([a-zA-Z0-9-]+) protected=(true|false)\\]\\]\\s*$`,
		"gm",
	);
	const matches = [...text.matchAll(blockRe)];
	const blocks: ParsedBlock[] = [];
	const seen = new Set<string>();
	const duplicateIds: string[] = [];

	for (let index = 0; index < matches.length; index++) {
		const match = matches[index];
		const start = (match.index ?? 0) + match[0].length;
		const end = index + 1 < matches.length ? (matches[index + 1].index ?? text.length) : text.length;
		const id = match[3];
		if (seen.has(id)) duplicateIds.push(id);
		seen.add(id);
		blocks.push({
			index: Number(match[1]) - 1,
			role: match[2],
			id,
			protected: match[4] === "true",
			body: text.slice(start, end).trim(),
		});
	}

	const validHeaderLines = new Set(matches.map((match) => match[0].trim()));
	const currentPrefix = `[[CTX_TURN document=${snapshot.documentId} `;
	const malformedCurrentHeaders = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.startsWith(currentPrefix) && !validHeaderLines.has(line));

	const metadataEnd = metadata ? metadata[0].length : 0;
	const firstBlockStart = matches[0]?.index ?? text.length;
	const preamble = text
		.slice(metadataEnd, firstBlockStart)
		.split("\n")
		.filter((line) => !line.trim().startsWith("# Edit bodies or delete editable CTX_TURN blocks."))
		.join("\n")
		.trim();

	return {
		version: metadata ? Number(metadata[1]) : undefined,
		revision: metadata ? Number(metadata[2]) : undefined,
		documentId: metadata?.[3],
		baselineDigest: metadata?.[4],
		blocks,
		preamble,
		duplicateIds,
		malformedCurrentHeaders,
	};
}

function contentToolCalls(message: LiveContextMessage): Array<{ id?: string; name?: string; arguments?: unknown }> {
	if (!Array.isArray(message.content)) return [];
	return message.content
		.filter(
			(part): part is Record<string, unknown> =>
				Boolean(part && typeof part === "object" && (part as Record<string, unknown>).type === "toolCall"),
		)
		.map((part) => ({
			id: typeof part.id === "string" ? part.id : undefined,
			name: typeof part.name === "string" ? part.name : undefined,
			arguments: part.arguments,
		}));
}

function toolCallIds(message: LiveContextMessage): Set<string> {
	const ids = new Set<string>();
	for (const call of contentToolCalls(message)) if (call.id) ids.add(call.id);
	for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
		if (call && typeof call === "object" && typeof (call as Record<string, unknown>).id === "string") {
			ids.add(String((call as Record<string, unknown>).id));
		}
	}
	return ids;
}

/** Edited body text as it should enter a message: escaped structural lines restored. */
function bodyText(body: string, snapshot: ContextDocumentSnapshot): string {
	return snapshot.stableDocument ? unescapeStructuralLines(body) : body;
}

function contextNote(body: string, source?: LiveContextMessage, requestedRole?: string): LiveContextMessage {
	return {
		role: "custom",
		customType: "live-context-projection",
		content: requestedRole ? `[context role=${requestedRole}]\n${body}` : body,
		...(requestedRole ? { details: { contextRole: requestedRole } } : {}),
		display: false,
		timestamp: typeof source?.timestamp === "number" ? source.timestamp : Date.now(),
	};
}

function changedMessage(source: LiveContextMessage, body: string, requestedRole: string, labelRole = false): LiveContextMessage {
	if (source.role === "assistant" && requestedRole === "assistant") {
		const changed: LiveContextMessage = {
			...source,
			content: [{ type: "text", text: body }],
			stopReason: "stop",
		};
		delete changed.errorMessage;
		delete changed.tool_calls;
		return changed;
	}
	if (source.role === "user" && requestedRole === "user") {
		return {
			...source,
			content: Array.isArray(source.content) ? [{ type: "text", text: body }] : body,
		};
	}
	return contextNote(body, source, labelRole ? requestedRole : undefined);
}

/** Validate public content semantics; additional fields stay in the exact assistant envelope. */
function knownAssistantCore(message: LiveContextMessage): boolean {
	return Array.isArray(message.content) && message.content.every((part) => {
		if (!part || typeof part !== "object" || Array.isArray(part)) return false;
		const block = part as Record<string, unknown>;
		const optional = (key: string, type: string) => block[key] === undefined || typeof block[key] === type;
		if (block.type === "text") return typeof block.text === "string" && optional("textSignature", "string");
		if (block.type === "thinking") return typeof block.thinking === "string" &&
			optional("thinkingSignature", "string") && optional("redacted", "boolean");
		if (block.type === "toolCall") return typeof block.id === "string" && block.id.length > 0 &&
			typeof block.name === "string" && block.name.length > 0 &&
			Boolean(block.arguments) && typeof block.arguments === "object" && !Array.isArray(block.arguments) &&
			optional("thoughtSignature", "string") && optional("namespace", "string");
		return false;
	});
}

/** Unknown content and incomplete native spans stay exact; signed complete calls permit text-result bodies. */
export function intrinsicProtectedIndexes(messages: LiveContextMessage[], required = new Set<number>()): Set<number> {
	const protectedIndexes = new Set(required);
	// Extra metadata freezes the assistant, not a separately mapped completed result body.
	const fullGroup = new Set([...required].filter((index) => messages[index]?.role !== "assistant" || !knownAssistantCore(messages[index])));
	const results = new Map<string, number[]>();
	const calls = new Map<string, number[]>();
	for (const [index, message] of messages.entries()) {
		for (const id of toolCallIds(message)) calls.set(id, [...(calls.get(id) ?? []), index]);
		if (message.role === "toolResult" && typeof message.toolCallId === "string") {
			results.set(message.toolCallId, [...(results.get(message.toolCallId) ?? []), index]);
		}
		const knownRole = ["user", "assistant", "toolResult", "bashExecution"].includes(message.role) ||
			(message.role === "custom" && message.customType === "live-context-projection");
		const opaqueContent = Array.isArray(message.content) && message.content.some((part) => {
			if (!part || typeof part !== "object") return true;
			const block = part as Record<string, unknown>;
			const allowed = block.type === "text" ? ["type", "text"] :
				block.type === "toolCall" ? ["type", "id", "name", "arguments"] : [];
			return allowed.length === 0 || Object.keys(block).some((key) => !allowed.includes(key));
		});
		const nonTextResult = message.role === "toolResult" && (!Array.isArray(message.content) || message.content.some((part) => {
			if (!part || typeof part !== "object") return true;
			const block = part as Record<string, unknown>;
			return block.type !== "text" || typeof block.text !== "string" || Object.keys(block).some((key) => !["type", "text"].includes(key));
		}));
		const pending = message.deferred || message.stopReason === "pending" || message.stopReason === "deferred";
		const malformedAssistant = message.role === "assistant" && Array.isArray(message.content) && !knownAssistantCore(message);
		if (!knownRole || opaqueContent || nonTextResult || pending || malformedAssistant) {
			protectedIndexes.add(index);
			if (!knownRole || nonTextResult || pending || message.role !== "assistant" || !knownAssistantCore(message)) fullGroup.add(index);
		}
		// Duplicate IDs, including alternate legacy declarations, are ambiguous too.
		if (Array.isArray(message.content)) {
			const nativeCalls = message.content.filter((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "toolCall");
			const legacyCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
			if (nativeCalls.length + legacyCalls.length > toolCallIds(message).size) fullGroup.add(index);
		}
	}
	for (const [index, message] of messages.entries()) {
		const ids = toolCallIds(message);
		if (ids.size === 0) continue;
		const exactAssistant = message.role === "assistant" && protectedIndexes.has(index);
		const publicCallNames = new Map(contentToolCalls(message).map((call) => [call.id, call.name]));
		// Body-only admission needs an authoritative terminal state and matching names.
		// Keep legacy metadata-free pair editing separate from this exact-envelope path.
		const unsettled = exactAssistant && !(typeof message.stopReason === "string" && ["stop", "toolUse", "length"].includes(message.stopReason));
		const incomplete = [...ids].some((id) => calls.get(id)?.length !== 1 || results.get(id)?.length !== 1 || results.get(id)![0] < index ||
			(exactAssistant && (!publicCallNames.has(id) || messages[results.get(id)![0]].toolName !== publicCallNames.get(id))));
		const opaque = unsettled || fullGroup.has(index) || [...ids].some((id) => results.get(id)?.some((i) => protectedIndexes.has(i)));
		if (incomplete || opaque) {
			protectedIndexes.add(index);
			for (const id of ids) for (const i of results.get(id) ?? []) protectedIndexes.add(i);
		}
	}
	for (const [index, message] of messages.entries()) {
		if (message.role === "toolResult" && (typeof message.toolCallId !== "string" || !calls.has(message.toolCallId))) protectedIndexes.add(index);
	}
	return protectedIndexes;
}

/** Complete text results paired with an exact assistant may change bodies, never their native envelopes. */
function bodyOnlyResultIndexes(snapshot: ContextDocumentSnapshot): Set<number> {
	const exactCalls = new Set(snapshot.blocks.filter((block) => block.protected).flatMap((block) => [...toolCallIds(block.source)]));
	return new Set(snapshot.blocks.filter((block) => !block.protected && block.source.role === "toolResult" &&
		exactCalls.has(String(block.source.toolCallId))).map((block) => block.index));
}

/** Normalize only complete original spans whose endpoints the edit actually removed or changed. */
function repairToolGroups(messages: LiveContextMessage[], originals: LiveContextMessage[]): LiveContextMessage[] {
	const repaired = [...messages];
	const protectedOriginals = intrinsicProtectedIndexes(originals);
	const immutable = new Set([...protectedOriginals].map((i) => originals[i]));
	const resultIndexes = new Map<string, number[]>();
	for (const [index, message] of messages.entries()) {
		if (message.role === "toolResult" && typeof message.toolCallId === "string") {
			resultIndexes.set(message.toolCallId, [...(resultIndexes.get(message.toolCallId) ?? []), index]);
		}
	}
	const flattened = new Set<string>();
	for (const [index, message] of repaired.entries()) {
		if (message.role !== "assistant" || immutable.has(message)) continue;
		const ids = toolCallIds(message);
		if ([...ids].some((id) => !resultIndexes.has(id) || resultIndexes.get(id)!.some((i) => i <= index))) {
			repaired[index] = contextNote(renderMessage(message), message);
			for (const id of ids) flattened.add(id);
		}
	}
	const remainingIds = new Set(repaired.flatMap((m) => [...toolCallIds(m)]));
	for (const [index, message] of repaired.entries()) {
		if (message.role !== "toolResult" || immutable.has(message)) continue;
		if (!remainingIds.has(String(message.toolCallId)) || flattened.has(String(message.toolCallId))) {
			repaired[index] = contextNote(renderMessage(message), message);
		}
	}
	return repaired;
}

/** Outstanding calls are valid. Only results without an earlier call are orphaned. */
export function hasOrphanToolMessages(messages: LiveContextMessage[]): boolean {
	const calls = new Set<string>();
	for (const message of messages) {
		for (const id of toolCallIds(message)) calls.add(id);
		if (message.role === "toolResult" && !calls.has(String(message.toolCallId))) return true;
	}
	return false;
}

function rejected(
	snapshot: ContextDocumentSnapshot,
	beforeEstimate: number,
	reason: string,
	diagnostics: string[] = [],
): ApplyDocumentResult {
	return {
		accepted: false,
		changed: true,
		messages: [...snapshot.messages],
		beforeEstimate,
		afterEstimate: beforeEstimate,
		savingsEstimate: 0,
		diagnostics,
		reason,
	};
}

export function applyContextDocument(
	editedText: string,
	snapshot: ContextDocumentSnapshot,
	options: ApplyDocumentOptions = {},
): ApplyDocumentResult {
	const estimate = options.estimate ?? estimateContextCharacters;
	const estimateUnit = options.estimateUnit ?? "characters";
	const beforeEstimate = estimate(snapshot.messages);
	const bodyOnly = bodyOnlyResultIndexes(snapshot);
	if (editedText.trim() === snapshot.text.trim()) {
		return {
			accepted: true,
			changed: false,
			messages: [...snapshot.messages],
			beforeEstimate,
			afterEstimate: beforeEstimate,
			savingsEstimate: 0,
			diagnostics: [],
		};
	}

	const finalize = (
		candidate: LiveContextMessage[],
		candidateOrigins: Array<{ sourceIndex?: number; kind: ContextEditSourceKind | "added" }>,
		removedSourceIndexes: Set<number>,
		diagnostics: string[],
	): ApplyDocumentResult => {
		const messages = repairToolGroups(candidate, snapshot.messages);
		for (const sourceIndex of bodyOnly) {
			const outputIndex = candidateOrigins.findIndex((origin) => origin.sourceIndex === sourceIndex);
			const source = snapshot.messages[sourceIndex];
			const output = messages[outputIndex];
			if (!output || canonicalMessage({ ...source, content: undefined }) !== canonicalMessage({ ...output, content: undefined }) ||
				candidateOrigins.some((origin, i) => origin.sourceIndex !== undefined &&
					((origin.sourceIndex < sourceIndex && i > outputIndex) || (origin.sourceIndex > sourceIndex && i < outputIndex)))) {
				return rejected(snapshot, beforeEstimate, "A completed result paired with a protected call permits body-only edits; keep its native role, identity, metadata, and source order.");
			}
		}
		for (const sourceIndex of snapshot.blocks.filter((block) => block.protected).map((block) => block.index)) {
			const outputIndex = candidateOrigins.findIndex((origin) => origin.sourceIndex === sourceIndex);
			if (outputIndex < 0 || messages[outputIndex] !== snapshot.messages[sourceIndex] ||
				candidateOrigins.some((origin, i) => origin.sourceIndex !== undefined &&
					((origin.sourceIndex < sourceIndex && i > outputIndex) || (origin.sourceIndex > sourceIndex && i < outputIndex)))) {
				return rejected(snapshot, beforeEstimate, "Edit would change or move a protected native or opaque span.");
			}
		}
		const afterEstimate = estimate(messages);
		const requireShrink = options.requireShrink ?? options.editingMode !== "clm";
		if (requireShrink) {
			const shrink = shouldAcceptShrink(beforeEstimate, afterEstimate, options.minSavings ?? 1, estimateUnit);
			if (!shrink.accepted) return rejected(snapshot, beforeEstimate, shrink.reason ?? "Context did not shrink.", diagnostics);
		}

		const tracedSources: ContextEditTrace["sources"] = candidateOrigins.flatMap((origin, outputIndex) => {
			if (origin.sourceIndex === undefined) return [];
			const wasNormalized = canonicalMessage(candidate[outputIndex]) !== canonicalMessage(messages[outputIndex]);
			const kind: ContextEditSourceKind = wasNormalized
				? "normalized"
				: origin.kind === "added" ? "edited" : origin.kind;
			return [{ sourceIndex: origin.sourceIndex, outputIndex, kind }];
		});
		for (const sourceIndex of removedSourceIndexes) {
			tracedSources.push({ sourceIndex, kind: "removed" });
		}
		tracedSources.sort((left, right) => left.sourceIndex - right.sourceIndex);
		const editTrace: ContextEditTrace = {
			version: 1,
			sourceRevision: snapshot.revision,
			sourceMessageCount: snapshot.messages.length,
			outputMessageCount: messages.length,
			sources: tracedSources,
			additions: candidateOrigins.flatMap((origin, outputIndex) =>
				origin.sourceIndex === undefined ? [{ outputIndex, kind: "added" as const }] : [],
			),
		};

		return {
			accepted: true,
			changed: true,
			messages,
			beforeEstimate,
			afterEstimate,
			savingsEstimate: beforeEstimate - afterEstimate,
			diagnostics,
			editTrace,
		};
	};

	const parsed = parseDocument(editedText, snapshot);
	const metadataLine = snapshot.text.split("\n")[0] ?? "";
	// Submission identifies one exact immutable snapshot, even with a caller-supplied seed.
	const baselineMatches = parsed.baselineDigest === snapshot.baselineDigest;
	if (
		parsed.version !== snapshot.version ||
		parsed.revision !== snapshot.revision ||
		parsed.documentId !== snapshot.documentId ||
		!baselineMatches
	) {
		return rejected(
			snapshot,
			beforeEstimate,
			`Mirror metadata does not match the current context revision (expected revision ${snapshot.revision}, document ${snapshot.documentId.slice(0, 12)}…). ` +
				`The first line must be exactly: ${metadataLine}`,
		);
	}
	// CLM: a file with no current block headers at all is the model replacing its whole
	// context with free text (the paper's "collapse to a summary" move). Accept it as one
	// notes block, keeping the first user turn so the task statement survives.
	if (options.editingMode === "clm" && parsed.blocks.length === 0 && editedText.trim().length > 0) {
		const body = unescapeStructuralLines(
			editedText
				.split(/\r?\n/)
				.filter((line) => !META_RE.test(`${line}\n`) && !line.trim().startsWith("# Edit bodies or delete editable CTX_TURN blocks."))
				.join("\n")
				.trim(),
		);
		if (body.length === 0) return rejected(snapshot, beforeEstimate, "Mirror is empty after removing metadata; nothing to apply.");
		const candidate: LiveContextMessage[] = [];
		const candidateOrigins: Array<{ sourceIndex?: number; kind: ContextEditSourceKind | "added" }> = [];
		const removedSourceIndexes = new Set<number>();
		const firstUserIndex = snapshot.messages.findIndex((message) => message.role === "user");
		for (const [index, message] of snapshot.messages.entries()) {
			if (index === firstUserIndex || snapshot.blocks[index].protected) {
				candidate.push(message);
				candidateOrigins.push({ sourceIndex: index, kind: "kept" });
			} else {
				removedSourceIndexes.add(index);
			}
		}
		candidate.push(contextNote(body, undefined, "notes"));
		candidateOrigins.push({ kind: "added" });
		return finalize(candidate, candidateOrigins, removedSourceIndexes, [
			"Accepted a headerless rewrite: every block was replaced by one notes block" +
				(firstUserIndex >= 0 ? " after the first user turn" : "") +
				". To edit blocks individually, keep the [[CTX_TURN ...]] headers.",
		]);
	}

	if (parsed.duplicateIds.length > 0) {
		return rejected(snapshot, beforeEstimate, `Mirror contains duplicate block IDs: ${parsed.duplicateIds.join(", ")}.`);
	}
	if (parsed.malformedCurrentHeaders.length > 0) {
		return rejected(snapshot, beforeEstimate, "Mirror contains malformed headers for the current document.");
	}

	const sourceById = new Map(snapshot.blocks.map((block) => [block.id, block]));
	const parsedById = new Map<string, ParsedBlock>();
	const unknownIds: string[] = [];
	for (const block of parsed.blocks) {
		if (!sourceById.has(block.id) && !(options.editingMode === "clm" && /^new-[a-zA-Z0-9-]+$/.test(block.id))) unknownIds.push(block.id);
		else parsedById.set(block.id, block);
	}
	if (unknownIds.length > 0) {
		return rejected(
			snapshot,
			beforeEstimate,
			`Mirror contains unknown block IDs: ${unknownIds.join(", ")}. ` +
				(options.editingMode === "clm"
					? "Use ids from the current mirror headers, or prefix a new block's id with new-."
					: "Use ids from the current mirror headers."),
		);
	}

	const diagnostics: string[] = [];
	const candidate: LiveContextMessage[] = [];
	const candidateOrigins: Array<{ sourceIndex?: number; kind: ContextEditSourceKind | "added" }> = [];
	const removedSourceIndexes = new Set<number>();
	// Stray text above the first block keeps its written position as a leading note.
	if (parsed.preamble) {
		candidate.push(contextNote(bodyText(parsed.preamble, snapshot)));
		candidateOrigins.push({ kind: "added" });
	}
	// Conservative mode retains source order. CLM follows the edited order;
	// removed originals are still visited for complete provenance/protected restoration.
	const orderedIds = options.editingMode === "clm"
		? [...parsed.blocks.map((block) => block.id), ...snapshot.blocks.filter((block) => !parsedById.has(block.id)).map((block) => block.id)]
		: snapshot.blocks.map((block) => block.id);
	for (const id of orderedIds) {
		const sourceBlock = sourceById.get(id);
		const parsedBlock = parsedById.get(id);
		if (!sourceBlock) {
			if (parsedBlock?.body) {
				candidate.push(contextNote(bodyText(parsedBlock.body, snapshot), undefined, parsedBlock.role));
				candidateOrigins.push({ kind: "added" });
			}
			continue;
		}
		if (sourceBlock.protected) {
			const restored =
				!parsedBlock ||
				parsedBlock.body !== sourceBlock.body ||
				parsedBlock.role !== sourceBlock.role ||
				!parsedBlock.protected;
			candidate.push(sourceBlock.source);
			candidateOrigins.push({ sourceIndex: sourceBlock.index, kind: restored ? "restored" : "kept" });
			if (restored) diagnostics.push(`Restored protected turn ${sourceBlock.index + 1}.`);
			continue;
		}
		if (bodyOnly.has(sourceBlock.index) && (!parsedBlock?.body || parsedBlock.role !== sourceBlock.role)) {
			return rejected(snapshot, beforeEstimate, "A completed result paired with a protected call permits body-only edits; do not delete it or change its role.");
		}
		if (!parsedBlock || !parsedBlock.body) {
			removedSourceIndexes.add(sourceBlock.index);
			continue;
		}
		if (
			parsedBlock.body === sourceBlock.body &&
			parsedBlock.role === sourceBlock.role &&
			parsedBlock.protected === sourceBlock.protected
		) {
			candidate.push(sourceBlock.source);
			candidateOrigins.push({ sourceIndex: sourceBlock.index, kind: "kept" });
		} else {
			candidate.push(bodyOnly.has(sourceBlock.index)
				? { ...sourceBlock.source, content: [{ type: "text", text: bodyText(parsedBlock.body, snapshot) }] }
				: changedMessage(sourceBlock.source, bodyText(parsedBlock.body, snapshot), parsedBlock.role, options.editingMode === "clm"));
			candidateOrigins.push({ sourceIndex: sourceBlock.index, kind: "edited" });
		}
	}

	return finalize(candidate, candidateOrigins, removedSourceIndexes, diagnostics);
}
