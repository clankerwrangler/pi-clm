/** Public synthetic ownership probe. Run in a fresh Node process with --expose-gc.
 * Arguments: SDK programmatic module, CLM checkout/integration directory, 65536..70000 entries.
 * No session directories or external data are read. */
import assert from "node:assert/strict";
import { mkdtempSync, openSync, closeSync, writeSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { queryObjects } from "node:v8";

const [sdkPath, clmPath, countText] = process.argv.slice(2);
const count = Number(countText);
assert.ok(Number.isSafeInteger(count) && count >= 65536 && count <= 70000);
assert.equal(typeof global.gc, "function", "isolated probe requires --expose-gc");
const gc = () => { global.gc!(); global.gc!(); };
const sdk = await import(pathToFileURL(resolve(sdkPath)).href);
const clm = resolve(clmPath);
const { default: extension } = await import(pathToFileURL(join(clm, "src/index.ts")).href);
const { SnapshotMessages, CapturedCheckpoint } = await import(pathToFileURL(join(clm, "src/snapshot-messages.ts")).href);
const { createProjectionCheckpoint, PROJECTION_PREFIX_MISMATCH_REASON } = await import(pathToFileURL(join(clm, "src/projection.ts")).href);
const dir = mkdtempSync(join(tmpdir(), "clm-public-reader-probe-"));
const path = join(dir, "public.jsonl");
const raw = [{ role: "user", content: "public task", timestamp: 1 }];
const answer = { role: "assistant", content: "successful retry", stopReason: "stop", timestamp: 3 };
const resumed = [...raw, { role: "assistant", content: [], stopReason: "error", timestamp: 2 }, answer,
 { role: "user", content: "continue", timestamp: 4 }];
const fd = openSync(path, "wx", 0o600);
try {
 writeSync(fd, JSON.stringify({ type: "session", version: 3, id: "public-reader-probe", cwd: dir, timestamp: "2026-01-01T00:00:00Z" }) + "\n");
 for (let index = 0; index < count; index++) {
  const revision = index - (count - 13) + 1;
  let row: unknown = { type: "label", targetId: "public", label: `public-${index}` };
  if (revision >= 1 && revision <= 12) {
   const sourceMessages = revision === 1 ? raw : revision === 2 ? [...raw, answer] : [{ role: "user", content: `unmatched-${revision}`, timestamp: 1 }];
   const checkpoint = createProjectionCheckpoint({ revision, sourceMessages,
    projectedMessages: [{ role: "custom", customType: "notes", content: revision === 2 ? "recovered public summary" : `${revision}:` + "P".repeat(1024 * 1024), timestamp: 3 }],
    beforeEstimate: 100, afterEstimate: 10 });
   row = { type: "custom", customType: "live-context-state", data: { version: 1, enabled: true, revision, checkpoint } };
  } else if (revision === 13) row = { type: "custom", customType: "live-context-state", data: { version: 1, enabled: true, revision,
   lastOutcome: { kind: "reset", message: PROJECTION_PREFIX_MISMATCH_REASON, at: "2026-01-01" } } };
  writeSync(fd, JSON.stringify({ ...row as object, id: `public-${index}`, parentId: index ? `public-${index - 1}` : null, timestamp: "2026-01-01T00:00:00Z" }) + "\n");
 }
} finally { closeSync(fd); }

const manager = sdk.SessionManager.open(path, dir, dir, { entryRetention: { maxCachedBytes: 0 } });
const report: Record<string, unknown> = { entries: count, sdk: sdkPath, clm, metadata: {}, recovery: {} };
try {
 // SDK-only construction deltas exclude archive indexing, which is already owned.
 for (const method of ["buildSessionEntrySource", "buildSessionEntryReader"] as const) {
  gc(); const before = process.memoryUsage().heapUsed;
  let source = manager[method]();
  gc(); const retainedHeapBytes = process.memoryUsage().heapUsed - before;
  (report.metadata as Record<string, unknown>)[method] = { retainedHeapBytes };
  source.validate(); source = undefined;
 }
 const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
 const pi = { events: sdk.createEventBus(), on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(name, [...handlers.get(name) ?? [], handler]); }, registerCommand() {}, registerTool() {},
  appendEntry(customType: string, data: unknown) { manager.appendCustomEntry(customType, data); } };
 const ctx = { mode: "rpc", cwd: dir, hasUI: false, model: { contextWindow: 10000000 }, sessionManager: manager,
  getSystemPrompt: () => "", getContextUsage: () => undefined, ui: { setStatus() {}, notify() {} } };
 extension(pi, { editingMode: "clm", overflow: { mode: "off" } });
 const emit = async (name: string, event: object = {}) => { const results = []; for (const handler of handlers.get(name) ?? []) results.push(await handler({ type: name, ...event }, ctx)); return results; };
 let headers = 0, sourceCalls = 0, readerCalls = 0;
 const freeze = Object.freeze;
 Object.freeze = function(value: unknown) {
  if (value && typeof value === "object" && "key" in value && "parentId" in value && "id" in value) headers++;
  return freeze(value);
 } as typeof Object.freeze;
 for (const method of ["buildSessionEntryReader", "buildSessionEntrySource"] as const) {
  const original = manager[method].bind(manager);
  manager[method] = () => { if (method === "buildSessionEntryReader") readerCalls++; else sourceCalls++; return original(); };
 }
 gc(); const beforeRestore = process.memoryUsage().heapUsed;
 await emit("session_start");
 gc(); const restoreRetainedHeapBytes = process.memoryUsage().heapUsed - beforeRestore;
 Object.freeze = freeze;
 Object.assign(report.metadata as object, { restoreRetainedHeapBytes, headersCreated: headers, readerCalls, sourceCalls });

 const fences: Record<string, boolean> = {};
 // Mutate only this generated file. A borrowed read must reject its changed bytes.
 const position = count - 13;
 const location = manager.retention.entries[position].location;
 const rewriteFd = openSync(path, "r+");
 const byte = Buffer.alloc(1);
 try {
  readSync(rewriteFd, byte, 0, 1, location.offset);
  writeSync(rewriteFd, Buffer.from([byte[0] ^ 1]), 0, 1, location.offset);
  await assert.rejects(emit("context", { messages: resumed }), /changed outside the append-only session manager/);
  fences.committedBytes = true;
 } finally { writeSync(rewriteFd, byte, 0, 1, location.offset); closeSync(rewriteFd); }
 if (readerCalls > 0) {
  const reader = manager.buildSessionEntryReader();
  const header = reader.getEntryHeader(position);
  const original = reader.read(position, header.key);
  const changed = structuredClone(original);
  changed.data.checkpoint.projectedMessages[0].content = "redirected public candidate";
  manager._persist(changed);
  await assert.rejects(emit("context", { messages: resumed }), /reader key changed/);
  manager._persist(original);
  fences.capturedKey = true;
 }
 report.fences = fences;

 // Query only a synthetic prototype, not private/runtime history or a heap dump.
 // The probe tags complete values returned at the existing archive/owned read boundaries.
 class Candidate {}
 let peak = 0, reads = 0, captures = 0, ownedReads = 0;
 const sample = (checkpoint: object) => {
  Object.setPrototypeOf(checkpoint, Candidate.prototype);
  const current = queryObjects(Candidate, { format: "count" });
  peak = Math.max(peak, current);
 };
 const storedRead = manager._readStored.bind(manager);
 manager._readStored = (stored: unknown) => { const entry = storedRead(stored); if (entry?.data?.checkpoint) { reads++; sample(entry.data.checkpoint); } return entry; };
 const capture = SnapshotMessages.prototype.captureCheckpoint;
 SnapshotMessages.prototype.captureCheckpoint = function(...args: unknown[]) { captures++; return capture.apply(this, args); };
 const ownedRead = CapturedCheckpoint.prototype.read;
 CapturedCheckpoint.prototype.read = function() { const value = ownedRead.call(this); ownedReads++; sample(value); return value; };
 try {
  const output = await emit("context", { messages: resumed });
  assert.match(JSON.stringify(output), /recovered public summary/);
  assert.match(JSON.stringify(output), /Recovered projection revision 2/);
  Object.assign(report.recovery as object, { historicalArchiveReads: reads, captures, ownedReads, peakSimultaneouslyReachableCandidates: peak });
  const borrowed = manager.buildSessionEntryReader();
  manager.setSessionFile(path);
  assert.throws(() => borrowed.validate(), /expired/);
  await emit("context", { messages: resumed });
  fences.generation = true;
  fences.capturedValuesSurviveReload = true;
 } finally { await emit("session_shutdown"); }
 console.log(JSON.stringify(report, null, 2));
} finally { rmSync(dir, { recursive: true, force: true }); }
