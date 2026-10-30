import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { PressurePolicy, writePressure } from './resourceAdmission.js';

const policy=new PressurePolicy(workerData.policy);
function full(text){const value=/^full .*?avg10=([\d.]+)/m.exec(text)?.[1];return value===undefined?NaN:Number(value);}
async function sample(){
  let result;
  try{
    const [memory,memPsi,ioPsi]=await Promise.all([readFile('/proc/meminfo','utf8'),readFile('/proc/pressure/memory','utf8'),readFile('/proc/pressure/io','utf8')]);
    const available=/^MemAvailable:\s+(\d+) kB/m.exec(memory)?.[1];
    result={availableBytes:available===undefined?NaN:Number(available)*1024,memoryFull:full(memPsi),ioFull:full(ioPsi)};
  }catch{result=null;}
  writePressure(workerData.buffer,policy.observe(result,Date.now(),performance.now()));parentPort.postMessage({sample:true});
  setTimeout(sample,workerData.policy.sampleIntervalMs);
}
void sample();
