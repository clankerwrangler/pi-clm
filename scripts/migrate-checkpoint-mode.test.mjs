import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { proveModeRelation } from './migrate-checkpoint-mode.mjs';
const canonical = value => JSON.stringify(value);
const digest = values => { const h = createHash('sha256'); for (const value of values) h.update(canonical(value)).update('\n'); return h.digest('hex'); };
const user = (id, content=id) => ({ id, role: 'user', content });
const u=user('task'), call={id:'call',role:'assistant',content:[{type:'toolCall',id:'c',name:'python',async:true,arguments:{}}]},
  between=user('between'), result={id:'result',role:'toolResult',toolCallId:'c',content:'complete'}, end=user('end'), suffix=user('suffix');
const nativeValues=[u,call,between,result,end,suffix], ordinaryValues=[u,call,result,between,end,suffix];
const source=(values,mode) => ({length:values.length,contributions:values.map(m=>({key:`${m.id}:${mode}:${'a'.repeat(64)}:[]`,role:m.role})),read:i=>structuredClone(values[i]),validate(){}});
const fixture=(count=5) => ({ordinary:source(ordinaryValues,'ordinary'),native:source(nativeValues,'native'),
  checkpoint:{sourceMessageCount:count,sourceDigest:digest(ordinaryValues.slice(0,count)),projectedMessages:[user('summary')]},canonical});
test('only known async-result relocation migrates a verified prefix without changing the effective sequence',()=>{
 const proof=proveModeRelation(fixture());
 assert.equal(proof.proof.ordinaryPrefixValid,true);assert.equal(proof.proof.nativePrefixValid,false);
 assert.equal(proof.proof.changedOrder,2);assert.equal(proof.proof.boundaryCrossings,0);assert.equal(proof.proof.suffixSameOrdered,true);
 assert.deepEqual(proof.projectedMessages,[user('summary'),suffix]);assert.equal(proof.nativeDigest,digest(nativeValues));
});
test('current native checkpoint is recognized without a second migration',()=>{
 const f=fixture();f.checkpoint={sourceMessageCount:6,sourceDigest:digest(nativeValues),projectedMessages:[user('summary'),suffix]};
 const proof=proveModeRelation(f);assert.equal(proof.proof.nativePrefixValid,true);assert.deepEqual(proof.projectedMessages,f.checkpoint.projectedMessages);
});
test('different content under the same source identity rejects',()=>{
 const f=fixture();f.native=source([...nativeValues.slice(0,5),user('suffix','changed')],'native');
 assert.throws(()=>proveModeRelation(f),/SOURCE_MESSAGE_CHANGED/);
});
test('movement across the checkpoint frontier rejects',()=>assert.throws(()=>proveModeRelation(fixture(3)),/CHECKPOINT_BOUNDARY_CROSSED/));
test('suffix reordering rejects even when its full-value multiset is unchanged',()=>{
 const f=fixture(2);assert.throws(()=>proveModeRelation(f),/SUFFIX_ORDER_CHANGED/);
});
test('unrelated prefix reorder rejects',()=>{
 const f=fixture();f.native=source([between,call,u,result,end,suffix],'native');assert.throws(()=>proveModeRelation(f),/UNSUPPORTED_MODE_REORDER/);
});
test('checkpoint matching neither exact source rejects',()=>{
 const f=fixture();f.checkpoint.sourceDigest='0'.repeat(64);assert.throws(()=>proveModeRelation(f),/CHECKPOINT_MATCHES_NEITHER_MODE/);
});
test('missing contribution and duplicate identity reject',()=>{
 let f=fixture();f.native=source(nativeValues.slice(1),'native');assert.throws(()=>proveModeRelation(f),/MODE_LENGTH_CHANGED/);
 f=fixture();f.native=source([u,call,between,result,end,end],'native');assert.throws(()=>proveModeRelation(f),/DUPLICATE_SOURCE_IDENTITY/);
});
