const TAG_DEFINITIONS = [
  {
    tag: "Military",
    weight: 3,
    keywords: ["military", "troop", "airstrike", "offensive", "shelling", "artillery", "missile", "drone"]
  },
  {
    tag: "Sanctions",
    weight: 2,
    keywords: ["sanction", "embargo", "asset freeze", "export control", "trade restriction"]
  },
  {
    tag: "Civil Unrest",
    weight: 2,
    keywords: ["protest", "riot", "demonstration", "uprising", "street clash"]
  },
  {
    tag: "Diplomatic Breakdown",
    weight: 2,
    keywords: ["diplomatic row", "ambassador recalled", "talks collapsed", "expelled diplomats", "walked out"]
  },
  {
    tag: "Cyber Operations",
    weight: 2,
    keywords: ["cyberattack", "ransomware", "hacked", "malware", "intrusion campaign"]
  },
  {
    tag: "Nuclear Risk",
    weight: 3,
    keywords: ["nuclear", "atomic", "uranium enrichment", "reactor shutdown", "ballistic"]
  },
  {
    tag: "Terror Activity",
    weight: 3,
    keywords: ["terror", "militant", "insurgent", "suicide bombing", "extremist"]
  },
  {
    tag: "Humanitarian Crisis",
    weight: 2,
    keywords: ["famine", "refugee", "displaced", "humanitarian", "aid shortage", "food insecurity"]
  }
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

export function extractConflictSignal(text = "") {
  const haystack = normalizeText(text);
  const tags = [];
  let totalWeight = 0;

  for (const definition of TAG_DEFINITIONS) {
    const count = countKeywordHits(haystack, definition.keywords);
    if (count > 0) {
      tags.push({
        tag: definition.tag,
        count,
        weight: definition.weight
      });
      totalWeight += definition.weight * count;
    }
  }

  return { tags, totalWeight };
}

export { TAG_DEFINITIONS };
