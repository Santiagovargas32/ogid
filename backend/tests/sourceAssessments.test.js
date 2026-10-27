import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,readdirSync,copyFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {migrate} from '../storage/migrate.js';
import {SourceAssessments} from '../services/news/sourceAssessments.js';
import {sourceCoverage} from '../storage/sourceCoverage.js';
import {SqlNewsArchive} from '../storage/sqlNewsArchive.js';
const registry=[{publisherId:'fixture-wire',name:'Fictional Wire',domains:['wire.example','local.example']}];
const at='2026-01-01T00:00:00.000Z';
const permission={basis:'self-authored',reference:'Fictional test only',redistributionAllowed:true};
const assessment=(extra={})=>({assessmentId:'fixture-one',revision:1,publisherId:'fixture-wire',edition:'wire.example',evaluatorId:'fixture-reviewer',evaluatorName:'Fictional reviewer',politicalScope:'fixture-country',methodId:'fixture-method',methodVersion:'1',methodUrl:'https://fixture.example/method',originalRating:'fixture-left',rating:'left',scaleVersion:'political-five-v1',assessedAt:'2025-12-01T00:00:00.000Z',validFrom:'2025-01-01T00:00:00.000Z',state:'published',evidenceUrls:['https://fixture.example/evidence'],licenseName:'Self-authored fictional fixture',licenseUrl:'https://fixture.example/permission',...extra});
const batch=(records,extra={})=>({requestId:'fixture-request',permission,assessments:records,dryRun:false,...extra});
function setup(){const db=new Database(':memory:');migrate(db);let now=Date.parse(at);return {db,store:new SourceAssessments(db,{registry,now:()=>now}),advance:()=>{now+=86400000;},now:()=>now};}
const subject=(store,input={})=>store.catalogue({publisherIds:['fixture-wire'],edition:'wire.example',...input}).items[0];

test('unrated, not applicable, disagreement and different political contexts are distinct states',()=>{
  const {db,store}=setup();try{
    assert.equal(subject(store).status,'unrated');store.importBatch(batch([assessment()]));assert.equal(subject(store).rating,'left');
    store.importBatch(batch([assessment({assessmentId:'fixture-two',evaluatorId:'other-reviewer',rating:'right'})]));
    assert.equal(subject(store).status,'disputed');assert.equal(subject(store).rating,null);
    store.importBatch(batch([assessment({assessmentId:'fixture-three',evaluatorId:'third-reviewer',politicalScope:'other-context'})]));
    assert.equal(subject(store).status,'different-contexts');assert.equal(subject(store,{politicalScope:'other-context'}).rating,'left');
    assert.equal(store.catalogue({publisherIds:['fixture-wire'],edition:'local.example'}).items[0].status,'unrated');
    assert.throws(()=>store.importBatch(batch([assessment({assessmentId:'unknown-edition',edition:'unknown.example'})])),{code:'SOURCE_ASSESSMENT_UNKNOWN_EDITION'});
  }finally{db.close();}
  const f=setup();try{f.store.importBatch(batch([assessment({rating:'not-applicable'})]));assert.equal(subject(f.store).status,'not-applicable');assert.equal(subject(f.store).rating,null);}finally{f.db.close();}
});

