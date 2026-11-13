import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,readdirSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Database from 'better-sqlite3';
import {migrate} from '../storage/migrate.js';
import {SqlNewsArchive} from '../storage/sqlNewsArchive.js';

const at='2026-11-07T10:00:00.000Z';
const article=(id,countries=['RU'],extra={})=>({id:'source-'+id,title:'Collected report '+id,
 url:'https://example.org/'+id,provider:'rss',sourceId:'fixture',publishedAt:at,
 countryMentions:countries,usagePolicy:'standard-link-out',...extra});
function fixture(version){
 const dir=mkdtempSync(join(tmpdir(),'ogid-country-search-')),db=new Database(join(dir,'fixture.sqlite'));
 db.pragma('journal_mode=WAL');db.pragma('foreign_keys=ON');
 if(version){
  const migrations=join(dir,'migrations');mkdirSync(migrations);
  for(const name of readdirSync(new URL('../storage/migrations/',import.meta.url)))if(Number(name.slice(0,3))<=version)copyFileSync(new URL('../storage/migrations/'+name,import.meta.url),join(migrations,name));
  migrate(db,migrations);
 }else migrate(db);
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
  assert.equal(positive.total,3);assert.equal(positive.hasMore,true);assert.equal(observed.count,1,'only the returned page may hydrate full immutable revision bodies');
 }finally{f.close();}
});

test('034 backfills populated immutable revisions without rewriting originals and preserves every search filter and quality flag',()=>{
 const f=fixture(33);try{
  f.archive.ingest([article('upgrade',['TW'],{title:'NASDAQ:NVDA Sanciones Ámbito'})]);
  const original=f.archive.getItem('source-upgrade').article;
  f.archive.save({...original,revision:original.revision+1,metadataUpdatedAt:at,synthetic:true,dataMode:'stale',
   sectors:['technology'],topics:['chips'],provenance:{stale:true},provenances:[{provider:'wire',sourceId:'wire-feed',publisher:'Wire edition'}]});
  const articles=f.db.prepare('SELECT rowid,* FROM articles').all(),revisions=f.db.prepare('SELECT rowid,* FROM article_revisions').all(),checksums=f.db.prepare('SELECT * FROM schema_migrations').all();
  migrate(f.db);
  assert.deepEqual(f.db.prepare('SELECT rowid,* FROM articles').all(),articles);
  assert.deepEqual(f.db.prepare('SELECT rowid,* FROM article_revisions').all(),revisions);
  assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations WHERE version<=33').all(),checksums);
  const result=f.archive.search({countries:['TW'],symbols:['NVDA'],q:'ÁMBITO',sectors:['technology'],topics:['chips'],providers:['wire'],sources:['Wire edition']});
  assert.equal(result.total,1);assert.equal(result.articles[0].title,original.title);
  assert.deepEqual(result.quality,{syntheticCount:1,staleCount:1});
  const before=f.db.prepare('SELECT * FROM news_search_projection').all();
  assert.throws(()=>f.db.transaction(()=>{f.archive.save({...original,revision:3,title:'Rolled back',metadataUpdatedAt:at});throw Error('rollback');})(),/rollback/);
  assert.deepEqual(f.db.prepare('SELECT * FROM news_search_projection').all(),before);
  assert.deepEqual(f.db.prepare('SELECT rowid,* FROM article_revisions').all(),revisions);
  assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
 }finally{f.close();}
});

