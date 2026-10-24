import {parentPort} from 'node:worker_threads';
import {OfficialSourceService} from './officialSources.js';
import {registerCompany} from './companyIdentity.js';
import {registerInstruments} from '../market/instrumentRegistry.js';
let active=null;
parentPort.on('message',async message=>{
  if(message.type==='cancel'){if(active?.id===message.id)void active.service.stop();return;}
  if(message.type!=='acquire'||active)return;
  const {source,company,instruments,userAgent,timeoutMs,previous}=message.input;
  if(company)registerCompany(company);registerInstruments(instruments||[]);
  const store={state:{sourceStates:{[source.sourceId]:previous||{}},companyFacts:{},holdings:{}},transact(fn){return fn(this.state);}},events=[];
  const eventLedger={ingest(items,options){events.push({items,options});return {accepted:items.length};}};
  const service=new OfficialSourceService({store,eventLedger,sources:[source],userAgent,timeoutMs,attemptIdFactory:()=>message.id});active={id:message.id,service};
  try{
    await service.run({sourceIds:[source.sourceId],maxRequests:1});
    const result={events,companyFacts:store.state.companyFacts,holdings:store.state.holdings,runtime:store.state.sourceStates[source.sourceId]};
    if(Buffer.byteLength(JSON.stringify(result))>4194304)throw Object.assign(Error('Prepared source exceeds budget'),{code:'SOURCE_TOO_LARGE'});
    parentPort.postMessage({id:message.id,result});
  }catch(error){parentPort.postMessage({id:message.id,error:{code:error.code||'SOURCE_ACQUISITION_FAILED'}});}finally{active=null;}
});