test('valid time, recorded time and immutable corrections preserve historical readings',()=>{
  const {db,store,advance,now}=setup();try{
    store.importBatch(batch([assessment()]));const original=db.prepare('SELECT payload_json FROM news_source_assessments').get().payload_json;
    assert.equal(subject(store,{asOf:'2025-12-15T00:00:00Z'}).status,'unrated');
    assert.equal(subject(store,{asOf:'2025-12-15T00:00:00Z',knownAt:at}).rating,'left');
    advance();store.importBatch(batch([assessment({revision:2,rating:'right',validFrom:new Date(now()).toISOString()})]));
    assert.equal(subject(store).rating,'right');assert.equal(subject(store,{asOf:at}).rating,'left');
    assert.equal(subject(store,{asOf:at,knownAt:new Date(now()).toISOString()}).rating,'left');
    assert.equal(db.prepare('SELECT payload_json FROM news_source_assessments WHERE revision=1').get().payload_json,original);
    assert.equal(store.detail({assessmentId:'fixture-one',revision:1}).assessment.rating,'left');
    assert.equal(store.importBatch(batch([assessment()])).duplicates,1,'old unchanged revisions are idempotent after newer corrections');
    advance();store.importBatch(batch([assessment({revision:3,validFrom:at,validUntil:new Date(now()).toISOString()})]));
    assert.equal(subject(store).status,'unrated','an expired correction must not revive the older revision');
  }finally{db.close();}
});

