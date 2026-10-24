export const NUMERIC_CONTRACT_VERSION='numeric-semantics-v2';
const read=(data,path)=>path.split('.').reduce((v,k)=>v&&typeof v==='object'&&Object.hasOwn(v,k)?v[k]:undefined,data);
const price=['sma','ema','sma20','sma50','sma200','atr','atr14Simple','atr14Wilder','vwapApprox'];
const fractions=['simpleReturn','logarithmicReturn','volumeChange','relativeReturn','relativeStrength'];
const scalars=[...price,...fractions,'relativeVolume','rsi','realizedVolatility','volatility'];
export function numericDescriptor(data,path) {
  const value=read(data,path),currency=data.quality?.currency||data.currency||'price';
  let role=null,unit=null,indicator=null;
  if(path==='observed.close'){role='observation';unit=currency;}
  if(path==='observed.volume'){role='observation';unit='volume';}
  for(const name of scalars){
    const root=`indicators.${name}`;
    if(path===`${root}.value`){role='indicator';indicator=read(data,root);unit=price.includes(name)?currency:fractions.includes(name)?'return-fraction':name==='relativeVolume'?'ratio':name==='rsi'?'index-points':'log-return-standard-deviation-per-bar';}
    if(['sma20','sma50','sma200'].includes(name)&&['distanceFraction','slopePerBar'].some(k=>path===`${root}.${k}`)){role='indicator';indicator=read(data,root);unit=path.endsWith('distanceFraction')?'return-fraction':`${currency}/bar`;}
  }
  for(const [name,leaves] of [['macd',['macd','signal','histogram']],['bollinger',['lower','middle','upper']],['levels',['support','resistance']]])
    if(leaves.some(k=>path===`indicators.${name}.value.${k}`)){role='indicator';indicator=read(data,`indicators.${name}`);unit=currency;}
  if(path==='indicators.volatility.annualized'){role='indicator';indicator=data.indicators?.volatility;unit='annualized-log-return-standard-deviation';}
  if(/^warmup\.(sma200|rsi14|macd12269|atr14|relativeStrength)$/.test(path)){role='requirement';unit='bars';}
  if(/^parameters\.(smaPeriod|emaPeriod|rsiPeriod|macdFast|macdSlow|macdSignal|bollingerPeriod|bollingerStdDev|atrPeriod|volatilityPeriod|slopeWindow|levelsWindow|smaPeriods\.\d+|macd\.\d+|bollinger\.\d+)$/.test(path)){role='parameter';unit='method-parameter';}
  if(path==='sampleSize'||/^indicators\.[A-Za-z0-9]+\.sampleSize$/.test(path)){role='coverage';unit='bars';}
  if(/^indicators\.[A-Za-z0-9]+\.(window|slopeWindow|annualizationFactor)$/.test(path)){role='parameter';unit='method-parameter';}
  const number=typeof value==='number'&&Number.isFinite(value);
  let reason=!role?'unregistered-numeric-path':!number?'measurement-unavailable':!['observation','indicator'].includes(role)?'methodology-only':null;
  if(data.numericSemantics?.version&&data.numericSemantics.version!==NUMERIC_CONTRACT_VERSION)reason='unknown-numeric-contract';
  if(data.methodVersion&&!['technical-context-v1','technical-indicators-v2'].includes(data.methodVersion))reason='unknown-technical-method';
  if(role==='indicator'&&(indicator?.reason||indicator?.value==null||data.quality?.reason||data.quality?.gapDetected))reason=indicator?.reason||data.quality?.reason||'indicator-ineligible';
  if(['observation','indicator'].includes(role)&&(data.quality?.synthetic||data.quality?.stale))reason='evidence-quality-ineligible';
  return {path,type:'number',value:number?value:null,role:role||'unknown',unit,eligible:reason===null,reason,asOf:data.lastClosedCandleAt||data.lastCandleAt||data.observed?.asOf||null,dependencies:{seriesRevision:data.seriesRevision||null,methodVersion:data.methodVersion||null,benchmarkInstrumentId:data.benchmarkInstrumentId||null}};
}
export function numericNarrativeProblem(value,items) {
  const texts=[value.summary,...(value.drivers||[]).map(d=>d.description),...(value.scenarios||[]).map(s=>s.description),...(value.intradayScenarios||[]).map(s=>s.summary)];
  for(const text of texts.filter(t=>typeof t==='string'))for(const token of text.matchAll(/(?<![\p{L}\d])[-+]?\d+(?:[.,]\d+)?(?:e[-+]?\d+)?/giu)){
    const number=Number(token[0].replace(',','.')),suffix=text.slice(token.index+token[0].length).match(/^\s*(horas?|hours?|h\b|minutos?|minutes?|min\b)/i)?.[1];
    const horizons=[value.horizonHours,...(value.intradayScenarios||[]).map(s=>s.horizonMinutes/60)].filter(Number.isFinite);
    if(suffix&&horizons.includes(/^min/i.test(suffix)?number/60:number))continue;
    if(!value.technicalFacts.some(f=>f.value===number&&items.has(f.evidenceId)&&numericDescriptor(items.get(f.evidenceId).data,f.path).eligible))return {code:'AGENT_UNVERIFIED_NUMBER',reason:'unverified-numeric-narrative',providedValue:number};
  }
  const metrics=[[/fuerza relativa|relative strength/i,'relativeStrength'],[/\bRSI\b/i,'rsi'],[/\bSMA(?:20|50|200)?\b/i,'sma'],[/\bEMA\b/i,'ema'],[/\bMACD\b/i,'macd'],[/\bATR\b/i,'atr'],[/precio|price/i,'observed.close'],[/soporte|support|resistencia|resistance/i,'levels'],[/volatilidad|volatility/i,'volatility']];
  for(const text of texts.filter(t=>typeof t==='string'))for(const [pattern,path] of metrics){
    if(!pattern.test(text))continue;
    const numbers=[...text.matchAll(/(?<![\p{L}\d])[-+]?\d+(?:[.,]\d+)?(?:e[-+]?\d+)?/giu)].map(m=>Number(m[0].replace(',','.')));
    for(const n of numbers){
      const supported=value.technicalFacts.some(f=>f.value===n&&f.path.toLowerCase().includes(path.toLowerCase())&&items.has(f.evidenceId)&&numericDescriptor(items.get(f.evidenceId).data,f.path).eligible);
      if(!supported)return {code:'AGENT_UNVERIFIED_NUMBER',reason:'unverified-numeric-narrative',providedValue:n};
    }
  }
  return null;
}
