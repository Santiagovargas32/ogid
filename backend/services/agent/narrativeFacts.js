import { numericDescriptor } from './numericSemantics.js';

export const NARRATIVE_PROMPT_VERSION = 'ogid-analyst-v1.13';
export const NARRATIVE_CONTRACT_VERSION = 'typed-narrative-facts-v3';
export const usesNarrativeFacts = job => ['ogid-analyst-v1.12',NARRATIVE_PROMPT_VERSION].includes(job.promptVersion);
const boundedText = { type: 'string', minLength: 1, maxLength: 256 };
export const narrativeFactsSchema = {
  type: 'array', maxItems: 100,
  items: {
    type: 'object', additionalProperties: false,
    required: ['kind', 'field', 'literal', 'evidenceId', 'path'],
    properties: {
      kind: { enum: ['technical', 'reported-quantity', 'date', 'edition', 'coverage'] },
      field: { ...boundedText, pattern: '^/' }, literal: boundedText,
      evidenceId: boundedText, path: boundedText,
      quote: { type: 'string', minLength: 1, maxLength: 2000 },
    },
  },
};
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const read = (data, path) => path.split('.').reduce((v, k) =>
  !forbidden.has(k) && v && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined, data);
const numericTokens = text => [...text.matchAll(/(?<![\p{L}\d])[-+]?\d+(?:[.,]\d+)?(?:e[-+]?\d+)?/giu)];
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sourceDomains = new Set(['news', 'news-reference', 'geopolitical-alert', 'situation-source']);
const sourcePaths = new Set(['title', 'excerpt', 'description', 'summary', 'text']);
const datePaths = new Set(['publishedAt', 'knownAt', 'occurredAt', 'receivedAt']);
const contextField = field => /^\/(limitations|missingEvidence)\/\d+$/.test(field);
const metricLabels = /fuerza relativa|relative strength|\bRSI\b|\bSMA(?:20|50|200)?\b|\bEMA\b|\bMACD\b|\bATR\b|precio|price|soporte|support|resistencia|resistance|volatilidad|volatility/giu;
function metricPath(label) {
  if (/fuerza relativa|relative strength/i.test(label)) return 'indicators.relativeStrength';
  if (/precio|price/i.test(label)) return 'observed.close';
  if (/soporte|support|resistencia|resistance/i.test(label)) return 'indicators.levels';
  if (/volatilidad|volatility/i.test(label)) return 'indicators.volatility';
  return 'indicators.' + label.toLowerCase();
}

// Explicitly enumerate human-facing prose. IDs, schema names, structured dates
// and method labels never enter the numeric scanner.
export function narrativeFields(value) {
  const fields = new Map(), global = value.evidenceIds || [];
  const add = (field, text, refs = global, horizon = value.horizonHours, kind) => {
    if (typeof text === 'string') fields.set(field, { text, refs, horizon, kind });
  };
  add('/summary', value.summary);
  for (const key of ['limitations', 'missingEvidence', 'invalidation', 'alternatives', 'contradictions'])
    (value[key] || []).forEach((row, i) => { if (typeof row === 'string') add(`/${key}/${i}`, row); });
  for (const key of ['drivers', 'scenarios', 'alertAssessments', 'intradayScenarios', 'synthesis', 'timeline', 'changes', 'impacts', 'contradictions'])
    (value[key] || []).forEach((row, i) => {
      if (!row || typeof row !== 'object') return;
      const refs = row.evidenceIds || global;
      const horizon = key === 'intradayScenarios' ? row.horizonMinutes / 60 : value.horizonHours;
      for (const name of ['text', 'description', 'summary', 'mechanism', 'confirmation', 'invalidation']) {
        if (Array.isArray(row[name])) row[name].forEach((text, j) => add(`/${key}/${i}/${name}/${j}`, text, refs, horizon, row.kind));
        else add(`/${key}/${i}/${name}`, row[name], refs, horizon, row.kind);
      }
    });
  return fields;
}

