import {createHash} from 'node:crypto';
import {classifyNews,extractNewsCountries,normalizeNewsText} from './newsClassification.js';
import {safeUrl,cleanText} from '../../utils/researchProjection.js';
export const COMPARISON_METHOD='coverage-claims-v1';
export const comparisonHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const PLACES=[
  ['kyiv','UA',['kyiv','kiev','kiew']],['odesa','UA',['odesa','odessa']],['kharkiv','UA',['kharkiv','kharkov','jarkov','charkiw']],
  ['gaza','PS',['gaza']],['jerusalem','IL',['jerusalem','jerusalen','jerusalem']],['tel-aviv','IL',['tel aviv']],
  ['sanaa','YE',['sanaa','sana a']],['hodeidah','YE',['hodeidah','hudaida']],['aden','YE',['aden']],
  ['moscow','RU',['moscow','moscu','moscou','moskau','moscou']],['beirut','LB',['beirut','beyrouth']],
  ['red-sea',null,['red sea','mar rojo','mer rouge','rotes meer','mar vermelho']],
  ['black-sea',null,['black sea','mar negro','mer noire','schwarzes meer']]
];
const TYPES=[
  ['labor-strike',['workers strike','labor strike','union strike','huelga','greve','streik']],
  ['military-attack',['missile strike','airstrike','missile attack','drone attack','ataque con misiles','ataque aereo','ataque militar','frappe de missiles','frappe aerienne','raketenangriff','luftangriff','ataque com misseis']],
  ['explosion',['explosion','explosions','explosao','explosoes','explosionen']],
  ['ceasefire',['ceasefire','alto el fuego','cessez le feu','waffenruhe','cessar fogo']],
  ['sanctions',['sanctions','sanciones','sanktionen','sancoes']],
  ['earthquake',['earthquake','terremoto','seisme','erdbeben']],
  ['cyberattack',['cyberattack','ciberataque','cyberattaque','cyberangriff']]
];
const has=(text,term)=>` ${text} `.includes(` ${normalizeNewsText(term)} `);
export function comparisonFacts(article){
  const headlineOnly=[article.usagePolicy,article.usagePolicy?.contentPolicy,article.usagePolicy?.mode,article.provenance?.contentPolicy].includes('headline-only-link-out');
  const title=cleanText(article.title,512)||'',excerpt=headlineOnly?'':cleanText(article.excerpt,1000)||'';
  const text=[title,excerpt].filter(Boolean).join(' '),normalized=normalizeNewsText(text);
  const {classification}=classifyNews({text,language:article.classification?.language||article.language,textScope:excerpt?'permitted-text':'headline'});
  const locations=PLACES.filter(([, ,aliases])=>aliases.some(alias=>has(normalized,alias))).map(([id,country])=>({id,country,method:'exact-place-alias-v1'}));
  const eventType=TYPES.find(([,terms])=>terms.some(term=>has(normalized,term)))?.[0]||null;
  const entities=extractNewsCountries(text,article.countryMentions||[]).sort();
  const dates=[...new Set(text.match(/\b20\d{2}(?:-\d{2}-\d{2})?\b/g)||[])].sort();
  const effectiveAt=article.publishedAt||article.receivedAt;
  const eligible=classification.status==='evaluated'&&locations.length===1&&Boolean(eventType)&&Number.isFinite(Date.parse(article.publishedAt));
  const signature=eligible?[eventType,locations[0].id,dates.join(',')||'publication-window'].join('|'):null;
  const facts={articleId:article.id,articleRevision:article.revision,title,url:safeUrl(article.url),publishedAt:article.publishedAt||null,receivedAt:article.receivedAt,effectiveAt,timeBasis:article.publishedAt?'publication':'reception-fallback',publisherId:article.publisherResolution?.status==='resolved'?article.publisherId:null,originChainId:article.originChainId||null,language:classification.language,classificationStatus:classification.status,modality:classification.modality,textScope:classification.textScope,entities,locations,eventType,temporalHints:dates,signature,groupingStatus:eligible?'candidate-related-coverage':'insufficient-context',methodVersion:COMPARISON_METHOD};
  const spans=[{scope:'headline',text:title},...(excerpt?[{scope:'excerpt',text:excerpt}]:[])];
  const claims=spans.filter(s=>s.text.trim()).map((span,ordinal)=>{
    const {classification:c}=classifyNews({text:span.text,language:classification.language,textScope:span.scope});
    return {claimId:`claim-${comparisonHash([article.id,article.revision,ordinal,span.text,COMPARISON_METHOD]).slice(0,32)}`,articleId:article.id,articleRevision:article.revision,ordinal,text:span.text,textScope:span.scope,modality:c.modality,classificationStatus:c.status,language:c.language,conceptKey:signature,attributedTo:{kind:'publication',publisherId:facts.publisherId,articleId:article.id},evidence:{articleId:article.id,articleRevision:article.revision,url:facts.url,textHash:comparisonHash(span.text)},methodVersion:COMPARISON_METHOD,verification:'attributed-publication; occurrence-not-verified'};
  });
  return {...facts,claimIds:claims.map(c=>c.claimId),claims};
}
export function comparisonHints(claims){
  const result=[];
  for(let i=0;i<claims.length;i++)for(let j=i+1;j<claims.length;j++){
    const a=claims[i],b=claims[j];
    if(a.articleId===b.articleId||!a.conceptKey||a.conceptKey!==b.conceptKey||![a.modality,b.modality].every(m=>['reported','negated'].includes(m)))continue;
    if(result.length>=100)return {items:result,partial:true};
    result.push({leftClaimId:a.claimId,rightClaimId:b.claimId,relation:a.modality===b.modality?'compatible-reports':'possible-contradiction',method:'shared-context-and-modality-v1',meaning:'textual candidate; not verification or independent corroboration'});
  }
  return {items:result,partial:false};
}
