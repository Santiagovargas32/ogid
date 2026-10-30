import test from 'node:test';
import assert from 'node:assert/strict';
import { PressurePolicy, ResourceAdmission } from '../storage/resourceAdmission.js';

const GiB=1024**3;
const healthy={availableBytes:4*GiB,memoryFull:0,ioFull:0};

test('pressure suspends heavy work, preserves commits, and recovers only after healthy hysteresis',()=>{
  let time=100000;
  const gate=new ResourceAdmission({enabled:true,now:()=>time});
  const observe=sample=>{gate.observe(sample);time+=1000;};
  observe(healthy);
  assert.equal(gate.status().state,'normal');
  for(let n=0;n<3;n++)observe({...healthy,availableBytes:900*1024**2});
  assert.equal(gate.status().state,'degraded');
  assert.throws(()=>gate.assert('heavy'),{code:'STORAGE_RESOURCE_PRESSURE',notExecuted:true});
  assert.doesNotThrow(()=>gate.assert('commit'));
  assert.doesNotThrow(()=>gate.assert('control'));
  assert.doesNotThrow(()=>gate.assert('journal'));
  observe({...healthy,availableBytes:300*1024**2});
  assert.equal(gate.status().critical,true);
  assert.throws(()=>gate.assert('journal'),{code:'STORAGE_RESOURCE_PRESSURE'});
  for(let n=0;n<30;n++)observe(healthy);
  assert.equal(gate.status().state,'recovering');
  observe(healthy);
  assert.equal(gate.status().state,'normal');
});

test('missing and stale samples cannot admit heavy work or complete a recovery window',()=>{
  let time=100000;
  const gate=new ResourceAdmission({enabled:true,now:()=>time});
  assert.throws(()=>gate.assert('heavy'),{code:'STORAGE_RESOURCE_PRESSURE'});
  gate.observe(healthy);time+=11000;
  assert.equal(gate.status().state,'unknown');
  assert.throws(()=>gate.assert('acquisition'),{code:'STORAGE_RESOURCE_PRESSURE'});
  gate.observe({...healthy,ioFull:60});time+=1000;gate.observe(healthy);
  time+=31000;gate.observe(healthy);
  assert.equal(gate.status().state,'recovering','missing samples do not prove continuous recovery');
  gate.observe(null);
  assert.equal(gate.status().state,'unknown');
});

test('one shared reservation spans reader lanes and can be released before writer RPC',()=>{
  const gate=new ResourceAdmission({enabled:false});
  assert.equal(gate.acquire('analysis'),true);
  assert.equal(gate.acquire('queries'),false);
  gate.release('analysis');
  assert.equal(gate.acquire('queries'),true);
  gate.release('queries');
  assert.equal(gate.status().heavyActive,0);
});

test('PSI can pause work even with sufficient free memory',()=>{
  const policy=new PressurePolicy();
  for(let n=0;n<3;n++)policy.observe({...healthy,ioFull:25},100000+n*1000);
  assert.equal(policy.snapshot.state,'degraded');
  assert.equal(policy.snapshot.reason,'io-pressure');
});
