import { mkdtempSync, openSync, writeSync, readSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

// Private, bounded scratch files hold captured payloads, never a second business
// database. A failed build is discarded and rebuilt from a new consistent cut.
export class FrozenRows {
  constructor({maxBytes=512*1024*1024,maxRowBytes=8*1024*1024}={}) {
    this.directory=mkdtempSync(join(tmpdir(),'ogid-frozen-'));
    this.file=join(this.directory,'rows.jsonl');
    this.fd=openSync(this.file,'wx+',0o600);this.bytes=0;this.count=0;
    Object.assign(this,{maxBytes,maxRowBytes});
  }
  add(value) {
    const data=Buffer.from(JSON.stringify(value)+'\n');
    if(data.length>this.maxRowBytes || this.bytes+data.length>this.maxBytes)
      throw Object.assign(Error('Frozen input budget exceeded; no partial result'),{code:'STORAGE_CAPTURE_TOO_LARGE'});
    let offset=0;while(offset<data.length)offset+=writeSync(this.fd,data,offset,data.length-offset);
    this.bytes+=data.length;this.count++;
  }
  *rows() {
    const buffer=Buffer.alloc(64*1024),decoder=new StringDecoder('utf8');let position=0,pending='';
    while(position<this.bytes){
      const n=readSync(this.fd,buffer,0,Math.min(buffer.length,this.bytes-position),position);position+=n;
      pending+=decoder.write(buffer.subarray(0,n));let end;
      while((end=pending.indexOf('\n'))!==-1){const line=pending.slice(0,end);pending=pending.slice(end+1);yield JSON.parse(line);}
    }
    pending+=decoder.end();if(pending)throw Error('Incomplete frozen input');
  }
  close(){if(this.fd===null)return;closeSync(this.fd);this.fd=null;rmSync(this.directory,{recursive:true,force:true});}
}
