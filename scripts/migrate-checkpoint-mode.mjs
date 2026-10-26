#!/usr/bin/env node
// Offline, append-only CLM mode migration. No actor, provider, or kernel is created.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, lstat, open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sha = value => createHash('sha256').update(value).digest('hex');
const requireThat = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { migrationCode: code }); };
const digestSequence = (values, canonical) => {
  const hash = createHash('sha256');
  for (const value of values) hash.update(canonical(value)).update('\n');
  return hash.digest('hex');
};

/** Compare full canonical values and immutable source identities without retaining bodies. */
export function proveModeRelation({ ordinary, native, checkpoint, canonical }) {
  requireThat(ordinary.length === native.length, 'MODE_LENGTH_CHANGED');
  const count = checkpoint.sourceMessageCount;
  requireThat(Number.isSafeInteger(count) && count >= 0 && count <= native.length, 'INVALID_CHECKPOINT_FRONTIER');
  const old = new Map(), oldOrder = [], nativeRecords = [], suffix = [];
  const summaries = {}; let changedOrder = 0, boundaryCrossings = 0, suffixSameOrdered = true;
  for (const [mode, source] of [['ordinary', ordinary], ['native', native]]) {
    source.validate(); const hash = createHash('sha256'); let prefixDigest = count === 0 ? hash.copy().digest('hex') : undefined;
    const seen = new Set();
    for (let i = 0; i < source.length; i++) {
      requireThat(source.contributions[i].role !== 'system', 'UNEXPECTED_SYSTEM_CONTRIBUTION');
      const message = source.read(i); const text = canonical(message); const digest = sha(text);
      hash.update(text).update('\n'); if (i + 1 === count) prefixDigest = hash.copy().digest('hex');
      const key = source.contributions[i].key;
      // Bound to the selected H outer key suffix: SDK key, mode, signature SHA-256, omitted-call JSON.
      const parsed = typeof key === 'string' ? key.match(new RegExp(`^(.*):${mode}:([a-f0-9]{64}):(\\[.*\\])$`)) : null;
      requireThat(parsed, 'INVALID_MODE_SOURCE_KEY');
      const omitted = JSON.parse(parsed[3]);
      requireThat(Array.isArray(omitted) && omitted.every(id => typeof id === 'string'), 'INVALID_MODE_SOURCE_KEY');
      const identity = `${parsed[1]}:MODE:${parsed[2]}:${parsed[3]}`;
      requireThat(!seen.has(identity), 'DUPLICATE_SOURCE_IDENTITY'); seen.add(identity);
      if (mode === 'ordinary') { old.set(identity, { index: i, digest }); oldOrder.push(identity); }
      else {
        const previous = old.get(identity);
        requireThat(previous, 'SOURCE_IDENTITY_CHANGED');
        requireThat(previous.digest === digest, 'SOURCE_MESSAGE_CHANGED');
        if (previous.index !== i) changedOrder++;
        if ((previous.index < count) !== (i < count)) boundaryCrossings++;
        if (i >= count) { suffixSameOrdered &&= previous.index === i; suffix.push(message); }
        nativeRecords.push({ identity, role: message.role, toolCallId: message.toolCallId,
          asyncCalls: message.role === 'assistant' && Array.isArray(message.content)
            ? message.content.filter(block => block.type === 'toolCall' && block.async === true).map(block => block.id) : [] });
      }
    }
    source.validate(); summaries[mode] = { prefixDigest, digest: hash.digest('hex') };
  }
  requireThat(boundaryCrossings === 0, 'CHECKPOINT_BOUNDARY_CROSSED');
  requireThat(suffixSameOrdered, 'SUFFIX_ORDER_CHANGED');
  // Independently reproduce only the existing H ordinary replay's async-result relocation.
  const asyncCalls = new Set(nativeRecords.flatMap(record => record.asyncCalls));
  const movable = new Map(nativeRecords.filter(record => record.role === 'toolResult' && asyncCalls.has(record.toolCallId))
    .map(record => [record.toolCallId, record]));
  const expectedOrdinary = nativeRecords.flatMap(record => record.role === 'toolResult' && movable.has(record.toolCallId) ? []
    : [record.identity, ...record.asyncCalls.flatMap(id => movable.has(id) ? [movable.get(id).identity] : [])]);
  requireThat(expectedOrdinary.length === oldOrder.length && expectedOrdinary.every((identity, i) => identity === oldOrder[i]),
    'UNSUPPORTED_MODE_REORDER');
  const ordinaryPrefixValid = summaries.ordinary.prefixDigest === checkpoint.sourceDigest;
  const nativePrefixValid = summaries.native.prefixDigest === checkpoint.sourceDigest;
  requireThat(ordinaryPrefixValid || nativePrefixValid, 'CHECKPOINT_MATCHES_NEITHER_MODE');
  const projectedMessages = [...checkpoint.projectedMessages, ...suffix];
  return {
    proof: { ordinaryPrefixValid, nativePrefixValid, contributionCount: native.length, prefixCount: count,
      projectedCount: checkpoint.projectedMessages.length, prefixSameValues: true, suffixSameOrdered,
      boundaryCrossings, allowedRelocations: true, changedOrder, effectiveSequenceUnchanged: true },
    nativeDigest: summaries.native.digest, projectedMessages,
    effectiveDigest: digestSequence(projectedMessages, canonical),
  };
}

