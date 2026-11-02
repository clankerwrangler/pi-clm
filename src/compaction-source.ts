import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { canonicalMessage } from "./context-document.ts";
import { capObservations, type ObservationCapPolicy } from "./observation.ts";
import { selectContextVisibleMessages } from "./policy.ts";
import type { ProjectionCheckpoint } from "./projection.ts";
import type { SnapshotMessageSource } from "./snapshot-messages.ts";
import type { LiveContextMessage } from "./types.ts";

/** Read the accepted projection without accepting a submission or changing turn/mirror state. */
export function compactionSource(source: SnapshotMessageSource, checkpoint: ProjectionCheckpoint,
	observationCap: ObservationCapPolicy, validateAccepted: () => void) {
	const validate = () => { source.validate(); validateAccepted(); };
	validate();
	const count = checkpoint.sourceMessageCount;
	if (!Number.isSafeInteger(count) || count < 1 || count > source.length) throw new Error("Invalid accepted compaction prefix");
	if (checkpoint.sourceEntryId !== undefined) {
		if (source.contributions[count - 1]?.sourceEntryId !== checkpoint.sourceEntryId) throw new Error("Accepted compaction prefix moved");
	} else {
		// Old accepted checkpoints have no bookmark. Verify them record by record,
		// never retain a second full historical prefix merely to compute its digest.
		if (checkpoint.sourceDigestPartial) throw new Error("Accepted compaction prefix lacks a bookmark");
		const hash = createHash("sha256");
		for (let i = 0; i < count; i++) hash.update(canonicalMessage(source.read(i) as LiveContextMessage)).update("\n");
		if (hash.digest("hex") !== checkpoint.sourceDigest) throw new Error("Accepted compaction prefix changed");
	}
	const suffix = Array.from({ length: source.length - count }, (_, i) => source.read(count + i) as LiveContextMessage);
	const messages = structuredClone(capObservations(selectContextVisibleMessages([...checkpoint.projectedMessages, ...suffix]), observationCap));
	const identity = randomUUID();
	const contributions = messages.map((message, index) => ({ key: `${identity}:${index}`, role: message.role }));
	// Preserve provenance only for a complete exact unchanged suffix. The stock
	// owner independently certifies values, order and canonical group boundaries.
	for (let i = 0; i < suffix.length && i < messages.length; i++) {
		const output = messages.length - i - 1, original = suffix.length - i - 1;
		if (!isDeepStrictEqual(messages[output], suffix[original])) break;
		contributions[output] = { ...source.contributions[count + original], role: messages[output].role };
	}
	validate();
	return Object.freeze({ length: messages.length, contributions: Object.freeze(contributions.map(item => Object.freeze(item))),
		read(index: number) {
			validate();
			if (!Number.isSafeInteger(index) || index < 0 || index >= messages.length) throw new RangeError("Invalid compaction context index");
			return structuredClone(messages[index]);
		},
		readAll() { validate(); return structuredClone(messages); },
		currentSystemMessage: () => undefined, validate,
	});
}
