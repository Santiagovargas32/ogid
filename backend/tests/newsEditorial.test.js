import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {classifyRssArticle,rankSourceCredibility} from '../services/news/rssClassifier.js';
import {parseFeedArticles} from '../services/news/providers/rssProvider.js';
import {resolveEditorialIdentity} from '../services/news/publisherIdentity.js';
import {normalizeArticles} from '../services/normalizeService.js';
import {permittedArticle,publicProjection} from '../utils/researchProjection.js';
import {NewsArchive} from '../services/research/newsArchive.js';
import {SqlNewsArchive} from '../storage/sqlNewsArchive.js';
import {migrate} from '../storage/migrate.js';
import {compareNews,newsRevision} from '../utils/newsOrder.js';
import {compareNews as clientCompare,NewsSelectionTracker} from '../../frontend/js/newsFeedModel.js';
import {newsEditorialLabels} from '../../frontend/js/newsEditorial.js';

test('publisher aliases are exact and domains cannot impersonate an editor',()=>{
  assert.equal(rankSourceCredibility('Japan Times'),.55);assert.equal(rankSourceCredibility('Capitol Gazette'),.55);
  assert.equal(rankSourceCredibility('AP'),rankSourceCredibility('Associated Press'));
  assert.equal(resolveEditorialIdentity({url:'https://www.reuters.com/a'}).publisherId,'reuters');
  assert.equal(resolveEditorialIdentity({url:'https://reuters.com.evil.invalid/a',publisher:'Reuters'}).publisherId,null);
  assert.equal(resolveEditorialIdentity({publisher:'Reuters'}).publisherResolution.status,'candidate');
  assert.equal(resolveEditorialIdentity({url:'https://apnews.com/a',publisher:'Reuters'}).publisherResolution.reason,'conflicting-identities');
  assert.equal(resolveEditorialIdentity({url:'https://unrelated.invalid/a',publisherCandidate:{name:'Reuters',url:'https://reuters.com'}}).publisherId,null);
  const direct={url:'https://reuters.com/fixture'},resolved=resolveEditorialIdentity(direct);
  assert.deepEqual(resolveEditorialIdentity({...direct,...resolved}),resolved);
  assert.equal(resolveEditorialIdentity({...direct,...resolved,publisher:'Associated Press'}).publisherResolution.reason,'conflicting-identities');
});

test('RSS item source survives normalization and public policy while discovery stays separate',()=>{
  const xml='<rss><channel><title>Google News Ukraine</title><item><title>Missile strike - Reuters</title><link>https://news.google.com/rss/articles/example</link><source url="https://www.reuters.com/">Reuters</source></item></channel></rss>';
  const raw=parseFeedArticles(xml,'fixture',{type:'generated_search',sourceId:'search-google-fixture'})[0];
  for(const article of [raw,normalizeArticles([raw])[0],permittedArticle(normalizeArticles([raw])[0]),publicProjection(normalizeArticles([raw])[0])]){
    assert.equal(article.publisherId,'reuters');assert.equal(article.discoverySourceId,'search-google-fixture');assert.equal(article.transportProvider,'rss');assert.equal(article.originChainId,null);
  }
  const archive=new NewsArchive();archive.ingest([raw]);assert.equal(archive.getItem(raw.id || [...archive.records.keys()][0]).article.publisherId,'reuters');
});

test('five languages share contextual topics; unsupported scripts remain explicitly unknown',()=>{
  for(const [language,title] of [['en','Missile strike in Ukraine'],['es','Ataque con misiles en Ucrania'],['fr','Frappe de missiles en Ukraine'],['de','Raketenangriff in Ukraine'],['pt','Ataque com mísseis na Ucrânia']]){
    const item=classifyRssArticle({title,language});assert.ok(item.topicTags.includes('conflict'),title);assert.ok(!item.topicTags.includes('civil_unrest'),title);assert.equal(item.classification.status,'evaluated');assert.equal(item.classification.language,language);assert.ok(item.countryMentions.includes('UA'),title);
  }
  assert.ok(classifyRssArticle({title:'Workers strike in Ukraine'}).topicTags.includes('civil_unrest'));
  for(const [title,modality] of [['No missile strike in Ukraine','negated'],['Ukraine may launch a missile strike tomorrow','prospective'],['Opinion: missile strike in Ukraine','opinion']])assert.equal(classifyRssArticle({title}).classification.modality,modality);
  const unsupported=classifyRssArticle({title:'Удар ракетами по Украине'});assert.equal(unsupported.threatLevel,'unknown');assert.equal(unsupported.classification.status,'unsupported-language');
  assert.equal(classifyRssArticle({title:'No casualties after missile strike in Ukraine'}).classification.modality,'reported');
  const restricted=classifyRssArticle({title:'Regional report',description:'Missile strike sanctions',language:'en',usagePolicy:'headline-only-link-out'});
  assert.equal(restricted.classification.textScope,'headline');assert.deepEqual(restricted.topicTags,[]);
  const feedItem=parseFeedArticles('<rss><channel><item><title>Ataque con misiles en Ucrania</title></item></channel></rss>','fixture',{languages:['en']})[0];
  assert.equal(feedItem.language,null);assert.equal(classifyRssArticle(feedItem).classification.language,'es');
});

