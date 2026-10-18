import { createHash, randomUUID, type Hash } from "node:crypto";
import { serialize, deserialize } from "node:v8";
import { MirrorStore } from "./mirror-store.ts";
import { isDeepStrictEqual } from "node:util";

import { canonicalMessage, digestMessages, escapeStructuralLines, renderContextDocument, renderMessage, type RenderContextDocumentOptions } from "./context-document.ts";
import type { ProjectionCheckpoint } from "./projection.ts";
import type { ContextDocumentSnapshot, LiveContextMessage } from "./types.ts";


/** Structural counterpart of the opt-in SDK source; no legacy SDK type dependency. */
export interface SnapshotMessageSource {
	readonly length: number;
	readonly contributions: readonly { readonly key: string }[];
	read(index: number): unknown;
	validate(): void;
}

export interface MessageProfile {
	role?: string;
	tokens: number;
	visible: boolean;
	observedTokens?: number;
	resultId?: string;
	isError?: boolean;
}

export class CapturedValue<T> {
	readonly file?: string;
	private readonly resident?: T;
	constructor(readonly store: MirrorStore, value: T) {
		const detached = structuredClone(value);
		let bytes: Buffer;
		try { bytes = serialize(detached); }
		catch {
			// Structured-clone values such as SharedArrayBuffer cannot be serialized by
			// V8. Preserve their sole detached value instead of silently losing fields.
			this.resident = detached;
			return;
		}
		this.file = store.writeSnapshot(bytes); // I/O failures must abort publication.
	}
	read(): T { return this.file ? deserialize(this.store.readSnapshot(this.file)) as T : structuredClone(this.resident) as T; }
	remove(): void { if (this.file) this.store.removeSnapshot(this.file); }
}

interface CapturedMessage {
	key: string;
	digest: string;
	value: CapturedValue<LiveContextMessage>;
	profile: MessageProfile;
	bodies: { plain?: CapturedValue<string>; escaped?: CapturedValue<string> };
}

