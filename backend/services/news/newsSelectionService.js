const SOURCE_RELIABILITY = Object.freeze({
  reuters: 1,
  "associated press": 0.98,
  ap: 0.95,
  bloomberg: 0.94,
  "financial times": 0.92,
  wsj: 0.9,
  cnn: 0.82,
  bbc: 0.86,
  aljazeera: 0.8
});

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function normalizeText(value = "") {
  return String(value)
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildBaseDedupKey(article) {
  const normalizedUrl = String(article.url || "").trim().toLowerCase();
  const normalizedTitle = normalizeText(article.title || "");
  return `${normalizedUrl}|${normalizedTitle}`;
}

function buildHeadlineFingerprint(article) {
  const words = normalizeText(article.title || "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 12);
  return words.join("|");
}

function sourceReliabilityScore(sourceName = "") {
  const normalized = normalizeText(sourceName);
  if (!normalized) {
    return 0.55;
  }

  const exact = SOURCE_RELIABILITY[normalized];
  if (Number.isFinite(exact)) {
    return exact;
  }

  const containsMatch = Object.entries(SOURCE_RELIABILITY).find(([key]) => normalized.includes(key));
  if (containsMatch) {
    return containsMatch[1];
  }

  return 0.55;
}

function countryRelevanceScore(article, watchlistCountries = []) {
  if (!watchlistCountries.length) {
    return 0.5;
  }

  const mentions = [...new Set(article.countryMentions || [])];
  if (!mentions.length) {
    return 0;
  }

  const watchlist = new Set(watchlistCountries);
  const hits = mentions.filter((iso2) => watchlist.has(iso2)).length;
  return clamp(hits / watchlistCountries.length);
}

function conflictIntensityScore(article) {
  const totalWeight = Number(article?.conflict?.totalWeight || 0);
  return clamp(totalWeight / 8);
}

function recencyScore(article, nowMs, candidateWindowMs) {
  const publishedMs = new Date(article.publishedAt || 0).getTime();
  if (!Number.isFinite(publishedMs)) {
    return 0;
  }
  const ageMs = Math.max(0, nowMs - publishedMs);
  return clamp(1 - ageMs / candidateWindowMs);
}

function noveltyScore(article, seenFingerprints = new Set()) {
  const fingerprint = buildHeadlineFingerprint(article);
  if (!fingerprint) {
    return 0.2;
  }
  return seenFingerprints.has(fingerprint) ? 0.2 : 1;
}

function scoreArticle(article, context) {
  const country = countryRelevanceScore(article, context.watchlistCountries);
  const conflict = conflictIntensityScore(article);
  const recency = recencyScore(article, context.nowMs, context.candidateWindowMs);
  const reliability = sourceReliabilityScore(article.sourceName);
  const novelty = noveltyScore(article, context.seenFingerprints);

  const totalScore = Math.round(
    100 *
      (country * 0.35 +
        conflict * 0.25 +
        recency * 0.2 +
        reliability * 0.1 +
        novelty * 0.1)
  );

  return {
    ...article,
    analysisScore: totalScore
  };
}

function filterCandidateWindow(articles = [], nowMs, candidateWindowMs) {
  return articles.filter((article) => {
    const publishedMs = new Date(article.publishedAt || 0).getTime();
    if (!Number.isFinite(publishedMs)) {
      return false;
    }
    return nowMs - publishedMs <= candidateWindowMs;
  });
}

function dedupeBase(articles = []) {
  const seen = new Set();
  const unique = [];
  for (const article of articles) {
    const key = buildBaseDedupKey(article);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(article);
  }
  return unique;
}

function buildRecentFingerprintSet(previousArticles = [], noveltyWindowMs, nowMs) {
  const set = new Set();
  for (const article of previousArticles) {
    const publishedMs = new Date(article.publishedAt || 0).getTime();
    if (!Number.isFinite(publishedMs) || nowMs - publishedMs > noveltyWindowMs) {
      continue;
    }
    const key = buildHeadlineFingerprint(article);
    if (key) {
      set.add(key);
    }
  }
  return set;
}

function selectWithDiversity(scored = [], { limit, maxPerSource, maxSimilarHeadline }) {
  const sourceCount = new Map();
  const headlineCount = new Map();
  const selected = [];

  for (const article of scored) {
    const sourceKey = normalizeText(article.sourceName || "unknown");
    const sourceHits = sourceCount.get(sourceKey) || 0;
    if (sourceHits >= maxPerSource) {
      continue;
    }

    const headlineKey = buildHeadlineFingerprint(article) || "untitled";
    const headlineHits = headlineCount.get(headlineKey) || 0;
    if (headlineHits >= maxSimilarHeadline) {
      continue;
    }

    selected.push(article);
    sourceCount.set(sourceKey, sourceHits + 1);
    headlineCount.set(headlineKey, headlineHits + 1);

    if (selected.length >= limit) {
      break;
    }
  }

  return selected;
}

function selectionCap(limit, fallback = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(limit ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildSourceSelectionStats({ rawArticles = [], filteredArticles = [], selectedArticles = [] } = {}) {
  const stats = new Map();

  const ensure = (article) => {
    const provider = String(article?.provider || "unknown").toLowerCase();
    const sourceName = String(article?.sourceName || "Unknown Source").trim() || "Unknown Source";
    const key = `${provider}|${normalizeText(sourceName) || "unknown"}`;
    if (!stats.has(key)) {
      stats.set(key, {
        provider,
        sourceName,
        raw: 0,
        filtered: 0,
        selected: 0
      });
    }
    return stats.get(key);
  };

  rawArticles.forEach((article) => {
    ensure(article).raw += 1;
  });
  filteredArticles.forEach((article) => {
    ensure(article).filtered += 1;
  });
  selectedArticles.forEach((article) => {
    ensure(article).selected += 1;
  });

  return [...stats.values()].sort((left, right) => {
    if (right.selected !== left.selected) {
      return right.selected - left.selected;
    }
    if (right.filtered !== left.filtered) {
      return right.filtered - left.filtered;
    }
    return `${left.provider}|${left.sourceName}`.localeCompare(`${right.provider}|${right.sourceName}`);
  });
}

function latestSelectedArticleAgeMin(selectedArticles = [], nowMs = Date.now()) {
  if (!selectedArticles.length) {
    return null;
  }

  const latestPublishedMs = Math.max(
    ...selectedArticles.map((article) => new Date(article?.publishedAt || 0).getTime()).filter(Number.isFinite)
  );
  if (!Number.isFinite(latestPublishedMs)) {
    return null;
  }

  return Math.max(0, Math.round((nowMs - latestPublishedMs) / 60_000));
}

export function buildIntelNewsSelection({
  articles = [],
  previousArticles = [],
  watchlistCountries = [],
  now = new Date(),
  analyzeLimit = 80,
  candidateWindowHours = 36,
  noveltyWindowHours = 12,
  maxPerSource = 3,
  maxSimilarHeadline = 2
} = {}) {
  const nowMs = new Date(now).getTime();
  const candidateWindowMs = Math.max(1, candidateWindowHours) * 60 * 60 * 1_000;
  const noveltyWindowMs = Math.max(1, noveltyWindowHours) * 60 * 60 * 1_000;
  const seenFingerprints = buildRecentFingerprintSet(previousArticles, noveltyWindowMs, nowMs);

  const candidates = dedupeBase(filterCandidateWindow(articles, nowMs, candidateWindowMs));
  const scored = candidates
    .map((article) =>
      scoreArticle(article, {
        watchlistCountries,
        nowMs,
        candidateWindowMs,
        seenFingerprints
      })
    )
    .sort((left, right) => {
      if (right.analysisScore !== left.analysisScore) {
        return right.analysisScore - left.analysisScore;
      }
      return new Date(right.publishedAt).getTime() - new Date(left.publishedAt).getTime();
    });

  const signalCorpus = scored.slice(0, selectionCap(analyzeLimit));
  const displaySelection = selectWithDiversity(signalCorpus, {
    limit: selectionCap(analyzeLimit),
    maxPerSource: Math.max(1, maxPerSource),
    maxSimilarHeadline: Math.max(1, maxSimilarHeadline)
  });

  return {
    signalCorpus,
    displaySelection,
    selectionMeta: {
      selectionBySourceName: buildSourceSelectionStats({
        rawArticles: articles,
        filteredArticles: signalCorpus,
        selectedArticles: displaySelection
      }),
      latestSelectedArticleAgeMin: latestSelectedArticleAgeMin(displaySelection, nowMs),
      selectionConfig: {
        analyzeLimit: selectionCap(analyzeLimit),
        maxPerSource: Math.max(1, maxPerSource),
        maxSimilarHeadline: Math.max(1, maxSimilarHeadline),
        candidateWindowHours: Math.max(1, candidateWindowHours)
      }
    }
  };
}

export function selectNewsForIntel({
  articles = [],
  previousArticles = [],
  watchlistCountries = [],
  now = new Date(),
  analyzeLimit = 80,
  candidateWindowHours = 36,
  noveltyWindowHours = 12,
  maxPerSource = 3,
  maxSimilarHeadline = 2
} = {}) {
  return buildIntelNewsSelection({
    articles,
    previousArticles,
    watchlistCountries,
    now,
    analyzeLimit,
    candidateWindowHours,
    noveltyWindowHours,
    maxPerSource,
    maxSimilarHeadline
  }).displaySelection;
}
