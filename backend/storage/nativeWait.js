import {readlinkSync,openSync,readSync,closeSync} from 'node:fs';

export function nativeThreadId(){
  if(process.platform!=='linux')return null;
  try{return Number(readlinkSync('/proc/thread-self').split('/').at(-1))||null;}catch{return null;}
}
function boundedRead(file){
  let descriptor;
  try{
    descriptor=openSync(file,'r');const buffer=Buffer.alloc(2048),bytes=readSync(descriptor,buffer,0,buffer.length,0);
    return {available:true,value:buffer.toString('utf8',0,bytes).replace(/\[<[^>]+>\]/g,'').trim(),truncated:bytes===buffer.length};
  }catch(reason){return {available:false,code:reason.code||'UNAVAILABLE'};}
  finally{if(descriptor!==undefined){try{closeSync(descriptor);}catch{/* Diagnostics must never break failure cleanup. */}}}
}
// Read only this process's known worker, before termination. These small proc
// records can distinguish a kernel I/O wait from SQL work on the next failure;
// denied kernel stacks are represented as unknown, never guessed.
export function readNativeWait(threadId){
  if(process.platform!=='linux' || !Number.isSafeInteger(threadId) || threadId<=0)return null;
  return {threadId,capturedAt:new Date().toISOString(),waitChannel:boundedRead(`/proc/self/task/${threadId}/wchan`),stack:boundedRead(`/proc/self/task/${threadId}/stack`),ioPressure:boundedRead('/proc/pressure/io')};
}
