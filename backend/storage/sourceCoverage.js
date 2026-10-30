import {publisherEdition} from '../services/news/sourceAssessments.js';
import {NEWS_SOURCE_CATALOG} from '../services/news/newsSourceCatalog.js';
import {AppError} from '../utils/error.js';
import {pilotCoverage} from './pilotCoverage.js';

export function saveEditorialFacet(db,article) {
  const countries=JSON.stringify([...new Set((article.countryMentions||[]).filter(c=>/^[A-Z]{2}$/.test(c)))].sort().slice(0,250));
  db.prepare(`INSERT INTO news_editorial_facets VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(article_id) DO UPDATE SET article_revision=excluded.article_revision,received_at=excluded.received_at,publisher_id=excluded.publisher_id,edition=excluded.edition,language=excluded.language,origin_chain_id=excluded.origin_chain_id,country_mentions_json=excluded.country_mentions_json WHERE article_revision IS NOT excluded.article_revision OR received_at IS NOT excluded.received_at OR publisher_id IS NOT excluded.publisher_id OR edition IS NOT excluded.edition OR language IS NOT excluded.language OR origin_chain_id IS NOT excluded.origin_chain_id OR country_mentions_json IS NOT excluded.country_mentions_json`)
    .run(article.id,article.revision,article.receivedAt,article.publisherResolution?.status==='resolved'?article.publisherId:null,publisherEdition(article),article.classification?.language||null,article.originChainId||null,countries);
}

export function sourceCoverage(db,assessments,input={}) {
  const end=new Date(input.to||assessments.now()),start=new Date(input.from||end.getTime()-86400000);
  if(!Number.isFinite(end.getTime())||!Number.isFinite(start.getTime())||end<start||end-start>31*86400000)throw new AppError('Ventana de cobertura inválida; máximo 31 días.',400,'SOURCE_COVERAGE_INVALID_WINDOW');
  const from=start.toISOString(),to=end.toISOString(),cut=assessments.cut({asOf:to,knownAt:input.knownAt||to});
  return db.transaction(()=>{
    const revision=assessments.revision();
    const totals=db.prepare('SELECT count(*) AS articles FROM articles WHERE received_at>=? AND received_at<=?').get(from,to);
    const facets=db.prepare('SELECT count(*) AS projected,coalesce(sum(publisher_id IS NOT NULL),0) AS resolvedPublisherArticles,count(DISTINCT publisher_id) AS publishers,count(DISTINCT origin_chain_id) AS knownOriginChains,coalesce(sum(origin_chain_id IS NULL),0) AS unknownOriginArticles FROM news_editorial_facets WHERE received_at>=? AND received_at<=?').get(from,to);
    const groups=db.prepare('SELECT publisher_id AS publisherId,edition,count(*) AS articles,max(received_at) AS lastReceivedAt FROM news_editorial_facets WHERE received_at>=? AND received_at<=? GROUP BY publisher_id,edition ORDER BY articles DESC,publisher_id,edition').all(from,to);
    const languages=db.prepare("SELECT coalesce(language,'unknown') AS language,count(*) AS articles FROM news_editorial_facets WHERE received_at>=? AND received_at<=? GROUP BY language ORDER BY articles DESC,language LIMIT 101").all(from,to);
    const mentionedCountries=db.prepare('SELECT value AS country,count(*) AS articles FROM news_editorial_facets,json_each(country_mentions_json) WHERE received_at>=? AND received_at<=? GROUP BY value ORDER BY articles DESC,value LIMIT 101').all(from,to);
    const configuredLanguages=[...new Set(NEWS_SOURCE_CATALOG.entries.flatMap(e=>e.languages))].map(language=>({language,entries:NEWS_SOURCE_CATALOG.entries.filter(e=>e.languages.includes(language)).length}));
    const plannedRegions=[{region:'Ucrania / mar Negro',terms:['Ukraine','Russia','Black Sea']},{region:'mar Rojo',terms:['Red Sea','Yemen']}].map(({region,terms})=>({region,configuredQueries:NEWS_SOURCE_CATALOG.entries.filter(e=>e.type==='generated_search'&&e.countries.some(c=>terms.includes(c))).length,reportingCoverage:'not-established'}));
    const pending=Math.max(0,totals.articles-facets.projected);
    facets.unknownOriginArticles+=pending;
    const countries=new Map(),owners=new Set();let unknownOwnerArticles=pending,unknownEditorialCountryArticles=pending,unratedPublishers=0;
    const publishers=groups.map(group=>{
      const view=group.publisherId&&group.edition?assessments.view(group.publisherId,group.edition,cut,revision,input.politicalScope):null;
      const profile=view?.profile;
      if(profile?.ownerGroupId)owners.add(profile.ownerGroupId);else unknownOwnerArticles+=group.articles;
      if(profile?.editorialCountries.length)for(const country of profile.editorialCountries)countries.set(country,(countries.get(country)||0)+group.articles);else unknownEditorialCountryArticles+=group.articles;
      if(group.publisherId&&view?.status!=='rated'&&view?.status!=='not-applicable')unratedPublishers++;
      return {...group,name:view?.name||'Editor sin resolver',assessmentStatus:view?.status||'unresolved',rating:view?.rating||null,ownerGroupId:profile?.ownerGroupId||null};
    });
    const partial=facets.projected!==totals.articles||languages.length>100||mentionedCountries.length>100;
    const data={methodVersion:'source-coverage-v1',window:{from,to,timeField:'receivedAt'},...cut,revision,
      summary:{...totals,...facets,unknownPublisherArticles:totals.articles-facets.resolvedPublisherArticles,ownerGroups:owners.size,unknownOwnerArticles,unknownEditorialCountryArticles,unratedPublisherEditions:unratedPublishers},
      publishers,languages:languages.slice(0,100),mentionedCountries:mentionedCountries.slice(0,100),editorialCountries:[...countries].map(([country,articles])=>({country,articles})),
      catalogue:{entries:NEWS_SOURCE_CATALOG.entries.length,enabledEntries:NEWS_SOURCE_CATALOG.entries.filter(e=>e.enabled).length,generatedSearches:NEWS_SOURCE_CATALOG.entries.filter(e=>e.type==='generated_search').length,operationalHealth:'unknown-here'},
      configuredLanguages,plannedRegions,pilots:pilotCoverage(db,{from,to,now:assessments.now()}),
      coverage:{partial,pendingFacetArticles:pending,languageGroupsPartial:languages.length>100,countryGroupsPartial:mentionedCountries.length>100,metadataBasis:'current derived editorial metadata; not a historical metadata snapshot'},
      meaning:'Collected archive before editorial selection. Queries are not publishers; owners and origin identifiers are not independent corroboration. Editorial countries are not incident locations.'};
    const payload={ok:true,queriedAt:new Date().toISOString(),origin:'OGID',data,warnings:[],truncated:false};
    if(Buffer.byteLength(JSON.stringify({structuredContent:payload,content:[{type:'text',text:JSON.stringify(payload)}]}))>Math.max(4096,Math.min(262144,Number(input.maxBytes)||65536)))throw new AppError('La cobertura excede el presupuesto; reducir la ventana.',413,'SOURCE_COVERAGE_OUTPUT_TOO_LARGE');
    return data;
  }).deferred();
}
