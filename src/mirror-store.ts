import { chmod, mkdtemp, readdir, readFile, rename, rm, stat, lstat, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync, unlinkSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";

const STALE_MIRROR_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function safeSessionId(sessionId: string): string {
	const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48);
	return safe || "session";
}

/**
 * Best-effort removal of mirror directories left behind by sessions that never reached
 * shutdown. Live sessions rewrite their mirror every turn, so a directory whose mtime
 * is older than the threshold has no owner. Failures are ignored: another process may
 * remove or own an entry concurrently.
 */
async function sweepStaleMirrors(parentDirectory: string, keepDirectory: string, maxAgeMs: number): Promise<void> {
	let names: string[];
	try {
		names = await readdir(parentDirectory);
	} catch {
		return;
	}
	const cutoff = Date.now() - maxAgeMs;
	for (const name of names) {
		if (!name.startsWith("pi-live-context-")) continue;
		const directory = join(parentDirectory, name);
		if (directory === keepDirectory) continue;
		try {
			const info = await stat(directory);
			if (!info.isDirectory() || info.mtimeMs >= cutoff) continue;
			await rm(directory, { recursive: true, force: true });
		} catch {
			// Ignored: sweeping is opportunistic hygiene only.
		}
	}
}

export class MirrorStore {
	readonly directory: string;
	readonly filePath: string;
	readonly submissionPath: string;
	private disposed = false;

	private constructor(directory: string) {
		this.directory = directory;
		this.filePath = join(directory, "LIVE_CONTEXT.md");
		this.submissionPath = join(directory, "LIVE_CONTEXT.commit.md");
	}

	static async create(
		sessionId: string,
		parentDirectory = tmpdir(),
		staleAgeMs = STALE_MIRROR_AGE_MS,
	): Promise<MirrorStore> {
		const prefix = join(parentDirectory, `pi-live-context-${safeSessionId(sessionId)}-`);
		const directory = await mkdtemp(prefix);
		await chmod(directory, 0o700);
		await sweepStaleMirrors(parentDirectory, directory, staleAgeMs).catch(() => undefined);
		return new MirrorStore(directory);
	}

	async write(content: string, canPublish: () => boolean = () => true): Promise<boolean> {
		if (this.disposed) throw new Error("Mirror store has been disposed.");
		const temporaryPath = join(this.directory, `.${basename(this.filePath)}.${randomUUID()}.tmp`);
		try {
			await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
			if (!canPublish()) {
				await rm(temporaryPath, { force: true });
				return false;
			}
			await rename(temporaryPath, this.filePath);
			await chmod(this.filePath, 0o600);
			return true;
		} catch (error) {
			await rm(temporaryPath, { force: true }).catch(() => undefined);
			throw error;
		}
	}

	async read(): Promise<string | undefined> {
		if (this.disposed) return undefined;
		try {
			const info = await lstat(this.filePath);
			if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error("Mirror must be a regular file of at most 16 MiB.");
			return await readFile(this.filePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	/** Claim an atomically published candidate; never read a file still being edited. */
	async readSubmission(): Promise<string | undefined> {
		if (this.disposed) return undefined;
		const claimed = join(this.directory, `.submission-${randomUUID()}`);
		try {
			await rename(this.submissionPath, claimed);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		try {
			const info = await lstat(claimed);
			if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error("Submission must be a regular file of at most 16 MiB.");
			return await readFile(claimed, "utf8");
		} finally {
			await rm(claimed, { force: true });
		}
	}

	/** Immutable captured-view payloads share this mirror's private lifetime. */
	writeSnapshot(bytes: Uint8Array): string {
		if (this.disposed) throw new Error("Mirror store has been disposed.");
		const name = `.snapshot-${randomUUID()}`;
		// Establish exclusive ownership before installing any failure cleanup. A failed
		// create (including EEXIST) must never unlink another capture's sole value.
		const file = openSync(join(this.directory, name), "wx", 0o600);
		try { writeFileSync(file, bytes); }
		catch (error) {
			try { unlinkSync(join(this.directory, name)); } catch { /* Preserve the original write failure. */ }
			throw error;
		} finally { closeSync(file); }
		return name;
	}

	readSnapshot(name: string): Buffer {
		if (this.disposed) throw new Error("Mirror store has been disposed.");
		if (!/^\.snapshot-[a-f0-9-]+$/.test(name)) throw new Error("Invalid snapshot reference.");
		return readFileSync(join(this.directory, name));
	}

	removeSnapshot(name: string): void {
		if (!/^\.snapshot-[a-f0-9-]+$/.test(name)) throw new Error("Invalid snapshot reference.");
		try { unlinkSync(join(this.directory, name)); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	}

	async cleanup(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		await rm(this.directory, { recursive: true, force: true });
	}
}