async function publishJson(path, value) {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
async function hashFile(path, bytes) {
  const hash = createHash('sha256');
  for await (const block of createReadStream(path, bytes === undefined ? {} : { start: 0, end: bytes - 1 })) hash.update(block);
  return hash.digest('hex');
}
async function identity(path) {
  const s = await lstat(path);
  requireThat(s.isFile() && !s.isSymbolicLink(), 'SESSION_NOT_REGULAR_FILE');
  return { dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs };
}
function unchanged(before, after) { return ['dev', 'ino', 'size', 'mtimeMs'].every(key => before[key] === after[key]); }
function parseArgs(argv) {
  const options = {};
  const values = new Set(['session', 'harness-root', 'sdk-root', 'clm-root', 'receipt', 'approved-receipt']);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    requireThat(argv[i].startsWith('--') && !Object.hasOwn(options, key), 'INVALID_ARGUMENT');
    if (values.has(key)) { requireThat(argv[i + 1] && !argv[i + 1].startsWith('--'), 'MISSING_ARGUMENT'); options[key] = resolve(argv[++i]); }
    else { requireThat(['append', 'confirm-exclusive-writer-stop'].includes(key), 'UNKNOWN_ARGUMENT'); options[key] = true; }
  }
  for (const key of ['session', 'harness-root', 'sdk-root', 'clm-root', 'receipt']) requireThat(options[key], `MISSING_${key}`);
  if (options.append) requireThat(options['confirm-exclusive-writer-stop'] && options['approved-receipt'], 'APPEND_REQUIRES_APPROVAL_AND_EXCLUSIVE_WRITER_STOP');
  return options;
}
async function loadState(manager, reconstruct) {
  const reader = manager.buildSessionEntryReader(), byId = new Map();
  for (let i = 0; i < reader.length; i++) byId.set(reader.getEntryHeader(i).id, i);
  const selected = [], seen = new Set(); let position = byId.get(reader.leafId);
  while (position !== undefined) {
    requireThat(!seen.has(position), 'BRANCH_CYCLE'); seen.add(position);
    const header = reader.getEntryHeader(position);
    if (header.type === 'custom' && header.customType === 'live-context-state') selected.push({ position, key: header.key });
    position = header.parentId === null ? undefined : byId.get(header.parentId);
  }
  const state = reconstruct((function* () { for (const item of selected) yield reader.read(item.position, item.key); })());
  reader.validate(); requireThat(state.enabled && state.checkpoint, 'NO_ENABLED_CHECKPOINT');
  return { state, reader };
}

