import {writeMetricBucket} from './committedWriteMetrics.js';

const scalar=value=>typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(value)?value:null;
const kinds=new Set(['pipeline-stage','market-publication','market','quotes','provider-quota','awareness','awareness-audit','awareness-poll','ai','ai-record','ai-budget','signals']);
const kindLabel=value=>{
 if(typeof value!=='string')return null;
 if(kinds.has(value))return value;
 return writeMetricBucket('runtime_snapshots',[value]).slice('snapshot:'.length);
};

// Resolve only the owning AsyncLocalStorage command. Several cooperative
// acquisitions may be active; the newest global command is not its owner.
// Never copy input, bindings, user request IDs or dynamic snapshot identities.
export function slowCommitCommand(context,activeCommands){
 const id=context?.commandId;
 if(typeof id!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))return null;
 const command=activeCommands.get(id);if(!command)return null;
 return {commandId:id,operation:scalar(command.operation),service:scalar(command.service),method:scalar(command.method),kind:kindLabel(command.kind)};
}
