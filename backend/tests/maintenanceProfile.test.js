import test from 'node:test';
import assert from 'node:assert/strict';
import {readMaintenanceProfile} from '../utils/maintenanceProfile.js';
import {AgentMaintenance} from '../services/agent/maintenance.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {StorageManager} from '../storage/StorageManager.js';

test('diagnostic profiles require a finite runtime and IA off before startup',()=>{
  assert.equal(readMaintenanceProfile([]),null);
  const args=['--maintenance-advanced=on-demand'];
  for(const runtimeLimitMs of [null,0,-1,Infinity,NaN])assert.throws(()=>readMaintenanceProfile(args,{runtimeLimitMs,agentMode:'off'}),{code:'MAINTENANCE_PROFILE_INVALID'});
  for(const agentMode of [null,'shadow','visible'])assert.throws(()=>readMaintenanceProfile(args,{runtimeLimitMs:360000,agentMode}),{code:'MAINTENANCE_PROFILE_INVALID'});
  for(const flags of [['--maintenance-advanced'],['--maintenance-advanced=off'],['--maintenance-advanced=on-demand=extra'],[...args,...args]])assert.throws(()=>readMaintenanceProfile(flags,{runtimeLimitMs:360000,agentMode:'off'}),{code:'MAINTENANCE_PROFILE_INVALID'});
  assert.deepEqual(readMaintenanceProfile(args,{runtimeLimitMs:360000,agentMode:'off'}),{advancedMode:'on-demand'});
  assert.deepEqual(readMaintenanceProfile(['--maintenance-advanced=continuous'],{runtimeLimitMs:360000,agentMode:'off'}),{advancedMode:'continuous'});
});

test('on-demand advanced preserves control and technical work without acknowledging skipped inputs',async()=>{
  let revision=1,now=Date.parse('2026-11-17T12:00:00Z');const calls=[];
  const business={news:{enrichEditorialPage:async()=>{calls.push('editorial');return {complete:true};}},
    advanced:{getSnapshot:async()=>{calls.push('advanced');return {asOf:'fixed',revision:7};}},
    conditions:{getSnapshot:async()=>calls.push('conditions')},forecasts:{evaluate:async()=>calls.push('evaluation')},
    technical:{get:async options=>calls.push('technical:'+options.interval)}};
  const m=new AgentMaintenance({enabled:true,advancedMode:'on-demand',now:()=>now,business,
    instruments:()=>['us-equity-general-dynamics'],dependencies:async()=>({news:{revision,hasRecentNews:true},research:revision,candles:{}}),
    call:async()=>{calls.push('alerts');return {hasMore:false};}});
  await m.tick();revision++;now+=60000;await m.tick();
  assert.equal(calls.filter(x=>x==='advanced').length,0);
  for(const domain of ['alerts','conditions','evaluation'])assert.equal(calls.filter(x=>x===domain).length,2,domain);
  for(const interval of ['1day','1h','15min'])assert.ok(calls.includes('technical:'+interval));
  assert.equal(calls.filter(x=>x==='editorial').length,1);
  assert.equal(m.completedInputs.has('advanced'),false);
  assert.equal(m.status.domains.advanced.state,'on-demand');assert.equal(m.status.domains.advanced.inputRevision,null);
  assert.equal(m.status.domains.advanced.lastSuccessAt,null);assert.ok(m.status.domains.advanced.requiredInputRevision);
  assert.deepEqual(await business.advanced.getSnapshot({}),{asOf:'fixed',revision:7});
  await m.stop();
  const restored=new AgentMaintenance({enabled:true,business,call:async()=>({hasMore:false})});
  await restored.tick();assert.equal(calls.filter(x=>x==='advanced').length,2);await restored.stop();
});

test('forced maintenance cannot silently turn the diagnostic back into automatic advanced work',async()=>{
  const m=new AgentMaintenance({enabled:true,advancedMode:'on-demand',call:async()=>({}),
    business:{advanced:{getSnapshot:async()=>assert.fail('automatic advanced ran')},conditions:{getSnapshot:async()=>{}},forecasts:{evaluate:async()=>{}}}});
  await m.run({force:true});await m.analyticalTask;assert.equal(m.status.domains.advanced.state,'on-demand');await m.stop();
});

test('excluded automatic advanced remains explicitly available, durable and reusable after restart',{timeout:30000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ogid-maintenance-profile-')),databasePath=join(dir,'fixture.sqlite');
  let manager=new StorageManager({enabled:true,businessEnabled:true,databasePath}),maintenance;
  const configure=()=>manager.request('domain.configure',{rootDir:dir,news:{analyzeLimit:3000,displayLimit:40},rss:{rssFeeds:[]}});
  const explicit=()=>manager.request('domain.call',{service:'advanced',method:'getSnapshot',args:[{countries:['RU']}],context:{newsFromStorage:true,snapshot:{}}});
  const counts=()=>{const db=new Database(databasePath,{readonly:true});try{return ['analysis_jobs','analysis_runs'].map(t=>db.prepare('SELECT count(*) n FROM '+t).get().n);}finally{db.close();}};
  try{
    await manager.start();await configure();
    maintenance=new AgentMaintenance({enabled:true,advancedMode:'on-demand',
      dependencies:()=>manager.request('runtime.load',{kind:'maintenance-inputs'}),
      call:()=>manager.request('agent.call',{method:'alertSync',args:{}}),
      business:{advanced:{getSnapshot:explicit},conditions:{getSnapshot:async()=>{}},forecasts:{evaluate:async()=>{}}}});
    await maintenance.tick();assert.deepEqual(counts(),[0,0]);
    const pending=await explicit();assert.equal(pending.lifecycle.status,'preparing');
    await Promise.all([...manager.advancedCoordinator.tasks.values()]);
    const ready=await explicit();assert.equal(ready.lifecycle.status,'ready');assert.ok(ready.generatedAt);
    assert.deepEqual(counts(),[1,1]);await maintenance.tick();assert.deepEqual(counts(),[1,1]);
    assert.equal(maintenance.status.domains.alerts.state,'ready');
    await maintenance.stop();await manager.close();
    manager=new StorageManager({enabled:true,businessEnabled:true,databasePath});await manager.start();await configure();
    const restored=await explicit();assert.equal(restored.lifecycle.status,'ready');assert.equal(restored.generatedAt,ready.generatedAt);assert.deepEqual(counts(),[1,1]);
  }finally{await maintenance?.stop();await manager.close();rmSync(dir,{recursive:true,force:true});}
});
