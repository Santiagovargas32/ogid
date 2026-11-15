import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentRepository} from '../storage/agentRepository.js';
import {collectFrozenPacket} from '../services/agent/frozenPacket.js';
import {PROMPT_VERSION} from '../services/agent/contracts.js';
import {stableHash} from '../utils/stableHash.js';
const asOf='2026-11-15T19:00:00.000Z';
const job={task:'global_intelligence_brief',scope:'global',model:'llamacpp/gpt-oss-20b',promptVersion:PROMPT_VERSION};
const item=(id,data={title:'Fuente congelada'})=>({evidenceId:id,domain:id.startsWith('coverage')?'coverage':'news',revision:1,availableAt:asOf,quality:{},publicationEligibility:{eligible:true},data});
const snapshot=count=>({schemaVersion:'ogid-evidence-v1',revision:1,snapshotId:'frozen:fixture',scope:'global',asOf,coverage:{sealed:true,sha256:'a'.repeat(64),evidenceCount:count}});
const page=(s,items,hasMore=false,nextCursor=null)=>({...s,queriedAt:new Date().toISOString(),items,hasMore,nextCursor});
const descriptor=body=>({evidenceId:body.evidenceId,domain:body.domain,representation:'chunked',bytes:Buffer.byteLength(JSON.stringify(body)),sha256:createHash('sha256').update(JSON.stringify(body)).digest('hex')});
function chunks(body,mutate=value=>value){
 const b=Buffer.from(JSON.stringify(body)),d=descriptor(body);
 return ({snapshotId,evidenceId,offset,format})=>{assert.equal(format,'base64');const end=Math.min(offset+16384,b.length);return mutate({snapshotId,evidenceId,encoding:'base64',bytes:b.length,sha256:d.sha256,chunk:b.subarray(offset,end).toString('base64'),nextOffset:end,hasMore:end<b.length},offset);};
}

test('all pages and domains are delivered, with a detached frozen package and verifiable completeness receipt',async()=>{
 const s=snapshot(3),records=[item('news:one'),item('technical:one',{instrumentId:'NVDA'}),item('coverage:one',[])],calls=[];
 const result=await collectFrozenPacket({job,snapshot:s,call:async(method,args)=>{calls.push({method,args});assert.equal(method,'evidence');assert.equal(args.domain,undefined);return args.cursor==='0'?page(s,records.slice(0,2),true,'42'):page(s,records.slice(2));}});
 assert.equal(result.receipt.complete,true);assert.equal(result.receipt.pages,2);assert.equal(result.receipt.evidenceCount,3);assert.equal(result.receipt.chunks,0);
 assert.deepEqual(result.prepared.input.evidence,records);assert.equal(result.receipt.evidenceHash,stableHash(records));
 assert.equal(result.receipt.inputHash,result.prepared.identity.inputHash);assert.equal(result.receipt.sourceSealVerification,'manifest-consistency-only');
 records[0].data.title='changed';assert.equal(result.prepared.input.evidence[0].data.title,'Fuente congelada');
 assert.equal(calls[1].args.cursor,'42');assert.equal(Object.isFrozen(result.prepared.input.evidence),true);
});

test('base64 chunks preserve Unicode across byte boundaries and bind the complete body to its descriptor',async()=>{
 const s=snapshot(1),record=item('news:unicode',{title:'é🦊'.repeat(7000)}),stub=descriptor(record),read=chunks(record);
 const result=await collectFrozenPacket({job,snapshot:s,call:async(method,args)=>method==='evidence'?page(s,[stub]):read(args)});
 assert.equal(result.prepared.input.evidence[0].data.title,record.data.title);assert.ok(result.receipt.chunks>1);
 assert.equal(result.receipt.evidenceBytes,2+stub.bytes);assert.equal(result.receipt.sourceSeal,s.coverage.sha256);
});

test('metadata drift, foreign snapshots, duplicate IDs, incomplete counts and nonprogressing cursors fail closed',async()=>{
 for(const broken of [
  s=>({...page(s,[item('news:one')]),snapshotId:'foreign'}),
  s=>({...page(s,[item('news:one')]),asOf:'2026-11-16T00:00:00Z'}),
  s=>({...page(s,[item('news:one')]),coverage:{...s.coverage,sha256:'b'.repeat(64)}}),
  s=>page(s,[item('news:one'),item('news:one')]),
  s=>page(s,[]),
  s=>page(s,[item('news:one')],true,'0'),
  s=>page(s,[item('news:one')],true,'-1'),
  s=>page(s,[],true,'7'),
  s=>({...page(s,[item('news:one')]),nextCursor:'7'}),
  s=>page(s,[{...item('news:one'),snapshotId:'foreign'}])
 ])await assert.rejects(collectFrozenPacket({job,snapshot:snapshot(1),call:async()=>broken(snapshot(1))}),{code:'AGENT_FROZEN_PACKET_INVALID'});
 const s=snapshot(2);await assert.rejects(collectFrozenPacket({job,snapshot:s,call:async(_method,args)=>page(s,[item('news:one')],true,args.cursor==='0'?'10':'9')}),{code:'AGENT_FROZEN_PACKET_INVALID'});
});

