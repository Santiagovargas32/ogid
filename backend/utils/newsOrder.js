import {createHash} from 'node:crypto';
const ranks={critical:4,elevated:3,monitoring:2,low:1,unknown:0};
export function compareNews(a,b,order='critical'){
  const severity=(ranks[b.threatLevel]||0)-(ranks[a.threatLevel]||0);
  const score=(Number.isFinite(b.analysisScore)?b.analysisScore:0)-(Number.isFinite(a.analysisScore)?a.analysisScore:0);
  const date=(Date.parse(b.publishedAt)||0)-(Date.parse(a.publishedAt)||0);
  return (order==='recent'?date||severity||score:severity||score||date) || String(a.identity||a.id||a.url||'').localeCompare(String(b.identity||b.id||b.url||''));
}
export function newsRevision(news){return createHash('sha256').update(JSON.stringify(news.map(a=>[a.identity||a.id,a.title,a.excerpt,a.publishedAt,a.updatedAt,a.threatLevel,a.analysisScore,a.publisherId,a.publisher,a.publisherResolution,a.transportProvider,a.discoverySourceId,a.originChainId,a.classification,a.provenance?.stale||false]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))))).digest('hex').slice(0,24);}
