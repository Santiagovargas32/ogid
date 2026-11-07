import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {migrate} from '../storage/migrate.js';
import {SqlNewsArchive} from '../storage/sqlNewsArchive.js';

const at='2026-11-07T10:00:00.000Z';
const article=(id,countries=['RU'],extra={})=>({id:'source-'+id,title:'Collected report '+id,
 url:'https://example.org/'+id,provider:'rss',sourceId:'fixture',publishedAt:at,
 countryMentions:countries,usagePolicy:'standard-link-out',...extra});
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'ogid-country-search-')),db=new Database(join(dir,'fixture.sqlite'));
 db.pragma('journal_mode=WAL');db.pragma('foreign_keys=ON');migrate(db);
 const archive=new SqlNewsArchive(db,{now:()=>Date.parse(at)+3600000});
 return {db,archive,close(){archive.close();db.close();rmSync(dir,{recursive:true,force:true});}};
}
function observeBodies(archive){
 const prepare=archive.reader.prepare,wrapped=new WeakSet();let count=0;
 archive.reader.prepare=sql=>{
  const statement=prepare(sql);
  if(sql.startsWith('SELECT rowid,payload_json FROM article_revisions WHERE rowid IN')&&!wrapped.has(statement)){
   wrapped.add(statement);const iterate=statement.iterate;
   statement.iterate=function*(...args){for(const row of iterate.apply(this,args)){count++;yield row;}};
  }
  return statement;
 };
 return {get count(){return count;},reset(){count=0;}};
}

test('an empty country search reads no unrelated revision bodies, while positive searches keep exact totals',()=>{
 const f=fixture();try{
  f.archive.ingest(Array.from({length:120},(_,n)=>article(n)));
  f.archive.ingest(Array.from({length:120},(_,n)=>article(n,['RU'],{title:'Corrected report '+n})));
  f.archive.ingest([article('a',['TW']),article('b',['TW','UA']),article('c',['TW'])]);
  const observed=observeBodies(f.archive),empty=f.archive.search({countries:['AQ'],limit:1});
  assert.equal(empty.total,0);assert.deepEqual(empty.articles,[]);assert.equal(observed.count,0,'country index must reject unrelated bodies before hydration');
  observed.reset();const positive=f.archive.search({countries:['TW','UA'],limit:1});
  assert.equal(positive.total,3);assert.equal(positive.hasMore,true);assert.equal(observed.count,3,'only the latest matching revision bodies may be hydrated');
 }finally{f.close();}
});

test('country filters use the same WAL cut as immutable revisions and cursor replay survives subsequent corrections',()=>{
 const f=fixture();try{
  f.archive.ingest([article('a',['TW']),article('b',['TW']),article('c',['TW'])]);
  const prepare=f.archive.reader.prepare;let changed=false;
  f.archive.reader.prepare=sql=>{
   const statement=prepare(sql);
   if(!changed&&sql==='SELECT coalesce(max(rowid),0) AS n FROM article_revisions'){
    const get=statement.get;statement.get=function(...args){const result=get.apply(this,args);if(!changed){changed=true;const current=f.archive.getItem('source-b').article;f.archive.save({...current,title:'Correction outside the old country',countryMentions:['RU'],revision:current.revision+1,metadataUpdatedAt:at});}return result;};
   }
   return statement;
  };
  let page=f.archive.search({countries:['TW'],limit:1});const first=page,rows=[];
  f.archive.ingest([article('d',['TW'])]);
  for(;;){rows.push(...page.articles);assert.equal(page.snapshotId,first.snapshotId);assert.equal(page.total,3);if(!page.hasMore)break;page=f.archive.search({cursor:page.nextCursor,limit:1});}
  assert.equal(changed,true);assert.equal(rows.length,3);assert.equal(new Set(rows.map(a=>a.id)).size,3);
  assert.ok(rows.every(a=>a.countryMentions.includes('TW')));assert.ok(rows.every(a=>a.title!=='Correction outside the old country'));
  const current=f.archive.search({countries:['TW'],limit:10});assert.equal(current.total,3);assert.ok(current.articles.some(a=>a.url.endsWith('/d')));assert.ok(current.articles.every(a=>!a.url.endsWith('/b')));
 }finally{f.close();}
});

test('country filtering preserves indexed date windows, null-date rules and latest-revision exclusion',()=>{
 const f=fixture();try{
  f.archive.ingest([article('dated',['TW']),article('other',['RU']),article('unknown',['TW'],{publishedAt:null})]);
  const current=f.archive.getItem('source-dated').article;
  f.archive.save({...current,publishedAt:'2026-10-01T10:00:00.000Z',revision:current.revision+1,metadataUpdatedAt:at});
  const filters={countries:['TW'],from:'2026-11-07T00:00:00.000Z',to:'2026-11-08T00:00:00.000Z'};
  assert.equal(f.archive.search(filters).total,0,'an older in-window revision must not replace the latest out-of-window correction');
  const received=f.archive.search({...filters,timeField:'receivedAt'});assert.equal(received.total,2);assert.ok(received.articles.some(a=>a.publishedAt===null));
  const observed=observeBodies(f.archive);assert.equal(f.archive.search({...filters,countries:['AQ'],timeField:'receivedAt'}).total,0);assert.equal(observed.count,0);
 }finally{f.close();}
});
