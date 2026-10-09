import { dateTimeFormatter } from "../utils/dateTimeFormat.js";
import { stableHash } from "../utils/stableHash.js";
import { normalizeArticles } from "../services/normalizeService.js";
import { buildIntelNewsSelection } from "../services/news/newsSelectionService.js";
import { buildFinancialNewsSelection, partitionNewsArticles } from "../services/news/financialNewsService.js";
import { classifyRssArticle } from "../services/news/rssClassifier.js";
import { CountryRiskAccumulator, classifyTrend } from "../services/riskEngineService.js";
import { filterNewsBySources } from "../utils/filters.js";
import Database from "better-sqlite3";
import { readMeta } from "./sqlRepositories.js";

const HOUR = 3600000;
const positive = (value, fallback, max = 10000) => Math.min(max, Math.max(1, Number(value) || fallback));

export function newsDayStart(now, timeZone = "Europe/Madrid") {
  const parts = dateTimeFormatter("en-GB", { timeZone, year:"numeric", month:"2-digit", day:"2-digit" }).formatToParts(new Date(now));
  const date = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const midnight = Date.UTC(Number(date.year), Number(date.month)-1, Number(date.day));
  let instant = midnight;
  const formatter = dateTimeFormatter("en-GB", { timeZone, year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", second:"2-digit", hourCycle:"h23" });
  for (let i=0; i<4; i++) {
    const local = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(part => [part.type, part.value]));
    const represented = Date.UTC(Number(local.year), Number(local.month)-1, Number(local.day), Number(local.hour), Number(local.minute), Number(local.second));
    const correction = midnight-represented;
    instant += correction;
    if (!correction) break;
  }
  return new Date(instant).toISOString();
}

// All scans/ranking run in the storage worker. Only bounded projections leave it.
// Risk is accumulated over every eligible daily article, before selection limits.
export class SqlNewsCorpus {
  constructor(archive, config = {}) {
    this.archive = archive;
    this.config = config;
    this.cache = new Map();
    this.inFlight = new Map();
  }

  async read({ now = this.archive.now(), windowHours = this.config.candidateWindowHours || 36, countries = this.config.watchlistCountries || [], sources = [], awarenessMode = "off" } = {}) {
    const hours = positive(windowHours, 36, 336);
    const key = stableHash([this.archive.revision, Math.floor(now/60000), hours, [...countries].sort(), [...sources].sort(), awarenessMode]);
    if (this.cache.has(key)) return this.cache.get(key);
    if (this.inFlight.has(key)) return this.inFlight.get(key);
    const task = this.scan({ now, hours, countries, viewSources:sources, awarenessMode }).then(result => {
      this.cache.set(key, result);
      while (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value);
      this.lastDiagnostics = result.meta;
      return result;
    }).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, task);
    return task;
  }

  async scan({ now, hours, countries, viewSources, awarenessMode }) {
    const reader=new Database(this.archive.db.name,{readonly:true,timeout:1500});
    try {
      reader.pragma("query_only=ON");reader.exec("BEGIN");
      const started = performance.now(), revision = readMeta(reader,"news.meta",{revision:this.archive.revision}).revision;
      const asOf = new Date(now).toISOString(), dayStart = newsDayStart(now, this.config.dayTimeZone || "Europe/Madrid");
      const from = new Date(Math.min(now-hours*HOUR, Date.parse(dayStart))).toISOString();
      const analyzeLimit = positive(this.config.analyzeLimit, 3000), displayLimit = positive(this.config.displayLimit, 40, 200);
      const selectionOptions = { now:new Date(now), watchlistCountries:countries, candidateWindowHours:hours, analyzeLimit, displayLimit, maxPerSource:this.config.maxPerSource || 3, maxSimilarHeadline:this.config.maxSimilarHeadline || 1, ensureCountryCoverage:true, fillAvailable:true };
      const risk = new CountryRiskAccumulator(asOf), seen = new Set(), countryLeaders = new Map();
      let geo = [], financial = [], daily = [], diverseDay = [], batch = [], scanned = 0, eligible = 0, dailyCount = 0, displayCandidateCount = 0, geoCount = 0, financialCount = 0, duplicateCount = 0, latestGeopoliticalPublishedAt = null;
      const providerCounts = {}, sources = new Set();
      const rankBatch = () => {
        const branches = partitionNewsArticles(batch,{reuseClassification:true});
        const geopolitical = branches.geopolitical.filter(article => article.countryMentions?.length);
        geoCount += geopolitical.length;
        for(const article of geopolitical) if(!latestGeopoliticalPublishedAt || article.publishedAt>latestGeopoliticalPublishedAt) latestGeopoliticalPublishedAt=article.publishedAt;
        for (const article of geopolitical) if (article.publishedAt >= dayStart) { risk.add(article); dailyCount++; }
        geo = buildIntelNewsSelection({ ...selectionOptions, articles:[...geo, ...geopolitical] }).signalCorpus;
        const dayCandidates=filterNewsBySources(geopolitical.filter(article=>article.publishedAt>=dayStart && (!countries.length || article.countryMentions.some(country=>countries.includes(country)))),viewSources);
        displayCandidateCount+=dayCandidates.length;
        diverseDay=buildIntelNewsSelection({...selectionOptions,articles:[...diverseDay,...dayCandidates]}).displaySelection;
        const rankedDay = buildIntelNewsSelection({ ...selectionOptions, articles:[...daily, ...dayCandidates], analyzeLimit:Math.max(analyzeLimit, displayLimit*20) });
        daily = rankedDay.signalCorpus;
        for (const article of rankedDay.displaySelection) for (const country of article.countryMentions || []) {
          if (!countries.includes(country)) continue;
          const previous = countryLeaders.get(country);
          if (!previous || article.analysisScore > previous.analysisScore) countryLeaders.set(country, article);
        }
        if (awarenessMode === "visible") {
          financialCount += branches.financial.length;
          financial = buildFinancialNewsSelection({articles:[...financial, ...branches.financial], now:new Date(now), candidateWindowHours:hours, analyzeLimit,reuseClassification:true}).signalCorpus;
        }
        batch = [];
      };
      // Publication index bounds the scan. No pagination snapshots, full archive
      // hydration, or synchronous writes are created by this read.
      for (const row of reader.prepare("SELECT payload_json FROM articles WHERE published_at>=? AND published_at<=? ORDER BY published_at DESC,article_id DESC").iterate(from, asOf)) {
        scanned++;
        const stored = JSON.parse(row.payload_json);
        if (!stored.title?.trim() || !stored.url || stored.synthetic || ["synthetic","fallback","seeded"].includes(stored.dataMode) || stored.provenance?.synthetic) continue;
        const sourcesAllowed = this.config.sourceAllowlist || [], domainsAllowed = this.config.domainAllowlist || [];
        if (sourcesAllowed.length && !sourcesAllowed.some(source => (stored.sourceName || stored.publisher || "").toLowerCase().includes(source.toLowerCase()))) continue;
        let hostname;
        try { const url = new URL(stored.url); if (!["http:","https:"].includes(url.protocol)) continue; hostname=url.hostname.toLowerCase(); } catch { continue; }
        if (domainsAllowed.length && !domainsAllowed.some(domain => hostname===domain || hostname.endsWith(`.${domain}`))) continue;
        const identity = `${stored.title.toLowerCase().replace(/\s+/g," ").trim()}|${stored.publishedAt.slice(0,10)}`;
        if (seen.has(identity)) { duplicateCount++; continue; }
        seen.add(identity);
        const article = normalizeArticles([{...stored, description:stored.excerpt || ""}], stored.provider)[0];
        if (!article) continue;
        article.id = stored.id;
        article.countryMentions = [...new Set([...(stored.countryMentions || []), ...article.countryMentions])];
        article.leadImageUrl = stored.leadImageUrl || null;
        article.imageUrl = article.leadImageUrl;
        article.revision = stored.revision;
        article.contentRevision = stored.contentRevision;
        if(stored.analysisFeatures?.methodVersion === "news-features-v1"){
          article.sentiment=stored.analysisFeatures.sentiment;
          article.conflict=stored.analysisFeatures.conflict;
          article.financial=stored.analysisFeatures.financial;
        }
        article.content = "";
        article.fullText = "";
        eligible++;
        providerCounts[article.provider] = (providerCounts[article.provider] || 0)+1;
        sources.add(article.sourceId || article.sourceName);
        batch.push(article);
        if (batch.length >= 256) { rankBatch(); await new Promise(resolve => setImmediate(resolve)); }
      }
      if (batch.length) rankBatch();
      const displayCandidates = [...new Map([...daily, ...diverseDay, ...countryLeaders.values()].map(article => [article.id,article])).values()];
      const visibleCandidates = displayCandidates.filter(article => !countries.length || article.countryMentions.some(country => countries.includes(country)));
      const selection = buildIntelNewsSelection({...selectionOptions, articles:visibleCandidates});
      const financialSelection = buildFinancialNewsSelection({articles:financial, now:new Date(now), candidateWindowHours:hours, analyzeLimit, displayLimit,reuseClassification:true});
      const marketSignalCorpus = [...new Map([...geo, ...financialSelection.signalCorpus].map(article => [article.id,article])).values()];
      return { signalCorpus:geo, marketSignalCorpus, news:selection.displaySelection, displayCandidates, selectionMeta:selection.selectionMeta, financialSelection,
        riskResult:risk.finish(),
        meta:{ source:"sqlite", revision, asOf, from, to:asOf, dayStart, dayTimeZone:this.config.dayTimeZone || "Europe/Madrid", windowHours:hours, scannedCount:scanned, eligibleCount:eligible, duplicateCount, dailyCandidateCount:dailyCount, displayCandidateCount, geopoliticalCandidateCount:geoCount, financialCandidateCount:financialCount, analysisCount:geo.length, marketAnalysisCount:marketSignalCorpus.length, displayCount:selection.displaySelection.length, analyzeLimit, displayLimit, analysisTruncated:geoCount>geo.length || financialCount>financialSelection.signalCorpus.length, riskUsesAllDailyCandidates:true, providerCounts, sourceCount:sources.size, lastIngestAt:this.archive.lastIngestAt, latestGeopoliticalPublishedAt, durationMs:Math.round(performance.now()-started) } };
    } finally { reader.close(); }
  }

  async getLiveFeed({countries=this.config.watchlistCountries || [],sources=[],limit=this.config.displayLimit || 40}={}) {
    const corpus=await this.read({countries,sources,awarenessMode:this.config.awarenessMode || "off"});
    const articles=filterNewsBySources(corpus.displayCandidates.filter(article=>!countries.length || article.countryMentions.some(country=>countries.includes(country))),sources);
    const selection=buildIntelNewsSelection({articles,watchlistCountries:countries,now:new Date(corpus.meta.asOf),candidateWindowHours:this.config.candidateWindowHours || 36,analyzeLimit:this.config.analyzeLimit || 3000,displayLimit:positive(limit,40,200),maxPerSource:this.config.maxPerSource || 3,maxSimilarHeadline:this.config.maxSimilarHeadline || 1,ensureCountryCoverage:true,fillAvailable:true});
    return {news:selection.displaySelection,meta:{...corpus.meta,filteredDailyCandidateCount:corpus.meta.displayCandidateCount,displayCount:selection.displaySelection.length}};
  }

  async getFeed({countries=[], topic="", threat="", limit=120, offset=0, paginate=false,page=1,windowHours, rssOnly=false, awarenessMode=this.config.awarenessMode || "off"} = {}) {
    const corpus = await this.read({windowHours, countries:this.config.watchlistCountries || [], awarenessMode});
    const candidates = (rssOnly ? corpus.marketSignalCorpus.filter(article => article.provider === "rss" || article.provider === "rss-aggregate") : corpus.marketSignalCorpus).map(article=>({...classifyRssArticle(article),countryMentions:article.countryMentions}));
    const items = candidates.filter(article => (!countries.length || article.countryMentions.some(country => countries.includes(country))) && (!topic || article.topicTags?.includes(topic)) && (!threat || article.threatLevel===threat));
    const count=positive(limit,120,10000),totalPages=Math.max(1,Math.ceil(items.length/count)),currentPage=Math.min(Math.max(1,Number(page) || 1),totalPages);
    const start=paginate ? (currentPage-1)*count : Math.max(0,Number(offset) || 0),selected=items.slice(start,start+count);
    return {generatedAt:corpus.meta.asOf, items:selected, ...(paginate ? {pagination:{page:currentPage,pageSize:count,totalPages,totalItems:items.length}} : {}),meta:{...corpus.meta, provider:"sqlite-news", totalItems:items.length, filteredCount:selected.length, stored:true}};
  }
}

export function riskWithPrevious(riskResult, previousCountries = {}) {
  const result = structuredClone(riskResult);
  for (const country of Object.values(result.countries)) country.trend=classifyTrend(country.score-(previousCountries[country.iso2]?.score || 0));
  return result;
}
