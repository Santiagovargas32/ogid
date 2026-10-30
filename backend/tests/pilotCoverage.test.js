import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {migrate} from '../storage/migrate.js';
import {pilotCoverage} from '../storage/pilotCoverage.js';
import {deriveFeedId,canonicalizeFeedUrl} from '../services/news/rssCanonicalCatalog.js';
import {NEWS_SOURCE_CATALOG} from '../services/news/newsSourceCatalog.js';
import {parseFeedArticles} from '../services/news/providers/rssProvider.js';

const at='2026-10-30T08:00:00.000Z',now=Date.parse(at);
test('pilot separates configuration, live checks, stale health and discovery queries',()=>{
 const db=new Database(':memory:');try{
  migrate(db);const input={from:at,to:at,now};
  let data=pilotCoverage(db,input);assert.ok(data[0].configured>0);assert.equal(data[0].consulted,0);assert.equal(data[0].healthy,0);assert.ok(data[0].discoveryQueries.configured>0);
  const entry=NEWS_SOURCE_CATALOG.entries.find(x=>x.sourceId==='rss-kyiv-independent'),kind='rss-canonical-feed:'+deriveFeedId(canonicalizeFeedUrl(entry.url));
  db.prepare('INSERT INTO runtime_snapshots VALUES(?,?,?)').run(kind,at,JSON.stringify({lastAttemptAt:now,lastSuccessAt:now,healthStatus:'healthy',lastHttpStatus:200}));
  data=pilotCoverage(db,input);assert.equal(data[0].consulted,1);assert.equal(data[0].healthy,1);assert.equal(data[1].healthy,0);
  data=pilotCoverage(db,{...input,now:now+2*entry.expectedCadence.minPollIntervalMs+1});assert.equal(data[0].consulted,1);assert.equal(data[0].healthy,0);assert.equal(data[0].sources.find(x=>x.sourceId===entry.sourceId).health,'stale');
 }finally{db.close();}
});
test('pilot uses country mentions and excludes fallback/future dates from sampled latency',()=>{
 const db=new Database(':memory:');try{
  migrate(db);
  for(let n=0;n<3;n++){
   const a={id:'article-'+n,title:'reported publication',publishedAt:n===2?'2026-10-31T08:00:00Z':'2026-10-30T07:59:00Z',provenance:{publishedAtQuality:n===1?'fallback-receivedAt':'provider'}};
   db.prepare("INSERT INTO articles VALUES(?,?,NULL,?,?,?, ?,1,'headline-only-link-out',?)").run(a.id,a.title,'https://example.org/'+n,a.publishedAt,at,at,JSON.stringify(a));
   db.prepare("INSERT INTO news_editorial_facets VALUES(?,1,?,NULL,NULL,'en',?,'[\"UA\"]')").run(a.id,at,n<2?'shared':null);
  }
  const [ua,red]=pilotCoverage(db,{from:at,to:at,now});assert.equal(ua.archiveSample.articles,3);assert.equal(red.archiveSample.articles,0);assert.equal(ua.archiveSample.sharedOriginReports,1);assert.equal(ua.archiveSample.unknownOriginArticles,1);assert.deepEqual(ua.archiveSample.publicationToReception,{samples:1,p95Ms:60000});assert.equal(ua.archiveSample.unknownPublisherArticles,3);
 }finally{db.close();}
});
test('admitted feeds resolve exact publisher identity without matching similar hosts',()=>{
 for(const [sourceId,host,publisherId]of [['rss-kyiv-independent','kyivindependent.com','kyiv-independent'],['rss-gcaptain','gcaptain.com','gcaptain']]){
  const feed=NEWS_SOURCE_CATALOG.entries.find(x=>x.sourceId===sourceId);
  const xml=url=>`<rss><channel><title>Feed</title><item><title>Published report</title><link>${url}</link></item></channel></rss>`;
  assert.equal(parseFeedArticles(xml('https://'+host+'/report'),feed.name,feed)[0].publisherId,publisherId);
  assert.equal(parseFeedArticles(xml('https://fake'+host+'/report'),feed.name,feed)[0].publisherId,null);
 }
});
