import { isDeepStrictEqual } from "node:util";

import { digestMessages, escapeStructuralLines, renderContextDocument, renderMessage, type RenderContextDocumentOptions } from "./context-document.ts";
import type { ContextDocumentSnapshot, LiveContextMessage } from "./types.ts";

/** Share detached messages by content, not the SDK's request-local object identity. */
export class SnapshotMessages {
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

	clear(): void {
		this.buckets.clear();
	}
}
