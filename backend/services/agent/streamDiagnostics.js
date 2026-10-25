import {terminalFailure} from './failures.js';
// Bounded SSE observer; bytes are forwarded unchanged and never retained in telemetry.
export class StreamDiagnostics {
  constructor(){this.decoder=new TextDecoder();this.line='';this.data='';this.oversized=false;this.done=false;this.finished=false;this.failure=null;}
  push(bytes){
    for(let offset=0;offset<bytes.length;offset+=8192){
      const text=this.decoder.decode(bytes.subarray(offset,offset+8192),{stream:true});
      for(const part of text.split(/(?<=\n)/)){
        if(this.line.length+part.length>65536){this.line='';this.data='';this.oversized=true;}
        if(!this.oversized)this.line+=part;
        if(!part.endsWith('\n'))continue;
        if(this.oversized){this.oversized=false;this.line='';continue;}
        const line=this.line.trimEnd();this.line='';
        if(line.startsWith('data:')){this.data+=(this.data?'\n':'')+line.slice(5).trimStart();if(this.data.length>65536){this.data='';this.oversized=true;}}
        else if(!line)this.event();
      }
    }
  }
  event(){
    const data=this.data;this.data='';if(!data)return;
    if(data==='[DONE]'){this.done=true;return;}
    try{const value=JSON.parse(data);if(value.error)this.failure=terminalFailure({...value.error,type:value.error.type||'provider.internal'});
      if(value.choices?.some(c=>typeof c.finish_reason==='string'))this.finished=true;
    }catch{/* Unknown frames cannot establish completion. */}
  }
  result(){return this.failure || (!this.done||!this.finished?{causeCode:'BROKER_INCOMPLETE_STREAM',phase:'stream-completion',httpStatus:200}:null);}
}
