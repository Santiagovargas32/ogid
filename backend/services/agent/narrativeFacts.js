import { numericDescriptor } from './numericSemantics.js';
import { publisherByAlias } from '../news/publisherIdentity.js';

export const NARRATIVE_PROMPT_VERSION = 'ogid-analyst-v1.17';
export const NARRATIVE_CONTRACT_VERSION = 'typed-narrative-facts-v4';
export const usesNarrativeFacts = job => ['ogid-analyst-v1.12','ogid-analyst-v1.13','ogid-analyst-v1.14','ogid-analyst-v1.15','ogid-analyst-v1.16',NARRATIVE_PROMPT_VERSION].includes(job.promptVersion);
const boundedText = { type: 'string', minLength: 1, maxLength: 256 };
export const narrativeFactsSchema = {
  type: 'array', maxItems: 100,
  items: {
    type: 'object', additionalProperties: false,
    required: ['kind', 'field', 'literal', 'evidenceId', 'path'],
    properties: {
      kind: { enum: ['technical', 'reported-quantity', 'date', 'edition', 'coverage'] },
      field: { ...boundedText, pattern: '^/', description:'JSON pointer del texto de TU respuesta, por ejemplo /summary. Nunca /title ni una ruta del snapshot.' }, literal: {...boundedText,description:'Sólo el literal numérico presente en ese texto; para date, timestamp exacto. Nunca el título completo de una fuente.'},
      evidenceId: boundedText, path: {...boundedText,description:'Ruta del valor dentro de data, por ejemplo title o observed.close; nunca data ni una ruta de TU respuesta.'},
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
// A registry publisher's name is an identity, not a reported magnitude. Only
// names bound to this field's frozen source references qualify; arbitrary
// source strings and numbers following the name remain subject to grounding.
function publisherSpans(row, items) {
  const spans=[];
  for (const id of row.refs) {
    const item=items.get(id);
    if (!item || !sourceDomains.has(item.domain)) continue;
    const data=item.data || {}, publisher=publisherByAlias(data.publisher || data.publisherResolution?.candidateName || data.sourceName);
    if (!publisher) continue;
    for (const name of [publisher.name,...publisher.aliases].filter(name=>/\d/u.test(name))) {
      const pattern=name.split(/\s+/u).map(escape).join('\\s+');
      for (const match of row.text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`,'giu')))
        spans.push([match.index,match.index+match[0].length]);
    }
  }
  return spans;
}
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
  const sourceFailure = (reason, fact, raw) => {
    const problem=fail(reason,fact),at=raw.indexOf(fact.literal);
    if(at<0 || !numericTokens(fact.literal).length)return problem;
    const exact=fact.quote && raw.includes(fact.quote) && fact.quote.includes(fact.literal);
    const quote=exact && fact.quote.length<=512 ? fact.quote : raw.slice(Math.max(0,at-120),at+fact.literal.length+120);
    if(fact.kind!=='date' && !numericTokens(quote).some(token=>token[0]===fact.literal))return problem;
    // Diagnostic data from this exact frozen field, never an automatic edit or
    // a substitute for a tool read. The one repair still has to satisfy every
    // reference, modality, temporal and publication check.
    return {...problem,attributionExample:{field:fact.field,text:`Según la fuente [evidence:${fact.evidenceId}]: «${quote}»`,fact:{kind:fact.kind,field:fact.field,literal:fact.literal,evidenceId:fact.evidenceId,path:fact.path,quote}}};
  };
  const spans = new Map([...fields.keys()].map(key => [key, []]));
  const problems=[],seen=new Set();let truncated=false;
  const addProblem=problem=>{
    const key=JSON.stringify(problem);if(seen.has(key))return;
    if(problems.length<16){problems.push(problem);seen.add(key);}else truncated=true;
  };
  const validateReference = fact => {
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
      return null;
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
      if (!fact.quote || !raw.includes(fact.quote) || !fact.quote.includes(fact.literal)) return sourceFailure('exact-source-quote-required', fact, raw);
      // A declared kind alone cannot turn an unqualified statement into an
      // attributed report. The literal wrapper is shared with the prompt/UI.
      const attributed = `Según la fuente [evidence:${fact.evidenceId}]: «${fact.quote}»`;
      if (!field.text.includes(attributed) || field.kind && field.kind !== 'attributed-report') return sourceFailure('explicit-source-attribution-required', fact, raw);
      if (!numericTokens(fact.quote).some(t => t[0] === fact.literal) && fact.kind !== 'date') return fail('exact-source-token-required', fact);
      for (let at = field.text.indexOf(attributed); at !== -1; at = field.text.indexOf(attributed, at + attributed.length))
        spans.get(fact.field).push([at, at + attributed.length]);
      return null;
    }
    for (const match of numericTokens(field.text).filter(token => token[0] === fact.literal))
      spans.get(fact.field).push([match.index, match.index + match[0].length]);
    return null;
  };
  for(const fact of facts){const problem=validateReference(fact);if(problem)addProblem(problem);}
  const opaque = [...items.keys(), snapshot.snapshotId, ...(snapshot.coverage?.selectedInstrumentIds || [])]
    .filter(id => typeof id === 'string' && id.length >= 8 && /\D/.test(id));
  for (const [field, row] of fields) {
    const ranges = spans.get(field);
    ranges.push(...publisherSpans(row,items));
    for (const cite of row.text.matchAll(/\[evidence:([^\]\s]+)\]/g)) {
      if (!items.has(cite[1]) || !row.refs.includes(cite[1])) addProblem({ code: 'AGENT_UNKNOWN_EVIDENCE', field, evidenceId: cite[1].slice(0, 256), reason: 'invalid-narrative-citation' });
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
      addProblem({ ...fail('unverified-numeric-narrative', { field }), providedValue: number,technicalOptions });
    }
  }
  return problems.length?{...problems[0],problems,truncated}:null;
}

export function narrativeCoverageExample(snapshot){
  const count=snapshot.coverage?.domains?.news?.count;
  if(!Number.isSafeInteger(count)||count<0)return null;
  return {limitations:[`El corte seleccionado contiene ${count} noticias; este conteo no es una señal financiera.`],narrativeFacts:[{kind:'coverage',field:'/limitations/0',literal:String(count),evidenceId:`coverage:${snapshot.snapshotId}`,path:'$snapshot.coverage.domains.news.count'}]};
}

const NUMERIC_NARRATIVE_INSTRUCTIONS = `Contrato ${NARRATIVE_CONTRACT_VERSION}. Redacta la síntesis y explicaciones en español. Incluye SIEMPRE technicalFacts y narrativeFacts, también cuando sean []. Si no necesitas cifras, evita cifras en la prosa. Cada cifra narrativa necesita un narrativeFact {kind,field,literal,evidenceId,path}; field es un JSON pointer exacto como /summary o /drivers/0/description y path es relativo a data. kind=technical enlaza un technicalFact elegible con valor y unidad exactos: literal=String(value), sin redondeos ni porcentajes; el indicador nombrado debe coincidir con la ruta. kind=coverage sólo en /limitations/N o /missingEvidence/N, con el valor exacto de coverage o metodología técnica; para conteos del manifiesto usa el evidenceId de coverage y path=$snapshot.coverage.domains.news.count o la ruta exacta del manifiesto. No confundas la lista de estados de fuentes con esos conteos. Para cantidades relatadas o ediciones usa kind=reported-quantity o edition y quote copiado literalmente de title/excerpt/description/summary/text; escribe exactamente Según la fuente [evidence:ID]: «FRAGMENTO» en ese campo y copia la cifra en literal. Copia el fragmento con sus espacios y puntuación originales, sin traducirlo ni cambiar comillas. La atribución requiere literalmente ese formato; una cita al final de una paráfrasis no lo reemplaza. El texto de quote debe ser el mismo fragmento que aparece entre «» en la prosa. No anotes timestamps ausentes de la prosa ni cantidades de cobertura en summary. Ese relato no es un hecho confirmado ni una observación financiera. kind=date exige un timestamp exacto del campo publishedAt/knownAt/occurredAt/receivedAt y el mismo formato atribuido; nunca deduzcas occurredAt. Las citas deben pertenecer a las referencias del campo. IDs y horizontes estructurados no son mediciones. No uses cobertura, requisitos o citas textuales para habilitar una dirección financiera. probability=null.`;

export const FACTUAL_GROUNDING_INSTRUCTIONS = `Límite factual: usa exclusivamente el significado explícito de los contenidos congelados que hayas leído. Antes de redactar localiza un fragmento exacto que respalde cada afirmación factual; si no existe, elimina ese detalle o declara la carencia. No completes titulares con conocimientos previos, memoria ni asociaciones temáticas de otras noticias. Un anuncio de sanciones a un país no acredita su motivo, destinatarios, sector o lugar si la fuente no los indica; una esperanza de reunión no acredita que esté programada. Cada relato debe llevar su atribución y cita [evidence:ID] junto a la afirmación. Conserva preguntas, posibilidad, negaciones y autoría; puedes traducir sin ampliar el significado. Cuando sólo haya un titular, identifica ese límite y usa una cita textual breve si una paráfrasis añadiría detalles. No presentes lo comunicado por una fuente como un suceso verificado. Delimita la síntesis a la muestra consultada, sin declararla panorama mundial ni inventar un orden de importancia global. Separa toda interpretación propia como hipótesis condicional visible, con el mecanismo y lo que habría que confirmar o invalidar; no la atribuyas al medio. En una reparación vuelve a comprobar estas mismas fronteras: quitar cifras no autoriza completar hechos. Explica las limitaciones con lenguaje útil para el usuario, sin UUIDs ni detalles internos del almacenamiento. No muestres razonamiento privado.`;
export const NARRATIVE_INSTRUCTIONS = `${FACTUAL_GROUNDING_INSTRUCTIONS}\n${NUMERIC_NARRATIVE_INSTRUCTIONS}`;