test('chunks reject corrupted bytes, invalid encoding, wrong identities, lengths, hashes and descriptor/body disagreement',async()=>{
 const record=item('news:one',{title:'é'.repeat(11000)}),stub=descriptor(record),s=snapshot(1);
 const mutations=[
  p=>({...p,chunk:p.chunk.slice(0,-1)+'!'}),p=>({...p,encoding:'utf8'}),p=>({...p,snapshotId:'foreign'}),
  p=>({...p,evidenceId:'news:another'}),p=>({...p,bytes:p.bytes+1}),p=>({...p,sha256:'b'.repeat(64)}),
  p=>({...p,nextOffset:p.nextOffset-1}),p=>({...p,hasMore:false}),
  p=>({...p,chunk:Buffer.from('x'.repeat(Buffer.from(p.chunk,'base64').length)).toString('base64')})
 ];
 for(const mutate of mutations){const read=chunks(record,mutate);await assert.rejects(collectFrozenPacket({job,snapshot:s,call:async(method,args)=>method==='evidence'?page(s,[stub]):read(args)}),{code:'AGENT_FROZEN_PACKET_INVALID'});}
 const changed={...stub,domain:'coverage'};await assert.rejects(collectFrozenPacket({job,snapshot:s,call:async(method,args)=>method==='evidence'?page(s,[changed]):chunks(record)(args)}),{code:'AGENT_FROZEN_PACKET_INVALID'});
});

test('pressure and cancellation propagate without retries or an incomplete success receipt',async()=>{
 const s=snapshot(2),pressure=Object.assign(Error('pressure'),{code:'STORAGE_RESOURCE_PRESSURE'});let calls=0;
 await assert.rejects(collectFrozenPacket({job,snapshot:s,call:async()=>{if(++calls===1)return page(s,[item('news:one')],true,'1');throw pressure;}}),error=>error===pressure);assert.equal(calls,2);
 const controller=new AbortController();calls=0;
 await assert.rejects(collectFrozenPacket({job,snapshot:s,signal:controller.signal,call:async()=>{calls++;controller.abort();return page(s,[item('news:one')],true,'1');}}),{name:'AbortError'});assert.equal(calls,1);
 controller.abort();await assert.rejects(collectFrozenPacket({job,snapshot:s,signal:controller.signal,call:async()=>{calls++;}}),{name:'AbortError'});assert.equal(calls,1);
});

test('the complete package budget includes snapshot and job metadata; oversized data is never truncated',async()=>{
 const s=snapshot(1),record=item('news:one',{title:'x'.repeat(1000)});
 await assert.rejects(collectFrozenPacket({job,snapshot:s,maxBytes:200,call:async()=>page(s,[record])}),{code:'AGENT_DIRECT_EVIDENCE_TOO_LARGE'});
 const small=item('news:tiny');await assert.rejects(collectFrozenPacket({job,snapshot:s,maxBytes:Buffer.byteLength(JSON.stringify(small))+2,call:async()=>page(s,[small])}),{code:'AGENT_DIRECT_EVIDENCE_TOO_LARGE'});
 let chunksRead=0;const stub=descriptor(record);
 await assert.rejects(collectFrozenPacket({job,snapshot:s,maxBytes:200,call:async(method)=>{if(method==='evidence')return page(s,[stub]);chunksRead++;}}),{code:'AGENT_DIRECT_EVIDENCE_TOO_LARGE'});assert.equal(chunksRead,0);
});

test('partial or invalid seals are rejected while legacy manifests remain explicitly unsealed',async()=>{
 for(const coverage of [{sealed:false,sha256:'a'.repeat(64)},{sealed:true},{sealed:true,sha256:'not-a-hash'},{evidenceCount:-1}])await assert.rejects(collectFrozenPacket({job,snapshot:{...snapshot(1),coverage},call:async()=>{throw Error('must not read');}}),{code:'AGENT_FROZEN_PACKET_INVALID'});
 const s={...snapshot(1),coverage:{evidenceCount:1}};
 const result=await collectFrozenPacket({job,snapshot:s,call:async()=>page(s,[item('news:one')])});assert.equal(result.receipt.sourceSeal,null);assert.equal(result.receipt.sourceSealVerification,'not-present');
});


