import {readFileSync,lstatSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {stableHash} from '../../utils/stableHash.js';
import {toolReceipt} from './toolReceipt.js';
import {artifactHash} from './semanticGate.js';

export function semanticCandidate(root=fileURLToPath(new URL('../../../',import.meta.url))){
 const paths=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z','backend','frontend','integrations','.github'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
 const files={};
 for(const path of [...new Set(paths)].sort()){
  if(/(^|\/)(node_modules|data|logs)(\/|$)/.test(path)||/(^|\/)\.env($|\.)/.test(path)&&!path.endsWith('.example')||! /\.(js|cjs|json|sql|html|css|yml|yaml)$/.test(path))continue;
  const file=resolve(root,path);if(lstatSync(file).isSymbolicLink())throw Error('Source symlink is not a campaign artifact');
  files[path]=createHash('sha256').update(readFileSync(file)).digest('hex');
 }
 return {candidateHash:stableHash(files),files};
}

// Read only by primary-key identity, then close promptly. This is an exporter,
// never a second business writer or a way to resume historical inference.
export async function archiveSemanticCase({selected,run,candidateHash,modelManifestHash,databasePath,request,opencode}){
 const db=new Database(databasePath,{readonly:true,fileMustExist:true,timeout:1000});let rows;
 try{
  db.pragma('query_only=ON');
  const job=db.prepare('SELECT snapshot_id,session_id,model,prompt_version,status FROM agent_jobs WHERE job_id=?').get(run.jobId);
  if(!job||job.snapshot_id!==run.snapshotId||job.session_id!==run.sessionId||job.model!==run.model||job.prompt_version!==run.promptVersion||job.status!==run.status)throw Error('Database and owned execution disagree');
  rows=db.prepare('SELECT run_id,fence,status,started_at,finished_at,metadata_json FROM agent_runs WHERE job_id=? ORDER BY fence LIMIT 4').all(run.jobId);
 }finally{db.close();}
 if(rows.length>3)throw Error('Unexpected attempt count');
 const attempts=[];
 for(const row of rows){
  const {metadata_json,...identity}=row,metadata=JSON.parse(metadata_json),g=metadata.generation;
  const messages=g?await opencode.messages(g.sessionId,undefined,g.messageId):{data:[]};
  messages.data=messages.data.map(message=>({...message,content:(message.content||[]).filter(part=>part.type!=='reasoning')}));
  const receipts=messages.data.flatMap(m=>(m.content||[]).filter(p=>p.type==='tool').map(p=>toolReceipt(p.state?.output||p.state?.content||p.state?.error?.message)).filter(Boolean));
  attempts.push({...identity,metadata,messages,receipts});
 }
 const wanted=new Set(run.publication?.proposal?.evidenceIds||[]);
 for(const a of attempts)for(const r of a.receipts)for(const id of r.evidenceIds||[])wanted.add(id);
 let cursor,snapshot;const evidence=[],seen=new Set();let materialBytes=0;
 do{
  const page=await request('/api/agent/v1/evidence?'+new URLSearchParams({snapshotId:run.snapshotId,limit:'20',...(cursor?{cursor}:{} )}));
  snapshot||={snapshotId:page.snapshotId,asOf:page.asOf,coverage:page.coverage};
  for(let item of page.items||[]){
   if(!wanted.has(item.evidenceId))continue;
   if(item.representation==='chunked'||!item.data){
    let offset=0,body='',digest;
    for(;;){
     const chunk=await request('/api/agent/v1/evidence/chunk?'+new URLSearchParams({snapshotId:run.snapshotId,evidenceId:item.evidenceId,offset:String(offset),format:'utf8'}));
     if(chunk.snapshotId!==run.snapshotId||chunk.evidenceId!==item.evidenceId||digest&&digest!==chunk.sha256||chunk.nextOffset<=offset&&chunk.hasMore)throw Error('Invalid frozen chunk continuation');
     digest=chunk.sha256;body+=chunk.chunk;if(Buffer.byteLength(body)>2097152)throw Error('Frozen evidence exceeds the existing snapshot budget');
     if(!chunk.hasMore)break;offset=chunk.nextOffset;
    }
    if(createHash('sha256').update(body).digest('hex')!==digest)throw Error('Frozen chunk hash mismatch');
    item=JSON.parse(body);
   }
   materialBytes+=Buffer.byteLength(JSON.stringify(item));if(materialBytes>2097152)throw Error('Review material exceeds the existing snapshot budget');
   evidence.push(item);
  }
  if(!page.hasMore)break;
  if(!page.nextCursor||seen.has(page.nextCursor))throw Error('Repeated evidence cursor');seen.add(page.nextCursor);cursor=page.nextCursor;
 }while(true);
 if([...wanted].some(id=>!evidence.some(e=>e.evidenceId===id)))throw Error('Consulted evidence is absent from the frozen snapshot');
 const artifact={version:'ogid-semantic-artifact-v2',caseId:selected.id,family:selected.family,variant:selected.variant||null,scenario:selected.scenario,selectionRationale:selected.evidenceSelectionRationale,candidateHash,modelManifestHash,collectedAt:new Date().toISOString(),run,snapshot,evidence,attempts};
 return {...artifact,contentHash:artifactHash(artifact)};
}
