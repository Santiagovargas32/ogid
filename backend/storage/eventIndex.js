import {randomUUID} from 'node:crypto';
import {stableHash} from '../utils/stableHash.js';
import {EventLedger} from '../services/research/eventLedger.js';
import {listVerifiedInstruments} from '../services/market/instrumentRegistry.js';
const get=(db,key)=>{const r=db.prepare('SELECT value_json FROM runtime_meta WHERE key=?').get(key);return r?JSON.parse(r.value_json):null;};
const put=(db,key,value)=>db.prepare('INSERT INTO runtime_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json').run(key,JSON.stringify(value));
export function eventIndexView(db){const generation=get(db,'events.index.active');return generation?{table:'event_index_links',generation}:{table:'event_instruments',generation:null};}
export function eventIndexStatus(db){const build=get(db,'events.index.build');return {state:build?'building':'ready',processed:build?.processed??null,generation:eventIndexView(db).generation,buildingGeneration:build?.generation??null};}
export function beginEventIndex(db){return db.transaction(()=>{
 const instruments=listVerifiedInstruments();
 const fingerprint=stableHash(instruments.map(i=>[i.instrumentId,i.canonicalSymbol,[...i.aliases].sort(),i.companyId]).sort((a,b)=>a[0].localeCompare(b[0])));
 if(get(db,'events.index')===fingerprint && !get(db,'events.index.build'))return eventIndexStatus(db);
 if(get(db,'events.index.build')?.fingerprint!==fingerprint||get(db,'events.index.build')?.cursorKind!=='rowid'){retire(db,get(db,'events.index.build')?.generation);put(db,'events.index.build',{generation:randomUUID(),fingerprint,cursorKind:'rowid',cursor:null,processed:0,startedAt:new Date().toISOString()});}
 return eventIndexStatus(db);
}).immediate();}
function retire(db,generation){if(generation)put(db,'events.index.retired',[...new Set([...(get(db,'events.index.retired')||[]),generation])]);}
export function writeEventImpacts(db,event,impacts){
 const active=eventIndexView(db),build=get(db,'events.index.build');
 if(!active.generation){db.prepare('DELETE FROM event_instruments WHERE event_id=?').run(event.eventId);const insert=db.prepare('INSERT INTO event_instruments VALUES(?,?,?)');for(const i of impacts)insert.run(event.eventId,i.instrumentId,JSON.stringify(i));}
 const generations=new Set([active.generation,build?.generation].filter(Boolean));
 const remove=db.prepare('DELETE FROM event_index_links WHERE generation=? AND event_id=?'),insert=db.prepare('INSERT INTO event_index_links VALUES(?,?,?,?)');
 for(const generation of generations){remove.run(generation,event.eventId);for(const i of impacts)insert.run(generation,event.eventId,i.instrumentId,JSON.stringify(i));}
}
// One short writer transaction per page. New/revised events dual-write the build
// in their existing business transaction, including inserts behind this cursor.
export function eventIndexPage(db,{limit=64,budgetMs=250}={}){
 if(!Number.isSafeInteger(limit)||limit<1||limit>64||!Number.isSafeInteger(budgetMs)||budgetMs<1||budgetMs>1000)throw Object.assign(Error('Invalid index page'),{code:'STORAGE_INVALID_COMMAND'});
 return db.transaction(()=>{
  const build=get(db,'events.index.build');if(!build)return eventIndexStatus(db);
  const first=db.prepare('SELECT rowid AS sequence,event_id,payload_json FROM events ORDER BY rowid LIMIT 1'),next=db.prepare('SELECT rowid AS sequence,event_id,payload_json FROM events WHERE rowid>? ORDER BY rowid LIMIT 1');
  const ledger=new EventLedger({store:{}}),universe=listVerifiedInstruments(),remove=db.prepare('DELETE FROM event_index_links WHERE generation=? AND event_id=?'),insert=db.prepare('INSERT INTO event_index_links VALUES(?,?,?,?)');
  const started=performance.now();let processed=0;
  for(let n=0;n<limit;n++){
    const row=build.cursor===null?first.get():next.get(build.cursor);if(!row)break;
    const event=JSON.parse(row.payload_json);remove.run(build.generation,row.event_id);for(const i of ledger.impact(event,universe))insert.run(build.generation,row.event_id,i.instrumentId,JSON.stringify(i));
    build.cursor=row.sequence;processed++;
    if(performance.now()-started>=budgetMs)break;
  }
  if(!processed){retire(db,eventIndexView(db).generation);put(db,'events.index.lastBuild',{...build,completedAt:new Date().toISOString()});put(db,'events.index.active',build.generation);put(db,'events.index',build.fingerprint);put(db,'research.revision',(get(db,'research.revision')||0)+1);db.prepare('DELETE FROM runtime_meta WHERE key=?').run('events.index.build');return eventIndexStatus(db);}
  build.processed+=processed;put(db,'events.index.build',build);return eventIndexStatus(db);
 }).immediate();
}
// Bounded retention of inactive generations; never remove active/building facts.
export function cleanEventIndex(db,limit=128){return db.transaction(()=>{
 const retired=get(db,'events.index.retired')||[],active=eventIndexView(db).generation,build=get(db,'events.index.build')?.generation;
 const generation=retired[0];if(!generation)return false;
 if(generation===active||generation===build)retired.shift();
 else if(db.prepare('DELETE FROM event_index_links WHERE rowid IN (SELECT rowid FROM event_index_links WHERE generation=? LIMIT ?)').run(generation,limit).changes<limit)retired.shift();
 put(db,'events.index.retired',retired);return retired.length>0;
}).immediate();}
