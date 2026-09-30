export type LiveContextMessage = {
	role: string;
	content?: unknown;
	timestamp?: number;
	[key: string]: unknown;
};

export interface DocumentBlock {
	index: number;
	id: string;
	role: string;
	protected: boolean;
	header: string;
	body: string;
	source: LiveContextMessage;
}

export interface ContextDocumentSnapshot {
	version: 1;
	revision: number;
	baselineDigest: string;
	/** Per-document framing nonce. Derived from the baseline digest, or from a stable seed. */
	documentId: string;
	/** True when the nonce is seed-based and bodies were escaped (see renderContextDocument). */
	stableDocument?: boolean;
	text: string;
	messages: LiveContextMessage[];
	blocks: DocumentBlock[];
}

/** An immutable context snapshot retained for a bounded number of requests. */
export interface TurnBaseline {
	rawMessages: LiveContextMessage[];
	effectiveMessages: LiveContextMessage[];
	snapshot: ContextDocumentSnapshot;
}

export interface ApplyDocumentOptions {
	/** CLM permits reordered blocks and new IDs prefixed with new-. */
	editingMode?: "conservative" | "clm";
	requireShrink?: boolean;
	minSavings?: number;
	/** Estimator for the shrink gate. Defaults to the rendered-character estimate. */
	estimate?: (messages: LiveContextMessage[]) => number;
	/** Unit named in gate diagnostics. Defaults to "characters". */
	estimateUnit?: "characters" | "tokens";
}

export type ContextEditSourceKind = "kept" | "edited" | "removed" | "restored" | "normalized";

export interface ContextEditSourceTrace {
	/** Zero-based index in the exact effective context rendered to the mirror. */
	sourceIndex: number;
	/** Zero-based index in the accepted projected context; absent when removed. */
	outputIndex?: number;
	kind: ContextEditSourceKind;
}

export interface ContextEditAdditionTrace {
	/** Zero-based index in the accepted projected context. */
	outputIndex: number;
	kind: "added";
}

/** Compact provenance for reconstructing one accepted mirror edit without duplicating message bodies. */
export interface ContextEditTrace {
	version: 1;
	sourceRevision: number;
	sourceMessageCount: number;
	outputMessageCount: number;
	sources: ContextEditSourceTrace[];
	additions: ContextEditAdditionTrace[];
}

export interface ApplyDocumentResult {
	accepted: boolean;
	changed: boolean;
	messages: LiveContextMessage[];
	/** Sizes in the gate's estimate unit (characters by default, or the injected estimator's unit). */
	beforeEstimate: number;
	afterEstimate: number;
	savingsEstimate: number;
	diagnostics: string[];
	editTrace?: ContextEditTrace;
	reason?: string;
}