test('metadata update preserves URL-less identity/content dates and only updates sync representation',()=>{
  let now=Date.parse('2026-10-26T10:00:00Z');const archive=new NewsArchive({now:()=>now});
  const raw={id:'old-id',title:'Missile strike in Ukraine',publisher:'Reuters',provider:'rss',publishedAt:'2026-10-26T09:00:00Z'};
  archive.ingest([raw]);const before=[...archive.records.values()][0];now+=60000;
  archive.ingest([{...raw,discoverySourceId:'source-reviewed',publisherCandidate:{name:'Reuters',url:'https://reuters.com'}}]);const after=[...archive.records.values()][0];
  assert.equal(after.id,before.id);assert.equal(after.contentRevision,before.contentRevision);assert.equal(after.receivedAt,before.receivedAt);assert.equal(after.publishedAt,before.publishedAt);assert.equal(after.archiveChangedAt,before.archiveChangedAt);assert.equal(after.revision,before.revision+1);
  assert.equal(after.publisherId,null);assert.equal(after.discoverySourceId,'source-reviewed');assert.notEqual(newsRevision([before]),newsRevision([after]));
  assert.equal(normalizeArticles([raw])[0].identity,normalizeArticles([{...raw,publisher:'Associated Press'}])[0].identity);
  const tracker=new NewsSelectionTracker();tracker.observe([before],'one');assert.deepEqual(tracker.observe([after],'two'),{newIds:[],updatedIds:[after.id]});
});

test('server/client share both orders and metadata labels never guess a legacy publisher',()=>{
  const items=[{id:'a',threatLevel:'elevated',analysisScore:1,publishedAt:'2026-10-26T10:00:00Z'},{id:'z',threatLevel:'elevated',analysisScore:99,publishedAt:'2026-10-26T09:00:00Z'}];
  for(const order of ['critical','recent'])assert.deepEqual([...items].sort((a,b)=>compareNews(a,b,order)),[...items].sort((a,b)=>clientCompare(a,b,order)));
  assert.equal([...items].sort(compareNews)[0].id,'z');assert.equal([...items].sort((a,b)=>compareNews(a,b,'recent'))[0].id,'a');
  assert.equal(newsEditorialLabels({sourceName:'Google News'}).publisher,'Editor pendiente');
});

test('historical enrichment commits its cursor atomically, resumes after reopening, and leaves frozen revisions intact',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ogid-editorial-')),file=join(dir,'db.sqlite'),db=new Database(file);migrate(db);let archive=new SqlNewsArchive(db);
  try{
    for(let n=0;n<3;n++)archive.ingest([{title:`Missile strike in Ukraine ${n}`,url:`https://reuters.com/${n}`,provider:'rss',publishedAt:'2026-10-26T09:00:00Z'}]);
    // Simulate historical rows lacking editorial metadata without changing their immutable revisions.
    db.exec("UPDATE articles SET payload_json=json_remove(payload_json,'$.publisherId','$.publisherResolution','$.classification')");
    const frozen=db.prepare('SELECT * FROM article_revisions ORDER BY article_id,revision').all();
    const save=archive.save.bind(archive);archive.save=()=>{throw Error('injected rollback');};
    assert.throws(()=>archive.enrichEditorialPage({limit:1}),/injected rollback/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM runtime_meta WHERE key LIKE 'news.editorial-backfill:%'").get().n,0);
    archive.save=save;assert.equal(archive.enrichEditorialPage({limit:1}).processed,1);archive.close();archive=new SqlNewsArchive(db);
    let result;do{result=archive.enrichEditorialPage({limit:1});}while(!result.complete);
    assert.equal(result.processed,3);assert.deepEqual(archive.enrichEditorialPage(),result);
    for(const row of frozen)assert.deepEqual(db.prepare('SELECT * FROM article_revisions WHERE article_id=? AND revision=?').get(row.article_id,row.revision),row);
    assert.equal(db.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(db.pragma('foreign_key_check'),[]);
  }finally{archive.close();db.close();rmSync(dir,{recursive:true,force:true});}
});
