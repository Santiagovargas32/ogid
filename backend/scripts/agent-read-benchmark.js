import {eventIndexView} from "../storage/eventIndex.js";
// Read-only comparison on a consistent validation copy; no cache dropping.
import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {physicalPages} from '../storage/sqlitePayloadPages.js';
const [file,output]=process.argv.slice(2);
if(!file||!output)throw Error('Usage: node scripts/agent-read-benchmark.js database.sqlite report.json');
const db=new Database(file,{readonly:true,fileMustExist:true});db.pragma('query_only=ON');
const report={startedAt:new Date().toISOString(),database:file,readOnly:true,cachePolicy:'No cache dropping; alternate query order, same static copy; not a cold-disk claim',samples:[]};
try{
 const view=eventIndexView(db);
 const instrument=db.prepare(`SELECT instrument_id,count(*) AS n FROM ${view.table} ${view.generation?'WHERE generation=?':''} GROUP BY instrument_id ORDER BY n DESC LIMIT 1`).get(...(view.generation?[view.generation]:[]));
 if(!instrument)throw Error('No event membership to benchmark');
 const end=db.prepare('SELECT max(observed_at) AS at FROM events').get().at;
 const from=new Date(Date.parse(end)-86400000).toISOString();
 const where=`FROM events INDEXED BY events_by_time WHERE EXISTS (SELECT 1 FROM ${view.table} ei WHERE ${view.generation?'generation=? AND ':''}ei.event_id=events.event_id AND ei.instrument_id IN (?)) AND observed_at>=? ORDER BY observed_at DESC,event_id LIMIT ?`;
 const params=[...(view.generation?[view.generation]:[]),instrument.instrument_id,from,100];
 report.instrumentId=instrument.instrument_id;report.from=from;report.limit=100;
 report.beforePlan=db.prepare('EXPLAIN QUERY PLAN SELECT payload_json '+where).all(...params);
 report.afterPlan=db.prepare('EXPLAIN QUERY PLAN SELECT rowid,event_id '+where).all(...params);
 const hash=rows=>createHash('sha256').update(JSON.stringify(rows.map(r=>r.payload_json))).digest('hex');
 let expected;
 for(const variant of ['before','after','after','before','before','after']){
  const started=performance.now();
  const rows=db.transaction(()=>variant==='before'?db.prepare('SELECT payload_json '+where).all(...params):[...physicalPages(db,'events',db.prepare('SELECT rowid,event_id '+where).all(...params))]).deferred();
  const elapsedMs=performance.now()-started,digest=hash(rows);expected??=digest;
  if(digest!==expected)throw Error('Query results differ');
  report.samples.push({variant,elapsedMs,rows:rows.length,sha256:digest});
 }
 report.status='passed';
}catch(e){report.status='failed';report.errorCode=e.code||e.message;process.exitCode=1;}
finally{db.close();report.finishedAt=new Date().toISOString();writeFileSync(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report));}
