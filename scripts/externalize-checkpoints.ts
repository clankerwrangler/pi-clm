/**
 * Rewrite a stopped session's inline `live-context-state` checkpoints into the stored form.
 *
 * Usage: tsx scripts/externalize-checkpoints.ts [--write] SESSION.jsonl...
 *
 * Without --write the session is only measured. With --write a sibling file is written,
 * every converted entry is read back and compared with its original, and the sibling then
 * atomically replaces the session. Every other line is copied byte for byte. The session
 * must not be open by a writer: a size or mtime change during the run aborts it.
 */

import { createReadStream, createWriteStream, fsyncSync, openSync, closeSync, renameSync, statSync, unlinkSync, chmodSync } from "node:fs";
import { once } from "node:events";
import { isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { checkpointStoreDirectory, storeCheckpointMessages } from "../src/checkpoint-store.ts";
import { LIVE_CONTEXT_STATE, isLiveContextState, readLiveContextState } from "../src/state.ts";

async function externalize(sessionFile: string, write: boolean): Promise<void> {
	const before = statSync(sessionFile);
	const directory = checkpointStoreDirectory(sessionFile);
	const temporary = `${sessionFile}.externalize-${process.pid}.tmp`;
	const output = write ? createWriteStream(temporary, { flags: "wx", mode: before.mode & 0o777 }) : undefined;
	let converted = 0, inBytes = 0, outBytes = 0;
	try {
		const lines = createInterface({ input: createReadStream(sessionFile), crlfDelay: Infinity });
		for await (const line of lines) {
			inBytes += Buffer.byteLength(line) + 1;
			let next = line;
			if (line.includes(`"customType":"${LIVE_CONTEXT_STATE}"`) && line.includes(`"projectedMessages"`)) {
				const entry = JSON.parse(line);
				if (entry.type === "custom" && entry.customType === LIVE_CONTEXT_STATE &&
					isLiveContextState(entry.data) && entry.data.checkpoint) {
					if (write) {
						const stored = { ...entry, data: { ...entry.data, checkpoint: storeCheckpointMessages(entry.data.checkpoint, directory) } };
						next = JSON.stringify(stored);
						const roundTrip = readLiveContextState(JSON.parse(next).data);
						if (!isDeepStrictEqual(roundTrip, entry.data)) throw new Error(`Entry ${entry.id} does not read back identically.`);
					} else {
						next = JSON.stringify({ ...entry, data: { ...entry.data, checkpoint: { ...entry.data.checkpoint, projectedMessages: undefined } } });
					}
					converted++;
				}
			}
			outBytes += Buffer.byteLength(next) + 1;
			if (output && !output.write(`${next}\n`)) await once(output, "drain");
		}
		if (output) {
			output.end();
			await once(output, "finish");
			const fd = openSync(temporary, "r");
			try { fsyncSync(fd); } finally { closeSync(fd); }
		}
		const after = statSync(sessionFile);
		if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("Session changed during rewrite; it must not be open.");
		if (output) {
			chmodSync(temporary, before.mode & 0o777);
			renameSync(temporary, sessionFile);
		}
		const mb = (bytes: number) => (bytes / 1e6).toFixed(1);
		console.log(`${write ? "rewrote" : "would rewrite"} ${converted} checkpoint(s): ${mb(inBytes)} MB -> ${mb(outBytes)} MB  ${sessionFile}`);
	} catch (error) {
		if (output) { output.destroy(); try { unlinkSync(temporary); } catch { /* not created */ } }
		throw error;
	}
}

const args = process.argv.slice(2);
const write = args.includes("--write");
const files = args.filter((arg) => arg !== "--write").map((file) => resolve(file));
if (files.length === 0) {
	console.error("Usage: tsx scripts/externalize-checkpoints.ts [--write] SESSION.jsonl...");
	process.exit(2);
}
let failed = false;
for (const file of files) {
	try { await externalize(file, write); } catch (error) {
		failed = true;
		console.error(`failed: ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
process.exit(failed ? 1 : 0);