export async function run(options) {
  if (options.append) requireThat(options['confirm-exclusive-writer-stop'] && options['approved-receipt'], 'APPEND_REQUIRES_APPROVAL_AND_EXCLUSIVE_WRITER_STOP');
  try { await lstat(options.receipt); throw Object.assign(new Error('RECEIPT_ALREADY_EXISTS'), { migrationCode: 'RECEIPT_ALREADY_EXISTS' }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const sessionPath = options.session, sdkRoot = options['sdk-root'], clmRoot = options['clm-root'], harnessRoot = options['harness-root'];
  const helperPath = fileURLToPath(import.meta.url), sdkFile = join(sdkRoot, 'dist/core/session-manager.js'), sdkPublic = join(sdkRoot, 'dist/programmatic.js'), hFile = join(harnessRoot, 'src/canonical-context.mjs');
  const bindings = {};
  for (const [key, path] of Object.entries({ helper: helperPath, harness: hFile, actorCoordinator: join(harnessRoot, 'src/actor-coordinator.mjs'), sdk: sdkFile, sdkPublic,
    clmState: join(clmRoot, 'src/state.ts'), clmProjection: join(clmRoot, 'src/projection.ts'),
    clmDocument: join(clmRoot, 'src/context-document.ts'), clmCheckpointStore: join(clmRoot, 'src/checkpoint-store.ts') })) bindings[key] = await hashFile(path);
  const req = createRequire(join(sdkRoot, 'package.json')); const { createJiti } = req('jiti');
  const jiti = createJiti(helperPath, { fsCache: false, moduleCache: false });
  const states = await jiti.import(join(clmRoot, 'src/state.ts'));
  const { canonicalMessage } = await jiti.import(join(clmRoot, 'src/context-document.ts'));
  const { createProjectionCheckpoint, applyProjection } = await jiti.import(join(clmRoot, 'src/projection.ts'));
  const { checkpointStoreDirectory } = await jiti.import(join(clmRoot, 'src/checkpoint-store.ts'));
  // The selected public entry is explicit even without inherited harness launch environment.
  process.env.PI_HARNESS_PI_MODULE = sdkPublic;
  delete process.env.PI_HARNESS_PI_COMMAND;
  const { SessionManager } = await import(pathToFileURL(sdkPublic));
  const { registerCanonicalSessionManager, projectCanonicalSource } = await import(pathToFileURL(hFile));
  const before = await identity(sessionPath), sourceHash = await hashFile(sessionPath);
  requireThat(unchanged(before, await identity(sessionPath)), 'SOURCE_CHANGED_DURING_INITIAL_HASH');
  const manager = SessionManager.open(sessionPath, undefined, undefined, { entryRetention: { maxCachedBytes: 256 * 1024 } });
  const { state, reader } = await loadState(manager, states.reconstructLiveContextStateNewestFirst);
  const source = { path: sessionPath, ...before, sha256: sourceHash, leafId: manager.getLeafId(), stateRevision: state.revision };
  registerCanonicalSessionManager(manager);
  const ordinaryProjection = projectCanonicalSource({ sessionManager: manager, mode: 'ordinary' });
  const nativeProjection = projectCanonicalSource({ sessionManager: manager, mode: 'native' });
  requireThat(!ordinaryProjection.diagnostics.some(x => x.severity === 'blocking') && !nativeProjection.diagnostics.some(x => x.severity === 'blocking'), 'BLOCKING_CANONICAL_DIAGNOSTIC');
  const relation = proveModeRelation({ ordinary: ordinaryProjection.source, native: nativeProjection.source, checkpoint: state.checkpoint, canonical: canonicalMessage });
  reader.validate(); requireThat(unchanged(before, await identity(sessionPath)), 'SOURCE_CHANGED_DURING_PROOF');
  const alreadyValid = relation.proof.nativePrefixValid;
  const candidate = createProjectionCheckpoint({ revision: state.revision + 1,
    sourceMessages: { length: nativeProjection.source.length, digest: () => relation.nativeDigest },
    projectedMessages: relation.projectedMessages, beforeEstimate: state.checkpoint.beforeEstimate,
    afterEstimate: state.checkpoint.afterEstimate, estimateUnit: state.checkpoint.estimateUnit });
  // Existing estimates are advisory and remain unchanged; this migration does not edit the effective request.
  const trial = applyProjection({ length: nativeProjection.source.length, digest: () => relation.nativeDigest,
    slice(start) { requireThat(start === nativeProjection.source.length, 'UNEXPECTED_RAW_HYDRATION'); return []; } }, candidate);
  requireThat(trial.valid && digestSequence(trial.messages, canonicalMessage) === relation.effectiveDigest, 'INVALID_PROPOSED_CHECKPOINT');
  const receipt = { schema: 1, ok: true, action: alreadyValid ? 'already-valid' : 'validate', source, bindings, proof: relation.proof,
    proposed: { revision: candidate.revision, sourceCount: candidate.sourceMessageCount, sourceDigest: candidate.sourceDigest,
      projectedCount: candidate.projectedMessages.length, effectiveDigest: relation.effectiveDigest },
    append: { attempted: false, performed: false, prefixPreserved: true, newCheckpointValid: alreadyValid } };
  if (!options.append && alreadyValid && options['approved-receipt']) {
    const approved = JSON.parse(await readFile(options['approved-receipt'], 'utf8'));
    requireThat(approved.schema === 1 && approved.ok && approved.proposed?.effectiveDigest === relation.effectiveDigest &&
      approved.proposed?.revision === state.revision && approved.proposed?.sourceDigest === state.checkpoint.sourceDigest, 'POST_APPEND_VERIFICATION_MISMATCH');
    requireThat(before.size > approved.source.size && await hashFile(sessionPath, approved.source.size) === approved.source.sha256, 'POST_APPEND_PREFIX_CHANGED');
    assert.deepEqual(approved.bindings, bindings, 'APPROVED_BINDINGS_CHANGED');
  }
  if (options.append && !alreadyValid) {
    const approved = JSON.parse(await readFile(options['approved-receipt'], 'utf8'));
    requireThat(approved.schema === 1 && approved.ok && approved.action === 'validate', 'INVALID_APPROVED_RECEIPT');
    assert.deepEqual(approved.source, source, 'APPROVED_SOURCE_CHANGED');
    assert.deepEqual(approved.bindings, bindings, 'APPROVED_BINDINGS_CHANGED');
    assert.deepEqual(approved.proof, receipt.proof, 'APPROVED_PROOF_CHANGED');
    assert.deepEqual(approved.proposed, receipt.proposed, 'APPROVED_CANDIDATE_CHANGED');
    const at = new Date().toISOString();
    const nextState = { version: 1, enabled: state.enabled, revision: candidate.revision, checkpoint: candidate,
      ...(state.event ? { event: state.event } : {}),
      lastOutcome: { kind: 'applied', message: `Migrated projection revision ${state.revision} from ordinary replay order to native canonical order without changing the effective message sequence.`, at,
        beforeEstimate: candidate.beforeEstimate, afterEstimate: candidate.afterEstimate, estimateUnit: candidate.estimateUnit } };
    const persisted = states.toPersistedEntry(nextState, checkpointStoreDirectory(sessionPath));
    // Failed optional storage must not silently produce a new large inline checkpoint in this repair.
    requireThat(persisted.checkpoint?.projectedMessageStore, 'CHECKPOINT_STORAGE_NOT_EXTERNALIZED');
    nativeProjection.source.validate(); reader.validate();
    requireThat(unchanged(before, await identity(sessionPath)) && await hashFile(sessionPath) === sourceHash, 'SOURCE_CHANGED_BEFORE_APPEND');
    requireThat(manager.getLeafId() === source.leafId, 'LEAF_CHANGED_BEFORE_APPEND');
    receipt.append.intentPath = options.receipt + '.intent.json';
    await publishJson(receipt.append.intentPath, { schema: 1, phase: 'before-append', source, bindings, proof: receipt.proof, proposed: receipt.proposed });
    receipt.append.attempted = true; receipt.append.performed = null;
    try {
    const entryId = manager.appendCustomEntry(states.LIVE_CONTEXT_STATE, persisted);
    receipt.action = 'migrate'; receipt.append.performed = true; receipt.append.entryId = entryId;
    const after = await identity(sessionPath);
    receipt.append.prefixPreserved = after.dev === before.dev && after.ino === before.ino && after.size > before.size && await hashFile(sessionPath, before.size) === sourceHash;
    requireThat(receipt.append.prefixPreserved, 'APPEND_PREFIX_CHANGED');
    const entry = manager.getEntry(entryId);
    requireThat(entry?.type === 'custom' && entry.customType === states.LIVE_CONTEXT_STATE && entry.parentId === source.leafId, 'APPENDED_ENTRY_MISMATCH');
    const restored = states.readLiveContextState(entry.data);
    requireThat(restored?.revision === candidate.revision && restored.checkpoint?.sourceDigest === relation.nativeDigest &&
      digestSequence(restored.checkpoint.projectedMessages, canonicalMessage) === relation.effectiveDigest, 'APPENDED_CHECKPOINT_MISMATCH');
    receipt.append.newLeaf = manager.getLeafId(); receipt.append.newRevision = restored.revision;
    receipt.append.newCheckpointValid = true; receipt.append.newSize = after.size;
    } catch (error) { error.appendOutcome = receipt.append; throw error; }
  }
  try { await publishJson(options.receipt, receipt); }
  catch (error) { error.appendOutcome = receipt.append; throw error; }
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await run(parseArgs(process.argv.slice(2))); console.log(JSON.stringify(result)); }
  catch (error) { console.error(JSON.stringify({ schema: 1, ok: false, error: error.migrationCode ?? (['ERR_ASSERTION', 'ENOENT', 'EACCES', 'EEXIST', 'ERR_MODULE_NOT_FOUND'].includes(error.code) ? error.code : 'MIGRATION_FAILED'), ...(error.appendOutcome ? { append: error.appendOutcome, reconcileBeforeRetry: error.appendOutcome.performed !== false } : {}) })); process.exitCode = 1; }
}
