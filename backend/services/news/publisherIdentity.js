// Registry identities come from the existing configured publishers/domains.
// The numeric weights are legacy editorial priorities, not truth probabilities.
export const PUBLISHER_METHOD = 'publisher-identity-v1';
export const SOURCE_PRIORITY_METHOD = 'legacy-editorial-priority-v1';
export const PUBLISHERS = Object.freeze([
  ['reuters', 'Reuters', ['reuters'], ['reuters.com'], 1],
  ['associated-press', 'Associated Press', ['ap', 'associated press', 'ap news'], ['apnews.com'], .98],
  ['bloomberg', 'Bloomberg', ['bloomberg'], ['bloomberg.com'], .94],
  ['financial-times', 'Financial Times', ['financial times'], ['ft.com'], .92],
  ['wall-street-journal', 'Wall Street Journal', ['wsj', 'wall street journal', 'the wall street journal'], ['wsj.com'], .9],
  ['bbc', 'BBC', ['bbc', 'bbc world', 'bbc news'], ['bbc.com', 'bbc.co.uk', 'bbci.co.uk'], .86],
  ['dw', 'DW', ['dw', 'deutsche welle'], ['dw.com'], .89],
  ['france24', 'France 24', ['france24', 'france 24'], ['france24.com'], .86],
  ['al-jazeera', 'Al Jazeera', ['aljazeera', 'al jazeera'], ['aljazeera.com'], .8],
  ['cnn', 'CNN', ['cnn'], ['cnn.com'], .82],
  ['fox-news', 'Fox News', ['fox', 'fox news', 'fox world'], ['foxnews.com'], .72],
].map(([publisherId, name, aliases, domains, priority]) => Object.freeze({publisherId, name, aliases, domains, priority})));

const clean = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f<>]/g, ' ').trim().slice(0, 160) : null;
const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const identifier = value => typeof value === 'string' && /^[\p{L}\p{N}._:-]{1,160}$/u.test(value) ? value : null;
function host(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.hostname.toLowerCase() : null; }
  catch { return null; }
}
const byHost = value => PUBLISHERS.find(p => p.domains.some(domain => value === domain || value?.endsWith(`.${domain}`)));
export const publisherByAlias = name => PUBLISHERS.find(p => p.aliases.includes(normalize(name))) || null;

export function resolveEditorialIdentity(article = {}) {
  const prior=article.publisherResolution,priorPublisher=PUBLISHERS.find(p=>p.publisherId===article.publisherId);
  // A derived canonical label is not a new publisher claim. Preserve the
  // original candidate when resolving an archived projection again.
  const replay=prior?.method===PUBLISHER_METHOD&&prior.status==='resolved'&&article.publisher===priorPublisher?.name&&
    priorPublisher?.domains.some(domain=>prior.domain===domain||prior.domain?.endsWith(`.${domain}`))&&Object.hasOwn(prior,'candidateName');
  const name = clean(article.publisherCandidate?.name || (replay?prior.candidateName:article.publisher || article.source?.publisher || article.sourceName || article.source?.name));
  const itemHost = host(article.publisherCandidate?.url) ||
    (article.publisherResolution?.method === PUBLISHER_METHOD ? host(`https://${article.publisherResolution.domain}`) : null), articleHost = host(article.url);
  const fromDomain = byHost(articleHost), fromItem = byHost(itemHost), fromAlias = publisherByAlias(name);
  const conflict = Boolean((fromDomain && fromItem && fromDomain !== fromItem) || (fromAlias && (fromDomain || fromItem) && fromAlias !== (fromDomain || fromItem)));
  const discovery = article.source?.type === 'generated_search' || article.provenance?.sourceType === 'generated_search' || article.provenance?.queryProvider === 'google-news-rss';
  // A random feed linking to an unrelated site cannot establish its publisher
  // simply by claiming a familiar domain in <source>. Retain candidates.
  const discoveryReceipt = article.publisherResolution?.method === PUBLISHER_METHOD && article.publisherResolution?.status === 'resolved' && article.publisherResolution?.reason === 'item-source-and-registry-domain';
  const itemEligible = articleHost === 'news.google.com' && (discovery || discoveryReceipt);
  const publisher = conflict ? null : fromDomain || (itemEligible && fromItem && fromAlias === fromItem ? fromItem : null);
  return { transportProvider: identifier(article.transportProvider || article.provider || article.provenance?.provider) || 'unknown',
    discoverySourceId: identifier(article.discoverySourceId || article.sourceId || article.source?.sourceId || article.provenance?.sourceId),
    publisherId: publisher?.publisherId || null, publisher: publisher?.name || null,
    publisherResolution: {status: publisher ? 'resolved' : name || itemHost ? 'candidate' : 'unresolved',
      method: PUBLISHER_METHOD, reason: conflict ? 'conflicting-identities' : publisher ? fromDomain ? 'article-domain' : 'item-source-and-registry-domain' : 'insufficient-identity',
      candidateName: name, domain: publisher ? (fromDomain ? articleHost : itemHost) : null},
    originChainId: identifier(article.originChainId),
    sourcePriority: {method: SOURCE_PRIORITY_METHOD, value: publisher?.priority ?? .55, assessed: Boolean(publisher), meaning: 'editorial-weight; not factual reliability'} };
}

export function sourcePriority(article = {}) {
  if (article.publisherResolution?.status === 'resolved') return PUBLISHERS.find(p => p.publisherId === article.publisherId)?.priority ?? .55;
  return resolveEditorialIdentity(article).sourcePriority.value;
}

// Explicit projection, never copy arbitrary provider metadata into public output.
export function editorialProjection(value = {}) {
  const resolution = value.publisherResolution;
  const result = {};
  for (const key of ['transportProvider', 'discoverySourceId', 'publisherId', 'originChainId'])
    if (key in value) result[key] = identifier(value[key]);
  if (resolution && ['resolved', 'candidate', 'unresolved'].includes(resolution.status)) result.publisherResolution = {
    status: resolution.status, method: clean(resolution.method), reason: clean(resolution.reason),
    candidateName: clean(resolution.candidateName), domain: clean(resolution.domain)};
  // Editorial weights are an internal policy. Discovery exposes their method
  // once, rather than repeating an apparent reliability score on every article.
  return result;
}
