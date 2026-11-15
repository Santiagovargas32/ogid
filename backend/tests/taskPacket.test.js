import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareTaskPacket} from '../services/agent/taskPacket.js';
import {stableHash} from '../utils/stableHash.js';
import {PROMPT_VERSION} from '../services/agent/contracts.js';
const snapshot={snapshotId:'snapshot:task',asOf:'2026-11-15T17:00:00Z',coverage:{sealed:true,evidenceCount:5}};
const evidence=['coverage','news','news','technical.get','geopolitical-alert'].map((domain,i)=>({evidenceId:domain+':'+i,domain,data:{title:'Relato '+i}}));
const receipt=e=>({complete:true,snapshotId:snapshot.snapshotId,evidenceHash:stableHash(e)});
const job={task:'global_intelligence_brief',model:'llamacpp/gpt-oss-20b',scope:'global',promptVersion:PROMPT_VERSION};
test('task packets preserve all selected domain rows and the unchanged source coverage',()=>{
 const {prepared,selection}=prepareTaskPacket({job,snapshot,evidence,collectionReceipt:receipt(evidence)});
 assert.equal(prepared.input.evidence.length,3);assert.equal(prepared.input.snapshot.coverage.evidenceCount,5);
 assert.deepEqual(selection.excludedDomains,['geopolitical-alert','technical.get']);assert.equal(selection.deliveredEvidenceHash,stableHash(evidence.slice(0,3)));
 assert.deepEqual(prepared.input.evidence,evidence.slice(0,3));assert.equal(selection.sourceEvidenceCount,5);
});
test('unsealed collection, changed packet, missing coverage and foreign identity fail closed',()=>{
 for(const collectionReceipt of [undefined,{...receipt(evidence),complete:false},{...receipt(evidence),snapshotId:'foreign'},{...receipt(evidence),evidenceHash:'0'.repeat(64)}])assert.throws(()=>prepareTaskPacket({job,snapshot,evidence,collectionReceipt}),{code:'AGENT_DIRECT_COLLECTION_REQUIRED'});
 const missing=evidence.slice(1);assert.throws(()=>prepareTaskPacket({job,snapshot,evidence:missing,collectionReceipt:receipt(missing)}),{code:'AGENT_DIRECT_COVERAGE_REQUIRED'});
});
test('alert context selects complete alerts, and families retain their supporting source domains',()=>{
 const alert=prepareTaskPacket({job:{...job,input:{context:{alertId:'a'}}},snapshot,evidence,collectionReceipt:receipt(evidence)});
 assert.deepEqual(alert.prepared.input.evidence.map(e=>e.domain),['coverage','geopolitical-alert']);
 for(const task of ['instrument_outlook','market_outlook_global','geopolitical_alert_assessment','situation_analysis']){
 const {selection}=prepareTaskPacket({job:{...job,task},snapshot,evidence,collectionReceipt:receipt(evidence)});
 assert.ok(selection.domains.includes('coverage'));assert.equal(selection.deliveredEvidenceCount,2);
 }
});

test('selected collections must cover exactly the declared task domains',()=>{
 const args={job,snapshot,evidence,collectionReceipt:{...receipt(evidence),materialization:'selected-domains',domains:['coverage']}};
 assert.throws(()=>prepareTaskPacket(args),{code:'AGENT_DIRECT_COLLECTION_REQUIRED'});
});
