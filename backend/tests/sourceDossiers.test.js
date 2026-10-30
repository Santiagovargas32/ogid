import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {migrate} from '../storage/migrate.js';
import {SourceDossiers} from '../storage/sourceDossiers.js';
import {SourceAssessments} from '../services/news/sourceAssessments.js';
import {dossier,at} from './fixtures/sourceDossier.js';
import {projectOperation} from '../utils/researchProjection.js';
import {getOperation} from '../contracts/ogidOperations.js';
function setup(path=':memory:'){const db=new Database(path);migrate(db);let clock=Date.parse(at);const assessments=new SourceAssessments(db,{now:()=>clock}),store=new SourceDossiers(db,{assessments,now:()=>clock});return {db,assessments,store,tick:()=>clock+=1000};}
const propose=(store,d=dossier(),requestId='propose')=>store.propose({requestId,dossier:d});

test('drafts stay private, approval publishes profile atomically and old revisions survive restart',()=>{
 const dir=mkdtempSync(join(tmpdir(),'source-dossiers-'));let s=setup(join(dir,'db.sqlite'));
 try{const p=propose(s.store);assert.equal(s.store.list().items.length,0);assert.equal(s.store.list({},true).items[0].status,'pending-review');assert.throws(()=>s.store.detail({dossierId:p.dossierId}),{code:'SOURCE_DOSSIER_NOT_FOUND'});s.tick();
  const body={requestId:'review',dossierId:p.dossierId,revision:p.revision,contentHash:p.contentHash,decision:'approve',reviewer:'Human',reason:'Reviewed'};const result=s.store.review(body);assert.deepEqual(s.store.review(body),result);assert.equal(s.assessments.catalogue({publisherIds:['reuters']}).items[0].ownEvaluation.sampleSize,0);assert.equal(s.db.prepare('SELECT count(*) n FROM news_publisher_profiles').get().n,1);
  s.db.close();s=setup(join(dir,'db.sqlite'));s.tick();s.tick();assert.equal(s.store.list().items.length,1);assert.equal(s.store.detail({dossierId:p.dossierId}).profile.publisherId,'reuters');
 }finally{s.db.close();rmSync(dir,{recursive:true,force:true});}
});
test('review requires exact hash and latest immutable revision; request reuse cannot change a proposal',()=>{
 const {store,db,tick}=setup();try{const p=propose(store);assert.deepEqual(propose(store),p);assert.throws(()=>propose(store,dossier({author:'changed'})),{code:'SOURCE_DOSSIER_REQUEST_CONFLICT'});
  const base={requestId:'review',dossierId:p.dossierId,revision:1,contentHash:'a'.repeat(64),decision:'approve',reviewer:'Human',reason:'Reviewed'};assert.throws(()=>store.review(base),{code:'SOURCE_DOSSIER_REVIEW_CONFLICT'});tick();propose(store,dossier({revision:2}),'second');assert.throws(()=>store.review({...base,contentHash:p.contentHash}),{code:'SOURCE_DOSSIER_REVIEW_STALE'});assert.equal(store.list().items.length,0);
 }finally{db.close();}
});
test('approval rollback leaves neither review nor profile; withdrawal does not revive an earlier evaluation',()=>{
 const {store,db,tick}=setup();try{const p=propose(store),body={requestId:'review',dossierId:p.dossierId,revision:1,contentHash:p.contentHash,decision:'approve',reviewer:'Human',reason:'Reviewed'};
  db.exec("CREATE TRIGGER refuse_review BEFORE INSERT ON source_evaluation_reviews BEGIN SELECT RAISE(ABORT,'review failed'); END");assert.throws(()=>store.review(body),/review failed/);assert.equal(db.prepare('SELECT count(*) n FROM news_publisher_profiles').get().n,0);db.exec('DROP TRIGGER refuse_review');tick();store.review(body);const knownAt=new Date(Date.parse(at)+1000).toISOString();tick();store.review({...body,requestId:'withdraw',decision:'withdraw'});assert.equal(store.list().items.length,0);assert.equal(store.list({knownAt}).items.length,1);
 }finally{db.close();}
});
test('political labels, observations, references and samples require consistent evidence',()=>{
 const {store,db}=setup();try{
  for(const change of [d=>d.political.rating='center',d=>d.evidence[0].url='http://user:secret@example.com',d=>d.journalism.attribution.status='backed',d=>d.political.sampleIds=['missing'],d=>d.profile.evidenceUrls=['https://absent.example/'],d=>d.profileStatements[0].evidenceIds=['missing']]){const d=dossier();change(d);assert.throws(()=>propose(store,d));}
  assert.equal(db.prepare('SELECT count(*) n FROM source_evaluation_dossiers').get().n,0);
 }finally{db.close();}
});
test('detail pages freeze their cut and cannot swap section or revision',()=>{
 const {store,db,tick}=setup();try{const d=dossier();d.evidence.push({...d.evidence[0],id:'second'});const p=propose(store,d);const input={dossierId:p.dossierId,section:'evidence',limit:1};const first=store.detail(input,true);assert.equal(first.items.length,1);tick();const second=store.detail({...input,cursor:first.nextCursor},true);assert.equal(second.items[0].id,'second');assert.equal(second.knownAt,first.knownAt);assert.throws(()=>store.detail({...input,section:'sample',cursor:first.nextCursor},true),{code:'SOURCE_DOSSIER_CURSOR_INVALID'});
 }finally{db.close();}
});
test('MCP sample projection preserves manifest identity without forwarding article bodies',()=>{
 const item={id:'sample-one',articleId:'article-one',articleRevision:2,title:'Report',url:'https://example.com/report',publishedAt:at,receivedAt:at,originChainId:null,textScope:'headline',type:'news',fullText:'PRIVATE'};
 const result=projectOperation(getOperation('news.source-evaluation'),{items:[item]});assert.equal(result.items[0].id,item.id);assert.equal(result.items[0].articleRevision,2);assert.equal(result.items[0].textScope,'headline');assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
});