test('024 upgrades schema 023 additively without rewriting article originals or old checksums',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ogid-schema024-')),db=new Database(':memory:');
  try{
    for(const name of readdirSync(new URL('../storage/migrations/',import.meta.url)))if(Number(name.slice(0,3))<=23)copyFileSync(new URL(`../storage/migrations/${name}`,import.meta.url),join(dir,name));
    migrate(db,dir);const checksums=db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    db.prepare("INSERT INTO articles VALUES('legacy','Historical original',NULL,NULL,NULL,?,?,1,'headline-only-link-out','{}')").run(at,at);
    const originals=db.prepare('SELECT * FROM articles').all();assert.equal(migrate(db).length,29);
    assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=23 ORDER BY version').all(),checksums);
    assert.deepEqual(db.prepare('SELECT * FROM articles').all(),originals);assert.equal(db.prepare('SELECT count(*) AS n FROM news_editorial_facets').get().n,0);
    assert.equal(db.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(db.pragma('foreign_key_check'),[]);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('import defaults to preview, checks permission and references, rejects conflicts atomically',()=>{
  const {db,store}=setup();try{
    const preview=batch([assessment()]);delete preview.dryRun;assert.equal(store.importBatch(preview).dryRun,true);
    assert.equal(db.prepare('SELECT count(*) AS n FROM news_source_assessments').get().n,0);
    assert.throws(()=>store.importBatch(batch([assessment()],{permission:{...permission,redistributionAllowed:false}})),{code:'SOURCE_ASSESSMENT_PERMISSION_REQUIRED'});
    assert.throws(()=>store.importBatch(batch([assessment({methodUrl:'https://name:secret@fixture.example/'})])),{code:'SOURCE_ASSESSMENT_INVALID_REFERENCE'});
    store.importBatch(batch([assessment()]));assert.equal(store.importBatch(batch([assessment()])).duplicates,1);
    assert.throws(()=>store.importBatch(batch([assessment({assessmentId:'would-insert'}),assessment({rating:'right'})])),{code:'SOURCE_ASSESSMENT_REVISION_CONFLICT'});
    assert.equal(db.prepare('SELECT count(*) AS n FROM news_source_assessments').get().n,1);
    assert.throws(()=>store.importBatch(batch([assessment({revision:3})])),{code:'SOURCE_ASSESSMENT_REVISION_GAP'});
  }finally{db.close();}
});

test('stable subject and record cursors retain the original revision across concurrent imports',()=>{
  const {db,store}=setup();try{
    store.importBatch(batch([assessment()]));const first=store.catalogue({limit:1});
    store.importBatch(batch([assessment({assessmentId:'late',edition:'local.example'})]));
    const next=store.catalogue({limit:1,cursor:first.nextCursor});assert.equal(next.items[0].edition,'local.example');assert.equal(next.items[0].status,'unrated');
    assert.throws(()=>store.catalogue({cursor:first.nextCursor,publisherIds:['different']}),{code:'SOURCE_ASSESSMENT_CURSOR_MISMATCH'});
    store.importBatch(batch(Array.from({length:12},(_,n)=>assessment({assessmentId:`record-${n}`,evaluatorId:`reviewer-${n}`}))));
    let page=store.catalogue({view:'records',publisherIds:['fixture-wire'],limit:2,maxBytes:8192}),seen=[];
    const cut=page.revision;
    store.importBatch(batch([assessment({assessmentId:'after-record-cut'})]));
    do{seen.push(...page.items.map(x=>x.assessmentId));if(!page.hasMore)break;page=store.catalogue({view:'records',publisherIds:['fixture-wire'],limit:2,maxBytes:8192,cursor:page.nextCursor});}while(true);
    assert.equal(seen.length,14);assert.equal(new Set(seen).size,14);assert.ok(!seen.includes('after-record-cut'));assert.deepEqual(page.revision,cut);
  }finally{db.close();}
});

test('coverage separates publishers, owners and origin identifiers and reports unfinished facets',()=>{
  const {db,store}=setup();try{
    const article={id:'one',title:'Fictional publication',revision:1,receivedAt:at};
    db.prepare("INSERT INTO articles VALUES(?,?,NULL,?,NULL,?,?,1,'headline-only-link-out',?)").run(article.id,article.title,'https://wire.example/one',at,at,JSON.stringify(article));
    let data=sourceCoverage(db,store);assert.equal(data.coverage.partial,true);assert.equal(data.summary.unknownPublisherArticles,1);
    db.prepare("INSERT INTO news_editorial_facets VALUES(?,1,?,?,?,?,?,'[\"UA\"]')").run('one',at,'fixture-wire','wire.example','es',null);
    store.importBatch(batch([],{profiles:[{publisherId:'fixture-wire',edition:'wire.example',revision:1,verifiedAt:at,editorialCountries:['ES'],languages:['es'],ownerGroupId:'fictional-group',ownerGroupName:'Fictional Group',evidenceUrls:['https://fixture.example/ownership']}]}));
    data=sourceCoverage(db,store);assert.equal(data.coverage.partial,false);assert.equal(data.summary.publishers,1);assert.equal(data.summary.ownerGroups,1);assert.equal(data.summary.knownOriginChains,0);assert.equal(data.summary.unknownOriginArticles,1);assert.equal(data.publishers[0].assessmentStatus,'unrated');assert.equal(data.editorialCountries[0].country,'ES');assert.equal(data.mentionedCountries[0].country,'UA');assert.equal(data.plannedRegions[0].reportingCoverage,'not-established');
  }finally{db.close();}
});

test('facet backfill resumes bounded pages without changing complete editorial rows or frozen revisions',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ogid-facet-backfill-')),db=new Database(join(dir,'fixture.sqlite'));migrate(db);
  const archive=new SqlNewsArchive(db,{now:()=>Date.parse(at)});
  try{
    archive.ingest(Array.from({length:3},(_,n)=>({id:`facet-${n}`,title:`Ukraine missile strike report ${n}`,url:`https://reuters.com/fixture-${n}`,provider:'rss',publishedAt:at})));
    archive.enrichEditorialPage();const originals=db.prepare('SELECT * FROM article_revisions ORDER BY article_id,revision').all();
    db.exec("DELETE FROM news_editorial_facets; DELETE FROM runtime_meta WHERE key LIKE 'news.editorial-backfill:%:comparisons-v1'");
    assert.equal(archive.sourceCoverage().coverage.pendingFacetArticles,3);
    const first=archive.enrichEditorialPage({limit:1});assert.equal(first.processed,1);assert.equal(first.complete,false);
    assert.equal(archive.sourceCoverage().coverage.pendingFacetArticles,2);
    let page;do{page=archive.enrichEditorialPage({limit:1});}while(!page.complete);
    assert.equal(archive.sourceCoverage().coverage.partial,false);assert.deepEqual(db.prepare('SELECT * FROM article_revisions ORDER BY article_id,revision').all(),originals);
  }finally{archive.close();db.close();rmSync(dir,{recursive:true,force:true});}
});