export function narrativeProblem(value, items, { snapshot = {}, job = {} } = {}) {
  const fields = narrativeFields(value), facts = value.narrativeFacts || [];
  const fail = (reason, fact = {}) => ({ code: 'AGENT_UNVERIFIED_NUMBER', reason,
    ...Object.fromEntries(['field', 'kind', 'evidenceId', 'path'].filter(k => typeof fact[k] === 'string').map(k => [k, fact[k].slice(0, 256)])) });
  const spans = new Map([...fields.keys()].map(key => [key, []]));
  for (const fact of facts) {
    const field = fields.get(fact.field), item = items.get(fact.evidenceId);
    if (!field || !field.text.includes(fact.literal) || !numericTokens(fact.literal).length) return fail('invalid-narrative-reference', fact);
    if (!item || !field.refs.includes(fact.evidenceId)) return fail('field-evidence-required', fact);
    const snapshotPath = fact.kind === 'coverage' && item.domain === 'coverage' && fact.path.startsWith('$snapshot.coverage.');
    const raw = snapshotPath ? read(snapshot.coverage, fact.path.slice('$snapshot.coverage.'.length)) : read(item.data, fact.path);
    if (fact.kind === 'technical') {
      const technical = value.technicalFacts.find(f => f.evidenceId === fact.evidenceId && f.path === fact.path);
      const descriptor = numericDescriptor(item.data, fact.path);
      if (!['technical.get', 'indicators.calculate'].includes(item.domain) || !technical || !descriptor.eligible ||
        fact.literal !== String(technical.value) || technical.value !== raw || technical.unit !== descriptor.unit)
        return fail('eligible-technical-fact-required', fact);
      if (job.task === 'instrument_outlook' && item.data.instrumentId !== job.scope) return fail('instrument-mismatch', fact);
      if (descriptor.asOf && (!Number.isFinite(Date.parse(descriptor.asOf)) || Date.parse(descriptor.asOf) > Date.parse(snapshot.asOf))) return fail('future-observation', fact);
      const interval = fact.field.match(/^\/intradayScenarios\/(\d+)\//)?.[1];
      if (interval !== undefined && item.data.interval !== value.intradayScenarios[Number(interval)].interval) return fail('interval-mismatch', fact);
      let matched = false;
      for (const token of numericTokens(field.text).filter(t => t[0] === fact.literal)) {
        const prefix = field.text.slice(0, token.index).split(/[;!?\n]/u).at(-1);
        const label = [...prefix.matchAll(metricLabels)].at(-1);
        if (label && prefix.length - label.index < 96 && !fact.path.startsWith(metricPath(label[0]))) continue;
        const suffix = field.text.slice(token.index + token[0].length);
        const currency = suffix.match(/^\s*(USD|EUR|GBP|JPY|CHF|CAD|AUD)\b/)?.[1];
        if (/^\s*%/.test(suffix) || currency && currency !== descriptor.unit) continue;
        matched = true;spans.get(fact.field).push([token.index,token.index+token[0].length]);
      }
      if (!matched) return fail('metric-or-unit-mismatch', fact);
      continue;
    } else if (fact.kind === 'coverage') {
      const descriptor = numericDescriptor(item.data, fact.path);
      if (!contextField(fact.field) || typeof raw !== 'number' || !Number.isFinite(raw) || fact.literal !== String(raw) ||
        !(item.domain === 'coverage' || ['technical.get', 'indicators.calculate'].includes(item.domain) && ['coverage', 'parameter', 'requirement'].includes(descriptor.role)))
        return fail('coverage-context-only', fact);
    } else {
      if (!sourceDomains.has(item.domain) || typeof raw !== 'string') return fail('source-text-required', fact);
      if (fact.kind === 'date') {
        if (!datePaths.has(fact.path) || fact.literal !== raw || !Number.isFinite(Date.parse(raw)) || Date.parse(raw) > Date.parse(snapshot.asOf)) return fail('exact-source-date-required', fact);
      } else if (!sourcePaths.has(fact.path)) return fail('source-text-path-required', fact);
      if (!fact.quote || !raw.includes(fact.quote) || !fact.quote.includes(fact.literal)) return fail('exact-source-quote-required', fact);
      // A declared kind alone cannot turn an unqualified statement into an
      // attributed report. The literal wrapper is shared with the prompt/UI.
      const attributed = `Según la fuente [evidence:${fact.evidenceId}]: «${fact.quote}»`;
      if (!field.text.includes(attributed) || field.kind && field.kind !== 'attributed-report') return fail('explicit-source-attribution-required', fact);
      if (!numericTokens(fact.quote).some(t => t[0] === fact.literal) && fact.kind !== 'date') return fail('exact-source-token-required', fact);
      for (let at = field.text.indexOf(attributed); at !== -1; at = field.text.indexOf(attributed, at + attributed.length))
        spans.get(fact.field).push([at, at + attributed.length]);
      continue;
    }
    for (const match of numericTokens(field.text).filter(token => token[0] === fact.literal))
      spans.get(fact.field).push([match.index, match.index + match[0].length]);
  }
  const opaque = [...items.keys(), snapshot.snapshotId, ...(snapshot.coverage?.selectedInstrumentIds || [])]
    .filter(id => typeof id === 'string' && id.length >= 8 && /\D/.test(id));
  for (const [field, row] of fields) {
    const ranges = spans.get(field);
    for (const cite of row.text.matchAll(/\[evidence:([^\]\s]+)\]/g)) {
      if (!items.has(cite[1]) || !row.refs.includes(cite[1])) return { code: 'AGENT_UNKNOWN_EVIDENCE', field, evidenceId: cite[1].slice(0, 256), reason: 'invalid-narrative-citation' };
      ranges.push([cite.index, cite.index + cite[0].length]);
    }
    for (const id of opaque) for (const match of row.text.matchAll(new RegExp(`(?<![\\p{L}\\d._:-])${escape(id)}(?![\\p{L}\\d_:-]|\\.[\\p{L}\\d_:-])`, 'gu')))
      ranges.push([match.index, match.index + match[0].length]);
    for (const token of numericTokens(row.text)) {
      if (ranges.some(([from, to]) => token.index >= from && token.index + token[0].length <= to)) continue;
      const suffix = row.text.slice(token.index + token[0].length).match(/^\s*(horas?|hours?|h\b|minutos?|minutes?|min\b)/i)?.[1];
      const number = Number(token[0].replace(',', '.'));
      if (suffix && Number.isFinite(row.horizon) && (/^min/i.test(suffix) ? number / 60 : number) === row.horizon) continue;
      const technicalOptions=(value.technicalFacts||[]).filter(f=>{
        const item=items.get(f.evidenceId),d=item&&numericDescriptor(item.data,f.path);
        return row.refs.includes(f.evidenceId)&&['technical.get','indicators.calculate'].includes(item?.domain)&&d.eligible&&d.value===f.value&&d.unit===f.unit;
      }).slice(0,4).map(({evidenceId,path,value,unit})=>({evidenceId,path,value,unit}));
      return { ...fail('unverified-numeric-narrative', { field }), providedValue: number,technicalOptions };
    }
  }
  return null;
}

