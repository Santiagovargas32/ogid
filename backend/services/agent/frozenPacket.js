import {createHash} from 'node:crypto';
import {AGENT_POLICY} from './config.js';
import {agentError} from './contracts.js';
import {prepareDirectGeneration} from './directGeneration.js';
import {stableHash} from '../../utils/stableHash.js';

const VERSION='ogid-frozen-packet-v1';
const digest=value=>createHash('sha256').update(value).digest('hex');
const isHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const invalid=()=>{throw agentError('AGENT_FROZEN_PACKET_INVALID');};
const tooLarge=()=>{throw agentError('AGENT_DIRECT_EVIDENCE_TOO_LARGE',413);};
const clone=value=>JSON.parse(JSON.stringify(value));

// Enumerates the complete existing snapshot without an API domain filter.
// Optional domains materialize every member of those domains; excluded chunk
// bodies are not read or claimed verified. No live corpus, inference or writes.
export async function collectFrozenPacket({call,job,snapshot,signal,domains,maxBytes=AGENT_POLICY.maxResponseBytes}) {
  signal?.throwIfAborted();
  if(typeof call!=='function'||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>AGENT_POLICY.maxResponseBytes)invalid();
  if(domains!==undefined&&(!Array.isArray(domains)||!domains.length||domains.some(d=>typeof d!=='string'||!d||d.length>256)||new Set(domains).size!==domains.length))invalid();
  const selectedDomains=domains===undefined?null:new Set(domains);
  if(!snapshot?.snapshotId||!Number.isFinite(Date.parse(snapshot.asOf))||!snapshot.coverage||typeof snapshot.coverage!=='object')invalid();
  const frozen=clone(snapshot);delete frozen.queriedAt;
  const coverageHash=stableHash(frozen.coverage),seal=frozen.coverage.sha256;
  if(Object.hasOwn(frozen.coverage,'sealed')&&(frozen.coverage.sealed!==true||!isHash(seal)))invalid();
  if(seal!==undefined&&!isHash(seal))invalid();
  const expected=frozen.coverage.evidenceCount;
  if(expected!==undefined&&(!Number.isSafeInteger(expected)||expected<0))invalid();
  const evidence=[],ids=new Set(),cursors=new Set(['0']),inventory=createHash('sha256'),observedDomains=new Set();
  // Even one-item pages consume at least this many bytes of the input budget.
  const maxPages=Math.ceil(maxBytes/Buffer.byteLength('{"evidenceId":"a","domain":"a","data":{}}'));
  let cursor='0',pages=0,chunks=0,evidenceBytes=2,transferredBytes=0,sourceIdentityBytes=0;
  const read=async(method,input)=>{signal?.throwIfAborted();const result=await call(method,input,{signal});signal?.throwIfAborted();transferredBytes+=Buffer.byteLength(JSON.stringify(result));return result;};
  function checkItem(item,descriptor=item) {
    if(!item||typeof item.evidenceId!=='string'||!item.evidenceId||typeof item.domain!=='string'||!item.domain||!item.data||item.dataRef||item.representation==='chunked')invalid();
    if(item.snapshotId!==undefined&&item.snapshotId!==frozen.snapshotId)invalid();
    if(item.numericCatalog&&(item.numericCatalog.snapshotId!==frozen.snapshotId||item.numericCatalog.evidenceId!==item.evidenceId))invalid();
    for(const key of ['evidenceId','domain','revision','availableAt','quality','publicationEligibility'])if(Object.hasOwn(descriptor,key)&&stableHash({value:descriptor[key]})!==stableHash({value:item[key]}))invalid();
    return item;
  }
  async function expand(descriptor) {
    if(!descriptor||typeof descriptor.evidenceId!=='string'||typeof descriptor.domain!=='string')invalid();
    if(descriptor.representation!=='chunked'&&!descriptor.dataRef)return checkItem(clone(descriptor));
    const size=descriptor.bytes,sha256=descriptor.sha256;
    if(!Number.isSafeInteger(size)||size<1||!isHash(sha256))invalid();
    if(size>maxBytes-evidenceBytes)tooLarge();
    const parts=[];let offset=0;
    while(offset<size){
      const part=await read('evidenceChunk',{snapshotId:frozen.snapshotId,evidenceId:descriptor.evidenceId,offset,format:'base64'});chunks++;
      const next=Math.min(offset+16384,size);
      if(part?.snapshotId!==frozen.snapshotId||part.evidenceId!==descriptor.evidenceId||part.encoding!=='base64'||part.bytes!==size||part.sha256!==sha256||part.nextOffset!==next||part.hasMore!==(next<size)||typeof part.chunk!=='string')invalid();
      // Buffer's base64 decoder accepts malformed input; demand canonical bytes.
      const bytes=Buffer.from(part.chunk,'base64');
      if(bytes.length!==next-offset||bytes.toString('base64')!==part.chunk)invalid();
      parts.push(bytes);offset=next;
    }
    const body=Buffer.concat(parts,size);
    if(digest(body)!==sha256)invalid();
    let item;
    try{item=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));}catch{invalid();}
    return checkItem(item,descriptor);
  }
  for(;;){
    if(++pages>maxPages)invalid();
    const page=await read('evidence',{snapshotId:frozen.snapshotId,cursor,limit:20});
    if(page?.snapshotId!==frozen.snapshotId||page.asOf!==frozen.asOf||!page.coverage||typeof page.coverage!=='object'||stableHash(page.coverage)!==coverageHash||frozen.scope!==undefined&&page.scope!==frozen.scope||!Array.isArray(page.items)||typeof page.hasMore!=='boolean')invalid();
    if(frozen.schemaVersion!==undefined&&page.schemaVersion!==frozen.schemaVersion||frozen.revision!==undefined&&page.revision!==frozen.revision)invalid();
    if(page.items.length>20||page.hasMore&&!page.items.length)invalid();
    for(const descriptor of page.items){
      if(!descriptor||typeof descriptor.evidenceId!=='string'||!descriptor.evidenceId||typeof descriptor.domain!=='string'||!descriptor.domain||ids.has(descriptor.evidenceId)||descriptor.snapshotId!==undefined&&descriptor.snapshotId!==frozen.snapshotId)invalid();
      sourceIdentityBytes+=Buffer.byteLength(JSON.stringify({evidenceId:descriptor.evidenceId,domain:descriptor.domain}));
      if(sourceIdentityBytes>maxBytes)tooLarge();
      ids.add(descriptor.evidenceId);observedDomains.add(descriptor.domain);inventory.update(stableHash(descriptor)+'\n');
      if(selectedDomains&&!selectedDomains.has(descriptor.domain))continue;
      const item=await expand(descriptor);
      evidenceBytes+=Buffer.byteLength(JSON.stringify(item))+(evidence.length?1:0);
      if(evidenceBytes>maxBytes)tooLarge();
      evidence.push(item);
    }
    if(!page.hasMore){if(page.nextCursor!==null)invalid();break;}
    const next=page.nextCursor;
    if(typeof next!=='string'||!/^\d+$/.test(next)||!Number.isSafeInteger(Number(next))||Number(next)<=Number(cursor)||cursors.has(next))invalid();
    cursors.add(next);cursor=next;
  }
  if(expected!==undefined&&expected!==ids.size)invalid();
  signal?.throwIfAborted();
  const prepared=prepareDirectGeneration({job,snapshot:frozen,evidence});
  const inputBytes=Buffer.byteLength(JSON.stringify(prepared.input));
  if(inputBytes>maxBytes)tooLarge();
  // The source seal hashes raw rows, unavailable through the projected API.
  // Bind that seal without claiming it was recomputed from projected evidence.
  const receipt=Object.freeze({version:VERSION,complete:true,snapshotId:frozen.snapshotId,asOf:frozen.asOf,
    enumerationComplete:true,sourceEvidenceCount:ids.size,sourceInventoryHash:inventory.digest('hex'),sourceIdentityBytes,excludedDomains:Object.freeze([...observedDomains].filter(domain=>selectedDomains&&!selectedDomains.has(domain)).sort()),
    materialization:selectedDomains?'selected-domains':'entire-snapshot',domains:selectedDomains?Object.freeze([...selectedDomains].sort()):null,
    completeness:selectedDomains?'all-items-of-selected-domains':'all-items-of-snapshot',excludedBodyVerification:selectedDomains?'not-performed':'not-applicable',
    snapshotHash:stableHash({snapshotId:frozen.snapshotId,asOf:frozen.asOf,coverage:frozen.coverage,...(frozen.scope===undefined?{}:{scope:frozen.scope})}),
    sourceSeal:seal||null,sourceSealVerification:seal?'manifest-consistency-only':'not-present',
    evidenceHash:stableHash(prepared.input.evidence),evidenceCount:evidence.length,pages,chunks,evidenceBytes,inputBytes,transferredBytes,inputHash:prepared.identity.inputHash});
  return {prepared,receipt};
}
