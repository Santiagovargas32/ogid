const NEGATIVE_KEYWORDS = [
  "attack",
  "airstrike",
  "bombing",
  "crisis",
  "clash",
  "conflict",
  "threat",
  "sanction",
  "casualty",
  "escalation",
  "terror",
  "insurgent",
  "military operation",
  "missile",
  "drone strike",
  "war",
  "instability",
  "unrest",
  "hostage",
  "blockade"
];

const POSITIVE_KEYWORDS = [
  "ceasefire",
  "dialogue",
  "peace",
  "agreement",
  "stabilization",
  "aid delivery",
  "de-escalation",
  "talks resumed",
  "diplomatic breakthrough",
  "cooperation",
  "normalization",
  "reconstruction"
];

function normalizeText(value = "") {
  return ` ${String(value).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()} `;
}

function countKeywordHits(haystack, keywords) {
  let hits = 0;
  for (const keyword of keywords) {
    const normalizedKeyword = normalizeText(keyword).trim();
    if (normalizedKeyword && haystack.includes(` ${normalizedKeyword} `)) {
      hits += 1;
    }
  }
  return hits;
}

export function analyzeSentiment(text = "") {
  const haystack = normalizeText(text);
  const negativeHits = countKeywordHits(haystack, NEGATIVE_KEYWORDS);
  const positiveHits = countKeywordHits(haystack, POSITIVE_KEYWORDS);
  const score = positiveHits - negativeHits;

  let label = "neutral";
  if (negativeHits > positiveHits) {
    label = "negative";
  } else if (positiveHits > negativeHits) {
    label = "positive";
  }

  return {
    label,
    score,
    negativeHits,
    positiveHits
  };
}

export { NEGATIVE_KEYWORDS, POSITIVE_KEYWORDS };