test('inserting an older immutable revision cannot replace the current search projection',()=>{
 const f=fixture();try{
  f.archive.ingest([article('late',['TW'])]);
  const a=f.archive.getItem('source-late').article;
  f.archive.save({...a,revision:3,title:'Latest immutable title',metadataUpdatedAt:at});
  f.db.prepare('INSERT INTO article_revisions VALUES(?,?,?,?)').run(a.id,2,at,JSON.stringify({...a,revision:2,title:'Late historical insertion'}));
  const p=f.db.prepare('SELECT revision FROM news_search_projection WHERE article_id=?').get(a.id);
  assert.equal(p.revision,3);assert.equal(f.archive.search({countries:['TW']}).articles[0].title,'Latest immutable title');
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

test('full-history pages hydrate latest revisions in global row order while preserving frozen semantic order, totals and quality',()=>{
 const f=fixture();try{
  f.archive.ingest(Array.from({length:280},(_,n)=>article('ordered-'+n,n%3?['RU']:['UA'],{
   publishedAt:n%19?new Date(Date.parse(at)-((n*73)%281)*3600000).toISOString():null,
   dataMode:n%23?'observed':'stale'
  })));
  const expected=f.db.prepare(`SELECT r.rowid,r.payload_json FROM articles a JOIN article_revisions r
   ON r.article_id=a.article_id AND r.revision=a.revision
   ORDER BY coalesce(json_extract(r.payload_json,'$.publishedAt'),json_extract(r.payload_json,'$.receivedAt')) DESC,r.article_id ASC`).all();
  const prepare=f.archive.reader.prepare,wrapped=new WeakSet();let read=[];
  f.archive.reader.prepare=sql=>{
   const s=prepare(sql);
   if(sql.startsWith('SELECT rowid,payload_json FROM article_revisions WHERE rowid IN')&&!wrapped.has(s)){
    wrapped.add(s);const iterate=s.iterate;s.iterate=function*(...args){for(const row of iterate.apply(this,args)){read.push(row.rowid);yield row;}};
   }
   return s;
  };
  for(const countries of [[],['RU','UA']]){
   read=[];let page=f.archive.search({countries,limit:17});
   assert.deepEqual(read,[...read].sort((a,b)=>a-b),'payload reads must stay globally ordered across physical batches');
   assert.equal(read.length,17);assert.equal(page.total,280);
   assert.equal(page.quality.staleCount,expected.filter(r=>JSON.parse(r.payload_json).dataMode==='stale').length);
   const rows=[];for(;;){rows.push(...page.articles);if(!page.hasMore)break;page=f.archive.search({cursor:page.nextCursor,limit:17});}
   assert.deepEqual(rows.map(a=>a.id),expected.map(r=>JSON.parse(r.payload_json).id));
  }
 }finally{f.close();}
});

test('035 covers country/date totals and quality without reading projection bodies and preserves the complex-path result',()=>{
 const f=fixture(34);try{
  f.archive.ingest(Array.from({length:40},(_,n)=>article('cover-'+n,n%3?['RU','UA']:['TW'],{
   publishedAt:n%7?new Date(Date.parse(at)-n*3600000).toISOString():null,dataMode:n%5?'observed':'stale'
  })));
  const originals=f.db.prepare('SELECT rowid,* FROM article_revisions').all(),checksums=f.db.prepare('SELECT * FROM schema_migrations').all();
  migrate(f.db);
  assert.deepEqual(f.db.prepare('SELECT rowid,* FROM article_revisions').all(),originals);
  assert.deepEqual(f.db.prepare('SELECT * FROM schema_migrations WHERE version<=34').all(),checksums);
  const prepare=f.archive.reader.prepare.bind(f.archive.reader);let plans=0;
  f.archive.reader.prepare=sql=>{
   if(sql.startsWith('/* compact-news-page */')){
    // Expression indexes can be reported as USING INDEX rather than COVERING.
    // Inspect actual VM column reads: none may touch the projection table.
    const plan=prepare('EXPLAIN '+sql).all(...(sql.match(/\?/g)||[]).map(()=>null));
    const tableCursor=plan.find(row=>row.opcode==='OpenRead'&&row.p2===f.db.prepare("SELECT rootpage FROM sqlite_master WHERE name='news_search_projection'").get().rootpage)?.p1;
    assert.ok(!plan.some(row=>row.opcode==='Column'&&row.p1===tableCursor),'all count/filter/sort columns must come from the compact index');plans++;
   }
   return prepare(sql);
  };
  const semantics=value=>({articles:value.articles,total:value.total,quality:value.quality,hasMore:value.hasMore,revision:value.revision});
  for(const timeField of ['publishedAt','receivedAt','updatedAt','archiveChangedAt'])for(const bounded of [false,true]){
   const filters={countries:['RU','UA'],timeField,...(bounded?{from:'2026-11-06T00:00:00Z',to:'2026-11-08T00:00:00Z'}:{})};
   const simple=f.archive.search({...filters,limit:5}),complex=f.archive.search({...filters,q:'Collected report',limit:5});
   const clean=value=>({...semantics(value),articles:value.articles.map(a=>({...a,matchReasons:a.matchReasons.filter(r=>r.kind!=='text')}))});
   assert.deepEqual(clean(simple),clean(complex));
  }
  assert.equal(plans,8);
 }finally{f.close();}
});
