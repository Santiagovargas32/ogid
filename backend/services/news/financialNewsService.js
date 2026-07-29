export const FINANCIAL_NEWS_DOMAINS = Object.freeze([
  "macro",
  "market",
  "corporate",
  "regulatory"
]);

export const FINANCIAL_CLASSIFIER_METHOD_VERSION = "financial-news-classifier-rule-v1";
export const FINANCIAL_IMPORTANCE_METHOD_VERSION = "financial-importance-rule-v1";
export const NEWS_LANE_ROTATION_METHOD_VERSION = "news-lane-rotation-70-30-v1";

const DOMAIN_RULES = Object.freeze({
  macro: Object.freeze([
    "federal reserve",
    "fed",
    "fomc",
    "fomc statement",
    "central bank",
    "monetary policy",
    "interest rate",
    "interest rate decision",
    "rate hike",
    "rate cut",
    "inflation",
    "consumer price index",
    "cpi",
    "producer price index",
    "ppi",
    "pce inflation",
    "personal consumption expenditures",
    "pce",
    "employment situation",
    "nonfarm payrolls",
    "jobs report",
    "unemployment rate",
    "gross domestic product",
    "gdp",
    "economic outlook",
    "recession"
  ]),
  market: Object.freeze([
    "stock market",
    "stocks",
    "shares",
    "equities",
    "bond market",
    "treasury yield",
    "treasury yields",
    "foreign exchange",
    "currency market",
    "commodities",
    "oil price",
    "oil prices",
    "gold price",
    "gold prices",
    "bitcoin",
    "cryptocurrency",
    "futures",
    "volatility",
    "vix",
    "premarket",
    "after hours",
    "selloff",
    "rally"
  ]),
  corporate: Object.freeze([
    "earnings",
    "quarterly results",
    "revenue",
    "profit warning",
    "earnings warning",
    "guidance",
    "merger",
    "acquisition",
    "initial public offering",
    "ipo",
    "share buyback",
    "dividend",
    "bankruptcy",
    "credit rating",
    "analyst upgrade",
    "analyst downgrade",
    "price target"
  ]),
  regulatory: Object.freeze([
    "securities and exchange commission",
    "sec",
    "sec enforcement",
    "commodity futures trading commission",
    "cftc",
    "financial regulator",
    "regulatory",
    "antitrust",
    "enforcement action",
    "regulatory approval",
    "regulatory filing",
    "market manipulation",
    "insider trading",
    "trading halt",
    "compliance rule",
    "sanction",
    "sanctions",
    "asset freeze",
    "export control"
  ])
});

const OFFICIAL_SOURCE_DOMAINS = Object.freeze({
  "rss-federal-reserve-press-releases": ["macro", "regulatory"],
  "rss-eia-today-in-energy": ["market"],
  "rss-eia-press-releases": ["market"],
  "rss-sec-press-releases": ["regulatory"],
  "rss-cftc-press-releases": ["regulatory"],
  "rss-eu-sanctions-guidance": ["regulatory"]
});

const IMPORTANT_EVENT_TERMS = Object.freeze([
  "emergency",
  "unexpected",
  "surprise",
  "interest rate decision",
  "fomc statement",
  "rate hike",
  "rate cut",
  "trading halt",
  "bank failure",
  "bankruptcy",
  "sovereign default",
  "profit warning",
  "earnings warning",
  "enforcement action",
  "market manipulation"
]);

const HIGH_IMPACT_RELEASE_TERMS = Object.freeze([
  "fomc",
  "interest rate decision",
  "consumer price index",
  "cpi",
  "producer price index",
  "ppi",
  "employment situation",
  "nonfarm payrolls",
  "gross domestic product",
  "gdp",
  "personal consumption expenditures",
  "pce"
]);

const SOURCE_ROLE_SCORES = Object.freeze({
  official: 30,
  primary: 15,
  editorial: 10,
  discovery: 4
});

const DOMAIN_SCORES = Object.freeze({
  macro: 26,
  regulatory: 24,
  corporate: 20,
  market: 18
});

