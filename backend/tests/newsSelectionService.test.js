import test from "node:test";
import assert from "node:assert/strict";
import { buildIntelNewsSelection } from "../services/news/newsSelectionService.js";

test('immutable corpus memo preserves ranking, diversity and counts across batches and changing selection context',()=>{
  const now=Date.parse('2026-11-08T11:00:00Z'),memo=new WeakMap();
  const articles=Array.from({length:72},(_,i)=>Object.freeze({id:`item-${i}`,provider:i%2?'rss':'newsapi',
    sourceName:['Reuters','BBC World','Unresolved publisher'][i%3],url:`https://example.org/news/${i}`,
    title:`Regional sanctions and shipping report ${i%11}`,publishedAt:new Date(now-i*60000).toISOString(),
    countryMentions:['US','ES','RU','IR'].filter((_,j)=>(i+j)%3),conflict:{totalWeight:i%9}}));
  let expected=[],actual=[];
  for(let offset=0;offset<articles.length;offset+=12){
    const batch=articles.slice(offset,offset+12),options={now:new Date(now+offset*1000),watchlistCountries:offset%24?['ES','IR']:['RU','US','US'],
      analyzeLimit:24,displayLimit:9,maxPerSource:2,maxSimilarHeadline:2,fillAvailable:true,ensureCountryCoverage:true,
      previousArticles:offset?articles.slice(0,offset):[]};
    const plain=buildIntelNewsSelection({...options,articles:[...expected,...batch]});
    const cached=buildIntelNewsSelection({...options,articles:[...actual,...batch],memo});
    assert.deepEqual(cached,plain);expected=plain.signalCorpus;actual=cached.signalCorpus;
  }
  const corrected={...articles[0],sourceName:'Reuters',url:'https://reuters.com/corrected',countryMentions:['ES'],title:'A distinct corrected report'};
  const options={articles:[corrected,...actual],watchlistCountries:['ES'],now:new Date(now+3600000),analyzeLimit:30,displayLimit:10};
  assert.deepEqual(buildIntelNewsSelection({...options,memo}),buildIntelNewsSelection(options));
  assert.equal(articles[0].analysisScore,undefined,'memo must not mutate its immutable input');
});

test("news selection preserves a wider signal corpus than the visible curated feed", () => {
  const now = Date.now();
  const articles = [
    {
      provider: "rss",
      sourceName: "BBC World",
      title: "Shipping lane risk rises in the Red Sea",
      url: "https://example.com/1",
      publishedAt: new Date(now - 5 * 60_000).toISOString(),
      countryMentions: ["US", "IL"],
      conflict: { totalWeight: 6 }
    },
    {
      provider: "rss",
      sourceName: "BBC World",
      title: "Shipping lane risk rises in the Red Sea again",
      url: "https://example.com/2",
      publishedAt: new Date(now - 10 * 60_000).toISOString(),
      countryMentions: ["US", "IL"],
      conflict: { totalWeight: 5 }
    },
    {
      provider: "rss",
      sourceName: "BBC World",
      title: "Regional escorts reinforce maritime corridor",
      url: "https://example.com/3",
      publishedAt: new Date(now - 15 * 60_000).toISOString(),
      countryMentions: ["US"],
      conflict: { totalWeight: 5 }
    },
    {
      provider: "newsapi",
      sourceName: "Reuters",
      title: "Defense contractors monitor regional escalation",
      url: "https://example.com/4",
      publishedAt: new Date(now - 20 * 60_000).toISOString(),
      countryMentions: ["IL", "IR"],
      conflict: { totalWeight: 7 }
    },
    {
      provider: "newsapi",
      sourceName: "Reuters",
      title: "Energy traders react to tanker security concerns",
      url: "https://example.com/5",
      publishedAt: new Date(now - 25 * 60_000).toISOString(),
      countryMentions: ["IR"],
      conflict: { totalWeight: 6 }
    }
  ];

  const result = buildIntelNewsSelection({
    articles,
    previousArticles: [],
    watchlistCountries: ["US", "IL", "IR"],
    now: new Date(now),
    analyzeLimit: 5,
    candidateWindowHours: 24,
    noveltyWindowHours: 12,
    maxPerSource: 2,
    maxSimilarHeadline: 2
  });

  assert.equal(result.signalCorpus.length, 5);
  assert.equal(result.displaySelection.length, 4);
  assert.ok(result.signalCorpus.length > result.displaySelection.length);
  assert.equal(result.selectionMeta.selectionConfig.maxPerSource, 2);
  assert.equal(Number.isFinite(result.selectionMeta.latestSelectedArticleAgeMin), true);

  const bbc = result.selectionMeta.selectionBySourceName.find((item) => item.provider === "rss" && item.sourceName === "BBC World");
  const reuters = result.selectionMeta.selectionBySourceName.find(
    (item) => item.provider === "newsapi" && item.sourceName === "Reuters"
  );
  assert.ok(bbc);
  assert.ok(reuters);
  assert.equal(bbc.raw, 3);
  assert.equal(bbc.filtered, 3);
  assert.equal(bbc.selected, 2);
  assert.equal(reuters.raw, 2);
  assert.equal(reuters.filtered, 2);
  assert.equal(reuters.selected, 2);
});
