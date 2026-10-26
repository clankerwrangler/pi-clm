/**
 * Content-addressed storage for checkpoint message bodies.
 *
 * An inline checkpoint repeats the whole projected context in every accepted
 * `live-context-state` entry, so a long session's JSONL accumulates one full transcript
 * copy per edit. The persisted form instead lists one SHA-256 reference per projected
 * message and stores each distinct message once, beside the session file. Messages kept
 * across edits therefore cost one reference per checkpoint rather than one copy.
 *
 * Properties:
 * - the session entry names its absolute store directory, so forks and copies of the
 *   transcript resolve the same immutable files (as overflow artifacts already do);
 * - files are published before the entry that references them is appended;
 * - every read verifies the exact file bytes against the reference; a missing or
 *   altered message makes the checkpoint unavailable rather than partially applied;
 * - inline checkpoints from older entries remain readable unchanged.
 */

import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type { ProjectionCheckpoint } from "./projection.ts";
import type { LiveContextMessage } from "./types.ts";

export interface StoredProjectedMessages {
	version: 1;
	/** Absolute directory holding `<sha256>.json` message files. */
	directory: string;
	refs: string[];
}

/** The persisted checkpoint shape: identical to ProjectionCheckpoint except for its message bodies. */
export type StoredProjectionCheckpoint = Omit<ProjectionCheckpoint, "projectedMessages"> & {
	projectedMessageStore: StoredProjectedMessages;
};

const HASH = /^[a-f0-9]{64}$/;

export function checkpointStoreDirectory(sessionFile: string): string {
	return `${sessionFile}.clm-checkpoints`;
}

export function isStoredProjectedMessages(value: unknown): value is StoredProjectedMessages {
	if (!value || typeof value !== "object") return false;
	const store = value as Partial<StoredProjectedMessages>;
	return store.version === 1 &&
		typeof store.directory === "string" && isAbsolute(store.directory) &&
		Array.isArray(store.refs) && store.refs.every((ref) => typeof ref === "string" && HASH.test(ref));
}

function assertDirectory(directory: string): void {
	const info = lstatSync(directory);
	if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid checkpoint store directory.");
}

/** Publish one immutable message body under its content hash. Never replace an existing file. */
function publishMessage(directory: string, hash: string, bytes: string): boolean {
	const file = join(directory, `${hash}.json`);
	try {
		const info = lstatSync(file);
		if (!info.isFile() || info.isSymbolicLink()) throw new Error("Checkpoint message path is not a regular file.");
		return false;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const temporary = join(directory, `.${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
		const fd = openSync(temporary, "r");
		try { fsyncSync(fd); } finally { closeSync(fd); }
		try { linkSync(temporary, file); } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		return true;
	} finally {
		try { unlinkSync(temporary); } catch { /* No temporary file remains after publication. */ }
	}
}

/**
 * Write the checkpoint's message bodies and return its persisted form. Throws on any
 * storage failure; callers then persist the inline checkpoint instead.
 */
export function storeCheckpointMessages(checkpoint: ProjectionCheckpoint, directory: string): StoredProjectionCheckpoint {
	if (!isAbsolute(directory)) throw new Error("Checkpoint store directory must be absolute.");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	assertDirectory(directory);
	const refs: string[] = [];
	let published = false;
	for (const message of checkpoint.projectedMessages) {
		const bytes = JSON.stringify(message);
		const hash = createHash("sha256").update(bytes).digest("hex");
		if (publishMessage(directory, hash, bytes)) published = true;
		refs.push(hash);
	}
	if (published && process.platform !== "win32") {
		const directoryFd = openSync(directory, "r");
		try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
	}
	const { projectedMessages: _bodies, ...rest } = checkpoint;
	return { ...rest, projectedMessageStore: { version: 1, directory, refs } };
}

/**
 * Read stored message bodies. Returns undefined when any message is missing, is not a
 * regular file, or does not hash to its reference.
 */
export function readStoredMessages(store: StoredProjectedMessages): LiveContextMessage[] | undefined {
	try {
		assertDirectory(store.directory);
		const messages: LiveContextMessage[] = [];
		for (const ref of store.refs) {
			const file = join(store.directory, `${ref}.json`);
			const info = lstatSync(file);
			if (!info.isFile() || info.isSymbolicLink()) return undefined;
			const bytes = readFileSync(file, "utf8");
			if (createHash("sha256").update(bytes).digest("hex") !== ref) return undefined;
			const message = JSON.parse(bytes) as LiveContextMessage;
			if (!message || typeof message !== "object" || typeof message.role !== "string") return undefined;
			messages.push(message);
		}
		return messages;
	} catch {
		return undefined;
	}
}