const ROTATION_CYCLE = Object.freeze([
  "geopolitical",
  "geopolitical",
  "financial",
  "geopolitical",
  "geopolitical",
  "financial",
  "geopolitical",
  "geopolitical",
  "geopolitical",
  "financial"
]);

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function normalizeText(value = "") {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsTerm(normalizedText, term) {
  const needle = normalizeText(term);
  return Boolean(needle) && ` ${normalizedText} `.includes(` ${needle} `);
}

function articleText(article = {}) {
  return normalizeText([
    article.title,
    article.description,
    article.content,
    article.excerpt,
    article.fullText,
    article.sourceName,
    article.publisher,
    article.sourceId,
    ...(Array.isArray(article.topics) ? article.topics : [])
  ].filter(Boolean).join(" "));
}

function normalizeSourceRole(article = {}) {
  return normalizeText(article.sourceRole || article.role || article.source?.role || "");
}

function publishedTime(article = {}) {
  const timestamp = Date.parse(article.publishedAt || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function selectionLimit(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function domainCounts(items = []) {
  const counts = Object.fromEntries(FINANCIAL_NEWS_DOMAINS.map((domain) => [domain, 0]));
  for (const item of items) {
    for (const domain of item?.financial?.domains || []) {
      if (Object.hasOwn(counts, domain)) {
        counts[domain] += 1;
      }
    }
  }
  return counts;
}

export function classifyFinancialArticle(article = {}) {
  const haystack = articleText(article);
  const matchedTerms = {};

  const sourceId = String(article.sourceId || article.source?.sourceId || "").trim().toLowerCase();
  for (const domain of OFFICIAL_SOURCE_DOMAINS[sourceId] || []) {
    matchedTerms[domain] = [`official-source:${sourceId}`];
  }

  for (const domain of FINANCIAL_NEWS_DOMAINS) {
    const matches = DOMAIN_RULES[domain].filter((term) => containsTerm(haystack, term));
    if (matches.length) {
      matchedTerms[domain] = [...new Set([...(matchedTerms[domain] || []), ...matches])];
    }
  }

  if (Array.isArray(article.instrumentIds) && article.instrumentIds.length && !matchedTerms.corporate) {
    matchedTerms.corporate = ["instrumentIds"];
  }

  const domains = FINANCIAL_NEWS_DOMAINS.filter((domain) => matchedTerms[domain]);
  const primaryDomain = [...domains].sort((left, right) => {
    const hitDifference = matchedTerms[right].length - matchedTerms[left].length;
    return hitDifference || DOMAIN_SCORES[right] - DOMAIN_SCORES[left];
  })[0] || null;

  return {
    ...article,
    financial: {
      isFinancial: domains.length > 0,
      domains,
      primaryDomain,
      matchedTerms,
      methodVersion: FINANCIAL_CLASSIFIER_METHOD_VERSION
    }
  };
}

export function partitionNewsArticles(articles = []) {
  const geopolitical = [];
  const financial = [];
  const hybrid = [];

  for (const article of Array.isArray(articles) ? articles : []) {
    const classified = classifyFinancialArticle(article);
    const isFinancial = classified.financial.isFinancial;
    const hasGeopoliticalSignal = Number(article?.conflict?.totalWeight || 0) > 0;

    if (isFinancial) {
      financial.push(article);
    }
    if (!isFinancial || hasGeopoliticalSignal) {
      geopolitical.push(article);
    }
    if (isFinancial && hasGeopoliticalSignal) {
      hybrid.push(article);
    }
  }

  return { geopolitical, financial, hybrid };
}

function importanceBand(score) {
  if (score >= 80) return "critical";
  if (score >= 60) return "high";
  if (score >= 40) return "medium";
  if (score > 0) return "low";
  return "none";
}

export function scoreFinancialImportance(article = {}) {
  const classified = classifyFinancialArticle(article);
  const { domains, primaryDomain } = classified.financial;
  if (!domains.length) {
    return {
      score: 0,
      band: "none",
      methodVersion: FINANCIAL_IMPORTANCE_METHOD_VERSION,
      reasons: []
    };
  }

  const reasons = [];
  let score = DOMAIN_SCORES[primaryDomain] || 0;
  reasons.push(`domain:${primaryDomain}`);

  if (domains.length > 1) {
    score += Math.min(15, (domains.length - 1) * 5);
    reasons.push(`hybrid:${domains.length}`);
  }

  const role = normalizeSourceRole(article);
  const roleScore = SOURCE_ROLE_SCORES[role] ?? 6;
  score += roleScore;
  reasons.push(`source-role:${role || "unknown"}`);

  const eventMatches = IMPORTANT_EVENT_TERMS.filter((term) => containsTerm(articleText(article), term));
  if (eventMatches.length) {
    score += Math.min(24, eventMatches.length * 8);
    reasons.push(...eventMatches.map((term) => `event:${term}`));
  }

  if (Array.isArray(article.instrumentIds) && article.instrumentIds.length) {
    score += 12;
    reasons.push("explicit-instrument-link");
  }

  const highImpactMatches = HIGH_IMPACT_RELEASE_TERMS.filter((term) => containsTerm(articleText(article), term));
  if (highImpactMatches.length) {
    score = Math.max(score, 60);
    reasons.push(...highImpactMatches.map((term) => `high-impact-release:${term}`));
  }
  if (article.instrumentIds?.length && domains.some((domain) => ["corporate", "regulatory"].includes(domain))) {
    score = Math.max(score, 60);
    reasons.push("selected-instrument-filing");
  }

  const boundedScore = Math.round(clamp(score));
  return {
    score: boundedScore,
    band: importanceBand(boundedScore),
    methodVersion: FINANCIAL_IMPORTANCE_METHOD_VERSION,
    reasons
  };
}

function canonicalUrl(value = "") {
  const rawValue = String(value || "").trim();
  if (!rawValue) {
    return "";
  }
  try {
    const url = new URL(rawValue);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_.+|fbclid|gclid)$/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    return url.toString();
  } catch {
    return rawValue.toLowerCase();
  }
}

function titleFingerprint(article = {}) {
  return normalizeText(article.title || "");
}

function compareFinancialPriority(left, right) {
  const leftImportance = Number.isFinite(left?.financial?.importance?.score)
    ? left.financial.importance.score
    : scoreFinancialImportance(left).score;
  const rightImportance = Number.isFinite(right?.financial?.importance?.score)
    ? right.financial.importance.score
    : scoreFinancialImportance(right).score;
  const importanceDifference = rightImportance - leftImportance;
  if (importanceDifference) return importanceDifference;
  const analysisDifference = Number(right?.financialAnalysisScore || 0) - Number(left?.financialAnalysisScore || 0);
  if (analysisDifference) return analysisDifference;
  const publishedDifference = publishedTime(right) - publishedTime(left);
  if (publishedDifference) return publishedDifference;
  return `${left?.url || ""}|${left?.title || ""}`.localeCompare(`${right?.url || ""}|${right?.title || ""}`);
}

export function deduplicateFinancialArticles(articles = []) {
  const seenUrls = new Set();
  const seenTitles = new Set();
  const prioritized = [...articles].sort(compareFinancialPriority);

  return prioritized.filter((article) => {
    const urlKey = canonicalUrl(article?.url);
    const titleKey = titleFingerprint(article);
    if ((urlKey && seenUrls.has(urlKey)) || (titleKey && seenTitles.has(titleKey))) {
      return false;
    }
    if (urlKey) seenUrls.add(urlKey);
    if (titleKey) seenTitles.add(titleKey);
    return Boolean(urlKey || titleKey);
  });
}

function recencyScore(article, nowMs, candidateWindowMs) {
  const timestamp = publishedTime(article);
  if (!timestamp) {
    return 0;
  }
  const ageMs = Math.max(0, nowMs - timestamp);
  return clamp(1 - ageMs / candidateWindowMs, 0, 1);
}

function selectWithSourceDiversity(articles, limit, maxPerSource) {
  const sourceCounts = new Map();
  const selected = [];
  for (const article of articles) {
    const sourceKey = normalizeText(article.sourceId || article.sourceName || article.provider || "unknown");
    const count = sourceCounts.get(sourceKey) || 0;
    if (count >= maxPerSource) {
      continue;
    }
    selected.push(article);
    sourceCounts.set(sourceKey, count + 1);
    if (selected.length >= limit) {
      break;
    }
  }
  return selected;
}

export function buildFinancialNewsSelection({
  articles = [],
  now = new Date(),
  candidateWindowHours = 72,
  analyzeLimit = 80,
  displayLimit = 40,
  maxPerSource = 4
} = {}) {
  const nowMs = new Date(now).getTime();
  const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const boundedWindowHours = Math.max(1, Number(candidateWindowHours) || 72);
  const candidateWindowMs = boundedWindowHours * 60 * 60 * 1_000;

  const financialCandidates = articles
    .map(classifyFinancialArticle)
    .filter((article) => article.financial.isFinancial)
    .filter((article) => {
      const timestamp = publishedTime(article);
      return timestamp > 0 && safeNowMs - timestamp <= candidateWindowMs;
    })
    .map((article) => {
      const importance = scoreFinancialImportance(article);
      const freshness = recencyScore(article, safeNowMs, candidateWindowMs);
      return {
        ...article,
        financial: {
          ...article.financial,
          importance
        },
        financialImportanceScore: importance.score,
        financialAnalysisScore: Math.round(importance.score * 0.85 + freshness * 15)
      };
    });

  const deduped = deduplicateFinancialArticles(financialCandidates).sort(compareFinancialPriority);
  const signalCorpus = deduped.slice(0, selectionLimit(analyzeLimit, 80));
  const items = selectWithSourceDiversity(
    signalCorpus,
    selectionLimit(displayLimit, 40),
    selectionLimit(maxPerSource, 4)
  );

  return {
    items,
    signalCorpus,
    diagnostics: {
      inputCount: articles.length,
      financialCandidateCount: financialCandidates.length,
      dedupedCount: deduped.length,
      selectedCount: items.length,
      domainCounts: domainCounts(signalCorpus),
      classifierMethodVersion: FINANCIAL_CLASSIFIER_METHOD_VERSION,
      importanceMethodVersion: FINANCIAL_IMPORTANCE_METHOD_VERSION
    }
  };
}

export function buildNewsLaneRotation({ slots = 10, offset = 0 } = {}) {
  const count = Math.max(0, Number.parseInt(String(slots ?? 10), 10) || 0);
  const start = Math.max(0, Number.parseInt(String(offset ?? 0), 10) || 0);
  return Array.from({ length: count }, (_, index) => ROTATION_CYCLE[(start + index) % ROTATION_CYCLE.length]);
}

function rotationIdentity(article = {}) {
  return canonicalUrl(article.url) || titleFingerprint(article) || String(article.id || "");
}

export function mergeNewsLanesByRotation({
  geopoliticalItems = [],
  financialItems = [],
  limit = geopoliticalItems.length + financialItems.length,
  offset = 0
} = {}) {
  const lanes = {
    geopolitical: Array.isArray(geopoliticalItems) ? geopoliticalItems : [],
    financial: Array.isArray(financialItems) ? financialItems : []
  };
  const cursors = { geopolitical: 0, financial: 0 };
  const seen = new Set();
  const selected = [];
  const boundedLimit = Math.max(0, Number.parseInt(String(limit ?? 0), 10) || 0);
  const schedule = buildNewsLaneRotation({ slots: boundedLimit, offset });

  const takeUnique = (lane) => {
    while (cursors[lane] < lanes[lane].length) {
      const article = lanes[lane][cursors[lane]];
      cursors[lane] += 1;
      const identity = rotationIdentity(article);
      if (identity && seen.has(identity)) {
        continue;
      }
      if (identity) seen.add(identity);
      return article;
    }
    return null;
  };

  for (const scheduledLane of schedule) {
    const fallbackLane = scheduledLane === "geopolitical" ? "financial" : "geopolitical";
    const article = takeUnique(scheduledLane) || takeUnique(fallbackLane);
    if (!article) {
      break;
    }
    selected.push(article);
  }

  return {
    items: selected,
    policy: {
      geopoliticalPercent: 70,
      financialPercent: 30,
      methodVersion: NEWS_LANE_ROTATION_METHOD_VERSION,
      offset: Math.max(0, Number.parseInt(String(offset ?? 0), 10) || 0)
    }
  };
}
