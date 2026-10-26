import { BASELINE_COUNTRIES, detectCountryMentions } from '../../utils/countryCatalog.js';

export const NEWS_CLASSIFICATION_VERSION = 'news-classification-v2';
export const NEWS_LANGUAGES = Object.freeze(['en', 'es', 'fr', 'de', 'pt']);
export const normalizeNewsText = value => String(value || '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
const has = (text, phrase) => ` ${text} `.includes(` ${normalizeNewsText(phrase)} `);
const COUNTRY_ALIASES = {US:['estados unidos','etats unis','vereinigte staaten'],RU:['rusia','russie','russland'],CN:['chine'],UA:['ucrania'],SY:['siria','syrie'],IQ:['irak'],AF:['afganistan'],KP:['corea del norte','coree du nord','nordkorea'],KR:['corea del sur','coree du sud','sudkorea'],IN:['inde'],PK:['paquistan'],TR:['turquia','turquie'],ET:['etiopia','ethiopie'],CO:['colombie'],MM:['birmania','birmanie']};
export function extractNewsCountries(value, existing = []) {
  const text = normalizeNewsText(value), result = new Set([...existing,...detectCountryMentions(value)]);
  for (const country of BASELINE_COUNTRIES) if ((COUNTRY_ALIASES[country.iso2] || []).some(alias => has(text, alias))) result.add(country.iso2);
  if (['latin america','america latina','south america','america del sur','central america','america central','north america','america del norte'].some(alias=>has(text,alias)) &&
      !['united states','usa','estados unidos','etats unis','vereinigte staaten'].some(alias=>has(text,alias))) result.delete('US');
  return [...result];
}
const TOPICS = {
  conflict:['conflict','war','missile','missiles','drone','drones','airstrike','troop','troops','artillery','misil','misiles','guerra','ataque aereo','tropas','frappe aerienne','guerre','rakete','raketen','raketenangriff','krieg','luftangriff','missil','misseis','ataque militar'],
  cyber:['cyber','ransomware','hacked','malware','intrusion','ciberataque','ciberseguridad','cyberattaque','cyberangriff','ataque cibernetico'],
  sanctions:['sanction','sanctions','asset freeze','embargo','export control','sancion','sanciones','sanktionen','sancoes'],
  energy:['oil','gas','lng','pipeline','refinery','opec','petroleo','oleoducto','gazoduc','erdol','gasoduto'],
  shipping:['shipping','strait','tanker','maritime','port','maritimo','estrecho','detroit','schifffahrt','estreito'],
  economics:['tariff','inflation','default','debt','market','arancel','inflacion','dette','schulden','inflacao'],
  space:['satellite','rocket','space launch','orbital','satelite','lanzamiento espacial','lancement spatial','weltraumstart','lancamento espacial'],
  civil_unrest:['protest','protests','riot','demonstration','uprising','workers strike','labor strike','union strike','general strike','protesta','protestas','huelga','greve','manifestacion','manifestation','proteste','streik','manifestacao'],
  humanitarian:['refugee','refugees','displaced','aid','famine','food insecurity','refugiados','desplazados','aide humanitaire','fluchtlinge','ajuda humanitaria'],
  environment:['earthquake','flood','storm','wildfire','drought','terremoto','inundacion','seisme','erdbeben','inundacao']
};
export function newsTopicTags(value) { const text = normalizeNewsText(value); return Object.entries(TOPICS).filter(([,words])=>words.some(word=>has(text,word))).map(([tag])=>tag); }
const LANGUAGE_HINTS = {es:['el','la','los','las','un','una','con','misil','misiles','ataque','huelga','ucrania','sanciones'],fr:['le','les','des','une','frappe','guerre','greve'],de:['der','die','das','und','raketen','streik','krieg'],pt:['uma','dos','com','misseis','sancoes','lancamento'],en:['the','and','in','after','missile','strike','workers','war','sanctions','release','report','news']};
const MODAL = {
  negated: /\b(?:no|not|never|denies|denied|sin|niega|niegan|pas|aucun|kein|keine|keinen|nicht|nao)\s+(?:(?:a|an|any|un|una|hubo|houve|there|was|confirmed|reported|the|que|ningun|ninguna|de|einen|ein)\s+){0,4}(?:missile|strike|attack|ataque|misil|frappe|angriff|raketen|misseis)\b|\b(?:attack|strike|ataque|frappe|angriff)\s+(?:did not occur|never happened|no ocurrio|nao ocorreu)/,
  prospective: /\b(?:may|might|could|will|plans?|planned|threatens?|tomorrow|podria|podrian|amenaza|manana|pourrait|demain|menace|konnte|morgen|droht|pode|podera|amanha)\b/,
  opinion: /\b(?:opinion|editorial|commentary|analysis|analisis|analyse|kommentar|opiniao)\b/
};
export function classifyNews({text = '', language = null, textScope = 'headline'} = {}) {
  const normalized = normalizeNewsText(text), tags = newsTopicTags(text);
  const declared = typeof language === 'string' ? language.toLowerCase().split(/[-_]/)[0] : null;
  const nonLatin = /[\p{Script=Cyrillic}\p{Script=Han}\p{Script=Arabic}\p{Script=Hebrew}]/u.test(text);
  const hints = Object.entries(LANGUAGE_HINTS).map(([lang, words])=>[lang, words.filter(word=>has(normalized,word)).length]).sort((a,b)=>b[1]-a[1]);
  const detected = declared || (hints[0][1] > 0 ? hints[0][0] : null);
  const status = !normalized ? 'insufficient-text' : (declared && !NEWS_LANGUAGES.includes(declared)) || nonLatin ? 'unsupported-language' : detected ? 'evaluated' : 'unknown-language';
  const modalities = Object.entries(MODAL).filter(([,rule])=>rule.test(normalized)).map(([name])=>name);
  const modality = modalities.length > 1 ? 'mixed' : modalities[0] || (status === 'evaluated' ? 'reported' : 'unknown');
  let score = status === 'evaluated' ? tags.reduce((sum, tag)=>sum+({conflict:3,cyber:2,sanctions:2,civil_unrest:2,humanitarian:1}[tag] || 0),0) : null;
  if (score !== null) {
    if (['ballistic missile','misil balistico','missile balistique','ballistische rakete','missil balistico'].some(word=>has(normalized,word))) score+=3;
    if (['missile strike','ataque con misiles','frappe de missiles','raketenangriff','ataque com misseis'].some(word=>has(normalized,word))) score+=3;
    if (['airstrike','troop deployment','ataque aereo','frappe aerienne','luftangriff','mobilizacao de tropas'].some(word=>has(normalized,word))) score+=2;
  }
  return {topicTags: tags, countryMentions: extractNewsCountries(text), level: score === null ? 'unknown' : score>=8?'critical':score>=5?'elevated':score>=2?'monitoring':'low', score,
    classification: {methodVersion: NEWS_CLASSIFICATION_VERSION, languages: NEWS_LANGUAGES, language: detected,
      status, textScope, modality, occurrence: 'not-established', meaning: 'news relevance; not verified incident occurrence'}};
}

export function classificationProjection(value) {
  if (!value || value.methodVersion !== NEWS_CLASSIFICATION_VERSION) return undefined;
  return {methodVersion: NEWS_CLASSIFICATION_VERSION, language: typeof value.language==='string' && /^[a-z]{2,3}$/.test(value.language) ? value.language : null,
    status: ['evaluated','unsupported-language','unknown-language','insufficient-text'].includes(value.status) ? value.status : 'unknown-language',
    textScope: ['headline','excerpt','permitted-text'].includes(value.textScope) ? value.textScope : 'headline',
    modality: ['negated','prospective','opinion','mixed','reported','unknown'].includes(value.modality) ? value.modality : 'unknown'};
}