export function narrativeCoverageExample(snapshot){
  const count=snapshot.coverage?.domains?.news?.count;
  if(!Number.isSafeInteger(count)||count<0)return null;
  return {limitations:[`El corte seleccionado contiene ${count} noticias; este conteo no es una señal financiera.`],narrativeFacts:[{kind:'coverage',field:'/limitations/0',literal:String(count),evidenceId:`coverage:${snapshot.snapshotId}`,path:'$snapshot.coverage.domains.news.count'}]};
}

export const NARRATIVE_INSTRUCTIONS = `Contrato typed-narrative-facts-v3. Incluye SIEMPRE technicalFacts y narrativeFacts, también cuando sean []. Si no necesitas cifras, evita cifras en la prosa. Cada cifra narrativa necesita un narrativeFact {kind,field,literal,evidenceId,path}; field es un JSON pointer exacto como /summary o /drivers/0/description y path es relativo a data. kind=technical enlaza un technicalFact elegible con valor y unidad exactos: literal=String(value), sin redondeos ni porcentajes; el indicador nombrado debe coincidir con la ruta. kind=coverage sólo en /limitations/N o /missingEvidence/N, con el valor exacto de coverage o metodología técnica; para conteos del manifiesto usa el evidenceId de coverage y path=$snapshot.coverage.domains.news.count o la ruta exacta del manifiesto. No confundas la lista de estados de fuentes con esos conteos. Para cantidades relatadas o ediciones usa kind=reported-quantity o edition y quote copiado literalmente de title/excerpt/description/summary/text; escribe exactamente Según la fuente [evidence:ID]: «FRAGMENTO» en ese campo y copia la cifra en literal. Ese relato no es un hecho confirmado ni una observación financiera. kind=date exige un timestamp exacto del campo publishedAt/knownAt/occurredAt/receivedAt y el mismo formato atribuido; nunca deduzcas occurredAt. Las citas deben pertenecer a las referencias del campo. IDs y horizontes estructurados no son mediciones. No uses cobertura, requisitos o citas textuales para habilitar una dirección financiera. probability=null.`;