/** Owned values, not a borrowed SDK plan or a lazy array. */
export class CapturedMessages {
	readonly #prefixes: readonly Hash[];
	private constructor(readonly items: readonly CapturedMessage[], prefixes: readonly Hash[]) { this.#prefixes = prefixes; }

	/** Consume one value at a time. Stored hash states are private and never
	 * updated; only copies cross a mutable boundary or extend a changed prefix. */
	static capture(records: Iterable<{ item: CapturedMessage; message?: LiveContextMessage }>, previous?: CapturedMessages): CapturedMessages {
		const items: CapturedMessage[] = [];
		const prefixes: Hash[] = [previous ? previous.#prefixes[0] : createHash("sha256")];
		let unchanged = true;
		for (const { item, message } of records) {
			const index = items.length;
			items.push(item);
			unchanged &&= previous?.items[index] === item;
			prefixes.push(unchanged ? previous!.#prefixes[index + 1] :
				prefixes[index].copy().update(canonicalMessage(message ?? item.value.read())).update("\n"));
		}
		return new CapturedMessages(items, prefixes);
	}
	get length(): number { return this.items.length; }
	read(index: number): LiveContextMessage {
		const item = this.items[index];
		if (!item) throw new RangeError("Captured message index is out of range.");
		return item.value.read();
	}
	readAll(): LiveContextMessage[] { return this.items.map((_, index) => this.read(index)); }
	slice(start: number, end = this.length): LiveContextMessage[] {
		return this.items.slice(start, end).map(item => item.value.read());
	}
	digest(count = this.length): string {
		if (!Number.isSafeInteger(count) || count < 0 || count > this.length) throw new RangeError("Invalid captured prefix.");
		return this.#prefixes[count].copy().digest("hex");
	}
	prefix(count: number): Hash { return this.#prefixes[count].copy(); }
	get visibleTokens(): number { return this.items.reduce((total, item) => total + (item.profile.visible ? item.profile.tokens : 0), 0); }
	observed(): { tokens: number; index: number } | undefined {
		for (let index = this.length - 1; index >= 0; index--) {
			const tokens = this.items[index].profile.observedTokens;
			if (tokens !== undefined) return { tokens, index };
		}
		return undefined;
	}
	resultIds(): Set<unknown> { return new Set(this.items.flatMap(item => item.profile.resultId === undefined ? [] : [item.profile.resultId])); }
	failedResults(ids: ReadonlyMap<string, boolean>): boolean {
		return this.items.some(item => item.profile.resultId !== undefined && ids.has(item.profile.resultId) && item.profile.isError);
	}
}

/** Exact frame and shared owned body/source values; read() returns a full document. */
export class CapturedDocument {
	constructor(readonly frame: Omit<ContextDocumentSnapshot, "text" | "messages" | "blocks">,
		readonly messages: CapturedMessages,
		readonly blocks: readonly { index: number; id: string; role: string; protected: boolean; header: string; body: CapturedValue<string> }[]) {}
	readText(): string {
		return [`[[LIVE_CONTEXT version=${this.frame.version} revision=${this.frame.revision} document=${this.frame.documentId} baseline=${this.frame.baselineDigest}]]`,
			"# Edit bodies or delete editable CTX_TURN blocks. Keep metadata/header lines intact.",
			...this.blocks.map(block => `${block.header}\n${block.body.read()}`)].join("\n\n");
	}
	read(): ContextDocumentSnapshot {
		const messages = this.messages.readAll();
		return { ...this.frame, text: this.readText(), messages,
			blocks: this.blocks.map(block => ({ ...block, body: block.body.read(), source: messages[block.index] })) };
	}
}

/** Cold derived checkpoint values keep the persisted format and exact recovery result. */
export class CapturedCheckpoint {
	readonly frame: Pick<ProjectionCheckpoint, "revision" | "sourceMessageCount" | "sourceDigest">;
	constructor(readonly value: CapturedValue<ProjectionCheckpoint>, checkpoint: ProjectionCheckpoint) {
		this.frame = { revision: checkpoint.revision, sourceMessageCount: checkpoint.sourceMessageCount, sourceDigest: checkpoint.sourceDigest };
	}
	read(): ProjectionCheckpoint { return this.value.read(); }
}

/** Share detached messages by content, not the SDK's request-local object identity. */
export class SnapshotMessages {
	private readonly sourceValues = new Map<string, CapturedMessage>();
	private readonly valueBuckets = new Map<string, CapturedMessage[]>();
	private readonly capturedValues = new Set<CapturedValue<unknown>>();
	private previous?: CapturedMessages;

	private own<T>(store: MirrorStore, value: T): CapturedValue<T> {
		const saved = new CapturedValue(store, value);
		this.capturedValues.add(saved);
		return saved;
	}

	/** Capture before yielding/publishing. Never retain a borrowed plan in the result. */
	captureSource(source: SnapshotMessageSource, store: MirrorStore, profile: (message: LiveContextMessage) => MessageProfile, previous = this.previous): CapturedMessages {
		source.validate();
		if (source.length !== source.contributions.length) throw new Error("Invalid source extent.");
		const before = new Set(this.capturedValues);
		const added = new Set<string>();
		try {
			const captured = CapturedMessages.capture((function* (pool: SnapshotMessages) {
				for (let index = 0; index < source.length; index++) {
					const key = source.contributions[index].key;
					let item = pool.sourceValues.get(key);
					let message: LiveContextMessage | undefined;
					if (!item || item.value.store !== store) {
						message = source.read(index) as LiveContextMessage;
						const digest = digestMessages([message]);
						const equal = pool.valueBuckets.get(digest)?.find(candidate => candidate.value.store === store && isDeepStrictEqual(candidate.value.read(), message));
						item = { key, digest, value: equal?.value ?? pool.own(store, message), profile: equal?.profile ?? profile(message), bodies: equal?.bodies ?? {} };
						pool.sourceValues.set(key, item); added.add(key);
					}
					yield { item, message };
				}
			})(this), previous);
			source.validate();
			for (const item of captured.items) if (added.has(item.key)) {
				const digest = item.digest;
				const bucket = this.valueBuckets.get(digest) ?? [];
				bucket.push(item); this.valueBuckets.set(digest, bucket);
			}
			this.previous = captured;
			return captured;
		} catch (error) {
			for (const key of added) this.sourceValues.delete(key);
			for (const value of this.capturedValues) if (!before.has(value)) { value.remove(); this.capturedValues.delete(value); }
			throw error;
		}
	}

	captureValues(messages: LiveContextMessage[], store: MirrorStore, profile: (message: LiveContextMessage) => MessageProfile): CapturedMessages {
		// Untrusted/transformed arrays have no immutable source keys. Never borrow aliases.
		const previous = this.previous;
		const contributions = messages.map(message => {
			const digest = digestMessages([message]);
			const existing = this.valueBuckets.get(digest)?.find(item => item.value.store === store && isDeepStrictEqual(item.value.read(), message));
			return { key: existing?.key ?? randomUUID() };
		});
		try {
			return this.captureSource({ length: messages.length, contributions,
				read: index => messages[index], validate() {} }, store, profile);
		} finally { this.previous = previous; }
	}

	captureDocument(messages: LiveContextMessage[], store: MirrorStore, profile: (message: LiveContextMessage) => MessageProfile,
		options: RenderContextDocumentOptions): CapturedDocument {
		const captured = this.captureValues(messages, store, profile);
		const snapshot = renderContextDocument(messages, options);
		const blocks = snapshot.blocks.map(block => {
			const item = captured.items[block.index];
			const key = options.documentSeed === undefined ? "plain" : "escaped";
			const body = item.bodies[key] ??= this.own(store, block.body);
			return { index: block.index, id: block.id, role: block.role, protected: block.protected, header: block.header, body };
		});
		const { version, revision, baselineDigest, documentId, stableDocument } = snapshot;
		return new CapturedDocument({ version, revision, baselineDigest, documentId, stableDocument }, captured, blocks);
	}

	/** Direct-write deduplication owns exact changed text without pinning its rendering. */
	captureText(text: string, store: MirrorStore): CapturedValue<string> {
		return this.own(store, text);
	}

	captureCheckpoint(checkpoint: ProjectionCheckpoint, store: MirrorStore): CapturedCheckpoint {
		return new CapturedCheckpoint(this.own(store, checkpoint), checkpoint);
	}

	/** Call only with all current/draft/view/in-flight owners, after serialized work. */
	retainCaptured(owners: Iterable<CapturedMessages | CapturedDocument | CapturedCheckpoint | CapturedValue<unknown>>): void {
		const values = new Set<CapturedValue<unknown>>();
		const records = new Set<CapturedMessage>();
		for (const owner of owners) {
			if (owner instanceof CapturedValue) { values.add(owner); continue; }
			if (owner instanceof CapturedCheckpoint) { values.add(owner.value); continue; }
			const messages = owner instanceof CapturedDocument ? owner.messages : owner;
			for (const item of messages.items) {
				records.add(item); values.add(item.value);
				for (const body of Object.values(item.bodies)) if (body) values.add(body);
			}
			if (owner instanceof CapturedDocument) for (const block of owner.blocks) values.add(block.body);
		}
		for (const [key, item] of this.sourceValues) if (!records.has(item)) this.sourceValues.delete(key);
		for (const [digest, bucket] of this.valueBuckets) {
			const kept = bucket.filter(item => records.has(item));
			if (kept.length) this.valueBuckets.set(digest, kept); else this.valueBuckets.delete(digest);
		}
		if (this.previous && !this.previous.items.every(item => records.has(item))) this.previous = undefined;
		for (const value of this.capturedValues) if (!values.has(value)) { value.remove(); this.capturedValues.delete(value); }
	}

	private readonly buckets = new Map<string, LiveContextMessage[]>();
	private readonly renderedBodies = new WeakMap<LiveContextMessage, { plain?: string; escaped?: string }>();

	/** Render only captured values: mutable request objects must never key this cache. */
	render(messages: LiveContextMessage[], options: RenderContextDocumentOptions = {}): ContextDocumentSnapshot {
		return renderContextDocument(this.capture(messages), options, (source, escaped) => {
			const bodies = this.renderedBodies.get(source) ?? {};
			const key = escaped ? "escaped" : "plain";
			if (bodies[key] === undefined) {
				const body = renderMessage(source);
				bodies[key] = escaped ? escapeStructuralLines(body) : body;
				this.renderedBodies.set(source, bodies);
			}
			return bodies[key];
		});
	}

	capture(messages: LiveContextMessage[]): LiveContextMessage[] {
		return messages.map((message) => {
			const digest = digestMessages([message]);
			const candidates = this.buckets.get(digest) ?? [];
			// A digest is an index, not permission to substitute different content.
			const existing = candidates.find((candidate) => isDeepStrictEqual(candidate, message));
			if (existing) return existing;
			const value = structuredClone(message);
			candidates.push(value);
			this.buckets.set(digest, candidates);
			return value;
		});
	}

	/** The draft owners, including their raw source prefixes, define cache lifetime. */
	retain(messages: Iterable<LiveContextMessage>): void {
		const owned = new Set(messages);
		for (const [digest, candidates] of this.buckets) {
			const retained = candidates.filter((message) => owned.has(message));
			if (retained.length) this.buckets.set(digest, retained);
			else this.buckets.delete(digest);
		}
	}

	/** Legacy reuse cache; captured owners are released through retainCaptured. */
	clear(): void {
		this.buckets.clear();
	}
}
