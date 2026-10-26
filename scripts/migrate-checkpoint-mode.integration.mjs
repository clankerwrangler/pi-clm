// Run explicitly with --sdk-root, --harness-root, --clm-root, and --scratch-dir.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run } from './migrate-checkpoint-mode.mjs';
const options={};for(let i=2;i<process.argv.length;i+=2)options[process.argv[i].slice(2)]=process.argv[i+1];
for(const key of ['sdk-root','harness-root','clm-root','scratch-dir'])assert.ok(options[key],`Missing --${key}`);
const {SessionManager}=await import(pathToFileURL(join(options['sdk-root'],'dist/programmatic.js')));
const {registerCanonicalSessionManager,projectCanonicalSource}=await import(pathToFileURL(join(options['harness-root'],'src/canonical-context.mjs')));
const {createJiti}=createRequire(join(options['sdk-root'],'package.json'))('jiti');
const jiti=createJiti(import.meta.url,{fsCache:false,moduleCache:false});
const {createProjectionCheckpoint}=await jiti.import(join(options['clm-root'],'src/projection.ts'));
const {digestMessages}=await jiti.import(join(options['clm-root'],'src/context-document.ts'));
const dir=await mkdtemp(join(options['scratch-dir'],'mode-migration-test-'));
try{
 const m=SessionManager.create(dir,dir,{entryRetention:{maxCachedBytes:256*1024}});
 const usage={input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
 const u=content=>({role:'user',content,timestamp:1});
 const a={role:'assistant',id:'assistant',content:[{type:'toolCall',id:'call',name:'python',arguments:{code:'public_fixture=1'},async:true,
  providerCallId:'call',providerItemId:'item_call',nativeProvenance:{responseId:'response',itemId:'item_call',callId:'call'}}],
  timestamp:2,api:'openai-codex-responses',provider:'openai-codex',model:'public-fixture',stopReason:'toolUse',usage};
 const r={role:'toolResult',toolCallId:'call',toolName:'python',content:[{type:'text',text:'public complete'}],details:{public:true},timestamp:3,isError:false};
 for(const message of [u('task'),a,u('intervening user'),r,u('last prefix')])m.appendMessage(message);
 registerCanonicalSessionManager(m);const ordinary=projectCanonicalSource({sessionManager:m,mode:'ordinary'}).source;
 const ordinaryValues=ordinary.readAll();const cp=createProjectionCheckpoint({revision:7,sourceMessages:ordinaryValues,projectedMessages:[u('accepted summary')],beforeEstimate:100,afterEstimate:10});
 m.appendCustomEntry('live-context-state',{version:1,enabled:true,revision:7,checkpoint:cp});m.appendMessage(u('suffix'));
 const session=m.getSessionFile();const before=await readFile(session);
 const base={...options,session};delete base['scratch-dir'];
 const dry=await run({...base,receipt:join(dir,'dry.json')});assert.equal(dry.action,'validate');assert.equal(dry.proof.suffixSameOrdered,true);assert.equal(dry.append.performed,false);
 assert.deepEqual(await readFile(session),before);
 await assert.rejects(run({...base,append:true,receipt:join(dir,'missing-stop.json')}),/APPEND_REQUIRES_APPROVAL_AND_EXCLUSIVE_WRITER_STOP/);
 await assert.rejects(run({...base,append:true,'confirm-exclusive-writer-stop':true,'approved-receipt':join(dir,'dry.json'),receipt:join(dir,'dry.json')}),/RECEIPT_ALREADY_EXISTS/);assert.deepEqual(await readFile(session),before);
 const applied=await run({...base,append:true,'confirm-exclusive-writer-stop':true,'approved-receipt':join(dir,'dry.json'),receipt:join(dir,'append.json')});
 assert.equal(applied.action,'migrate');assert.equal(applied.append.newRevision,8);assert.equal(applied.append.prefixPreserved,true);assert.equal(applied.append.newCheckpointValid,true);
 const after=await readFile(session);assert.deepEqual(after.subarray(0,before.length),before);
 const verifyArgv = [fileURLToPath(new URL('./migrate-checkpoint-mode.mjs', import.meta.url))];
 for (const [key,value] of Object.entries({...base,'approved-receipt':join(dir,'dry.json'),receipt:join(dir,'verify.json')})) verifyArgv.push(`--${key}`,value);
 const cleanEnv={...process.env};delete cleanEnv.PI_HARNESS_PI_MODULE;delete cleanEnv.PI_HARNESS_PI_COMMAND;
 const verify=JSON.parse(execFileSync(process.execPath,verifyArgv,{encoding:'utf8',timeout:30000,env:cleanEnv}));assert.equal(verify.action,'already-valid');assert.equal(verify.proof.nativePrefixValid,true);
 assert.equal(verify.proposed.effectiveDigest,dry.proposed.effectiveDigest);
 const repeat=await run({...base,append:true,'confirm-exclusive-writer-stop':true,'approved-receipt':join(dir,'dry.json'),receipt:join(dir,'repeat.json')});
 assert.equal(repeat.action,'already-valid');assert.equal(repeat.append.performed,false);assert.deepEqual(await readFile(session),after);
 const faultSession=join(dir,'fault.jsonl'), faultReceipt=join(dir,'fault-receipt.json');await writeFile(faultSession,before);
 const faultBase={...base,session:faultSession};await run({...faultBase,receipt:join(dir,'fault-dry.json')});
 const appendOriginal=SessionManager.prototype.appendCustomEntry;
 SessionManager.prototype.appendCustomEntry=function(...args){const id=appendOriginal.apply(this,args);if(this.getSessionFile()===faultSession)mkdirSync(faultReceipt);return id;};
 try{await assert.rejects(run({...faultBase,append:true,'confirm-exclusive-writer-stop':true,'approved-receipt':join(dir,'fault-dry.json'),receipt:faultReceipt}),error=>{assert.equal(error.appendOutcome.performed,true);assert.equal(error.appendOutcome.attempted,true);return true;});}
 finally{SessionManager.prototype.appendCustomEntry=appendOriginal;}
 const intent=JSON.parse(await readFile(faultReceipt+'.intent.json','utf8'));assert.equal(intent.phase,'before-append');
 const reconcile=await run({...faultBase,'approved-receipt':join(dir,'fault-dry.json'),receipt:join(dir,'reconcile.json')});assert.equal(reconcile.action,'already-valid');assert.equal(reconcile.append.performed,false);
 console.log(JSON.stringify({ok:true,test:'actual SDK/H/CLM migration append, fresh verification and append retry no-op',oldRevision:7,newRevision:8,prefixPreserved:true,effectiveSequenceUnchanged:true}));
}finally{await rm(dir,{recursive:true,force:true});}
