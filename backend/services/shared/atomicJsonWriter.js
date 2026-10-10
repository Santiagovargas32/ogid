import {mkdir,writeFile,rename} from 'node:fs/promises';
import {dirname} from 'node:path';
import {performance} from 'node:perf_hooks';
// Una cola por propietario. Coalesce sin permitir que una revisión vieja sustituya una nueva.
export class AtomicJsonWriter {
  constructor(path, snapshot){this.path=path;this.snapshot=snapshot;this.dirty=0;this.written=0;this.running=null;this.lastError=null;this.metrics={writes:0,bytes:0,serializeMs:0,writeMs:0};}
  mark(){this.dirty++;if(!this.path)return;this.timer ||= setTimeout(()=>{this.timer=null;void this.flush().catch(error=>{this.lastError=error;});},50);}
  flush(){
    clearTimeout(this.timer);this.timer=null;
    if(!this.path)return Promise.resolve();
    if(this.running)return this.running;
    this.running=(async()=>{
      while(this.written<this.dirty){const revision=this.dirty;const start=performance.now();const json=JSON.stringify(this.snapshot());this.metrics.serializeMs=performance.now()-start;this.metrics.bytes=Buffer.byteLength(json);
        await mkdir(dirname(this.path),{recursive:true,mode:0o700});const temp=`${this.path}.${process.pid}.tmp`;const t=performance.now();await writeFile(temp,json,{mode:0o600});await rename(temp,this.path);this.metrics.writeMs=performance.now()-t;this.metrics.writes++;this.written=revision;this.lastError=null;}
    })().catch(error=>{this.lastError=error;throw error;}).finally(()=>{this.running=null;});
    return this.running;
  }
}
