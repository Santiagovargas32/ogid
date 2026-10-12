import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { AppError } from '../../utils/error.js';
const TABLES=['events','jobs','holdings','companyFacts','sourceStates','forecasts'];
const empty=()=>({schemaVersion:'research-ledger-v1',revision:0,...Object.fromEntries(TABLES.map(k=>[k,{}]))});
// Legacy compatibility and fixture repository. Production SQL algorithms run in workers.
export class ResearchStore {
  constructor({persistencePath=null,maxEntries=20000}={}){
    this.path=persistencePath;this.maxEntries=maxEntries;this.state=empty();
    this.metrics={transactions:0,capacityErrors:0,cloneMs:0,stringifyMs:0,writeMs:0,lastWriteBytes:0,capacityKind:null};
    if(this.path)try{
      const value=JSON.parse(readFileSync(this.path,'utf8'));
      if(value.schemaVersion!==this.state.schemaVersion||!Number.isInteger(value.revision)||TABLES.some(k=>!value[k]||Array.isArray(value[k])||typeof value[k]!=='object'))throw Error('schema');
      this.state=value;
    }catch(error){if(error.code!=='ENOENT')throw new AppError('No se puede recuperar research ledger; conservar el archivo.',503,'RESEARCH_RECOVERY_FAILED');}
  }
  capacity(details){this.metrics.capacityErrors++;this.metrics.capacityKind=details.kind;throw new AppError('Ledger en límite; migrar explícitamente a SQL sin borrar históricos.',507,'RESEARCH_CAPACITY',details);}
  transact(fn){
    let start=performance.now();const next=structuredClone(this.state);this.metrics.cloneMs=performance.now()-start;
    const result=fn(next);if(result?.then)throw new AppError('La transacción debe ser síncrona.',500,'RESEARCH_ASYNC_TRANSACTION');
    for(const table of TABLES){const count=Object.keys(next[table]).length;if(count>this.maxEntries)this.capacity({kind:'entries',table,count,limit:this.maxEntries});}
    next.revision++;start=performance.now();const encoded=JSON.stringify(next);this.metrics.stringifyMs=performance.now()-start;this.metrics.lastWriteBytes=Buffer.byteLength(encoded);
    if(this.metrics.lastWriteBytes>67108864)this.capacity({kind:'bytes',bytes:this.metrics.lastWriteBytes,limit:67108864});
    if(this.path){start=performance.now();mkdirSync(dirname(this.path),{recursive:true,mode:0o700});const temp=`${this.path}.${process.pid}.tmp`;writeFileSync(temp,encoded,{mode:0o600});renameSync(temp,this.path);this.metrics.writeMs=performance.now()-start;}
    this.state=next;this.metrics.transactions++;return structuredClone(result??null);
  }
  getDiagnostics(){return {...this.metrics,backend:'legacy-json',revision:this.state.revision,tables:Object.fromEntries(TABLES.map(k=>[k,Object.keys(this.state[k]).length]))};}
  view(table){return structuredClone(this.state[table]);}
}