test('the current repository API yields the complete readonly SQLite snapshot including byte-exact large coverage',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'ogid-frozen-packet-')),path=join(directory,'fixture.sqlite');let db;
 try{
  db=new Database(path);
  db.exec('CREATE TABLE agent_snapshots(snapshot_id PRIMARY KEY,as_of,scope,manifest_json); CREATE TABLE agent_evidence(sequence INTEGER PRIMARY KEY,snapshot_id,evidence_id,domain,available_at,article_id,article_revision,payload_json); CREATE INDEX agent_evidence_page ON agent_evidence(snapshot_id,sequence);');
  const s=snapshot(26),large=['é🦊'.repeat(7000)];
  db.prepare('INSERT INTO agent_snapshots VALUES(?,?,?,?)').run(s.snapshotId,s.asOf,s.scope,JSON.stringify(s.coverage));
  const insert=db.prepare('INSERT INTO agent_evidence(snapshot_id,evidence_id,domain,available_at,payload_json) VALUES(?,?,?,?,?)');
  for(let n=0;n<25;n++)insert.run(s.snapshotId,'alert:'+n,'geopolitical-alert',asOf,JSON.stringify({title:'Fuente '+n}));
  insert.run(s.snapshotId,'coverage:large','coverage',asOf,JSON.stringify(large));db.close();
  db=new Database(path,{readonly:true,fileMustExist:true});db.pragma('query_only=ON');
  const repository=new AgentRepository({db}),captured=repository.snapshotInfo(s.snapshotId);
  const result=await collectFrozenPacket({job,snapshot:captured,call:async(method,args)=>repository.call(method,args)});
  assert.equal(result.receipt.evidenceCount,26);assert.equal(result.receipt.pages,2);assert.ok(result.receipt.chunks>1);
  assert.deepEqual(result.prepared.input.evidence.at(-1).data,large);assert.equal(db.pragma('query_only',{simple:true}),1);
  assert.equal(db.prepare('SELECT count(*) AS count FROM agent_evidence').get().count,26);
 }finally{db?.close();rmSync(directory,{recursive:true,force:true});}
});

test('explicit domains enumerate every source row while materializing only all selected domains',async()=>{
 const s=snapshot(3),chosen=item('news:chosen'),excluded=item('technical:large',{text:'é'.repeat(1100000)}),stub={...descriptor(excluded),domain:'technical.get'},coverage=item('coverage:one',[]);let chunksRead=0;
 const result=await collectFrozenPacket({job,snapshot:s,domains:['coverage','news'],call:async(method,args)=>{
  assert.equal(args.domain,undefined);
  if(method==='evidenceChunk'){chunksRead++;throw Error('Excluded body is corrupt; it must not be read or claimed verified');}
  return args.cursor==='0'?page(s,[chosen,stub],true,'10'):page(s,[coverage]);
 }});
 assert.equal(chunksRead,0);assert.deepEqual(result.prepared.input.evidence,[chosen,coverage]);
 assert.equal(result.receipt.enumerationComplete,true);assert.equal(result.receipt.sourceEvidenceCount,3);assert.equal(result.receipt.evidenceCount,2);
 assert.equal(result.receipt.complete,true);assert.equal(result.receipt.materialization,'selected-domains');assert.equal(result.receipt.completeness,'all-items-of-selected-domains');
 assert.equal(result.receipt.excludedBodyVerification,'not-performed');assert.deepEqual(result.receipt.domains,['coverage','news']);
 assert.equal(result.receipt.evidenceHash,stableHash([chosen,coverage]));assert.match(result.receipt.sourceInventoryHash,/^[a-f0-9]{64}$/);
});

test('selected chunks must be complete and authentic, even when unselected bodies are not materialized',async()=>{
 const chosen=item('news:chosen',{title:'é'.repeat(10000)}),excluded={...descriptor(item('technical:omitted')),domain:'technical.get'},s=snapshot(2),read=chunks(chosen,p=>({...p,nextOffset:p.nextOffset-1}));let calls=0;
 await assert.rejects(collectFrozenPacket({job,snapshot:s,domains:['news'],call:async(method,args)=>{calls++;return method==='evidence'?page(s,[excluded,descriptor(chosen)]):read(args);}}),{code:'AGENT_FROZEN_PACKET_INVALID'});
 assert.equal(calls,2);
});

test('domain selection cannot conceal enumeration drift, duplicate excluded IDs or a missing source row',async()=>{
 const s=snapshot(3),chosen=item('news:chosen'),excluded={...descriptor(item('technical:omitted')),domain:'technical.get'};
 for(const second of [
  page(s,[excluded]),
  page(s,[]),
  {...page(s,[{...excluded,evidenceId:'technical:other'}]),coverage:{...s.coverage,sha256:'b'.repeat(64)}}
 ])await assert.rejects(collectFrozenPacket({job,snapshot:s,domains:['news'],call:async(_method,args)=>args.cursor==='0'?page(s,[chosen,excluded],true,'20'):second}),{code:'AGENT_FROZEN_PACKET_INVALID'});
 for(const domains of [[],['news','news'],[''],[null]])await assert.rejects(collectFrozenPacket({job,snapshot:s,domains,call:async()=>{throw Error('Invalid domains must fail before reading');}}),{code:'AGENT_FROZEN_PACKET_INVALID'});
});

test('volatile observation time cannot change immutable generation identity',async()=>{
 const s=snapshot(1),row=item('news:one'),call=async()=>page(s,[row]);
 const one=await collectFrozenPacket({job,snapshot:{...s,queriedAt:'2026-11-15T18:00:00Z'},call});
 const two=await collectFrozenPacket({job,snapshot:{...s,queriedAt:'2026-11-15T19:00:00Z'},call});
 assert.equal(one.prepared.key,two.prepared.key);assert.equal(one.prepared.input.snapshot.queriedAt,undefined);
});
