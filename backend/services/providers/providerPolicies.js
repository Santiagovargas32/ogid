const VERIFIED_AT = "2026-07-11";

const policies = {
  newsapi: {
    provider: "newsapi", plan: "Developer", quotaPeriod: "day",
    declaredLimit: { day: 100 }, internalBudget: { soft: { day: 72 }, hard: { day: 90 } },
    reserve: { day: 10 }, cost: { mode: "operation", units: 1 },
    documentation: "https://newsapi.org/pricing", verifiedAt: VERIFIED_AT
  },
  gnews: {
    provider: "gnews", plan: "Free", quotaPeriod: "day",
    declaredLimit: { day: 100 }, internalBudget: { soft: { day: 72 }, hard: { day: 90 } },
    reserve: { day: 10 }, cost: { mode: "operation", units: 1 }, constraints: { maxPageSize: 10 },
    documentation: "https://gnews.io/pricing", verifiedAt: VERIFIED_AT
  },
  mediastack: {
    provider: "mediastack", plan: "Free", quotaPeriod: "month",
    declaredLimit: { month: 100 }, internalBudget: { soft: { month: 60 }, hard: { month: 80 } },
    reserve: { month: 20 }, cost: { mode: "operation", units: 1 }, constraints: { requiresHttps: true },
    documentation: "https://mediastack.com/product", verifiedAt: VERIFIED_AT
  },
  twelve: {
    provider: "twelve", plan: "Basic", quotaPeriod: "minute+day",
    declaredLimit: { minute: 8, day: 800 },
    internalBudget: { soft: { minute: 7, day: 600 }, hard: { minute: 8, day: 700 } },
    reserve: { minute: 1, day: 100 }, cost: { mode: "symbol", units: 1 },
    documentation: "https://twelvedata.com/docs/advanced/api-usage", verifiedAt: VERIFIED_AT
  },
  "youtube-search": {
    provider: "youtube-search", plan: "Development budget", quotaPeriod: "day",
    declaredLimit: { day: 100 }, internalBudget: { soft: { day: 54 }, hard: { day: 60 } },
    reserve: { day: 40 }, cost: { mode: "operation", units: 1, upstreamQuotaUnits: 100 },
    documentation: "https://developers.google.com/youtube/v3/determine_quota_cost", verifiedAt: VERIFIED_AT
  },
  rss: { provider: "rss", plan: null, quotaPeriod: null, declaredLimit: null, internalBudget: null, reserve: null, cost: null, documentation: null, verifiedAt: VERIFIED_AT },
  gdelt: { provider: "gdelt", plan: null, quotaPeriod: null, declaredLimit: null, internalBudget: null, reserve: null, cost: null, documentation: null, verifiedAt: VERIFIED_AT },
  yahoo: { provider: "yahoo", plan: null, quotaPeriod: null, declaredLimit: null, internalBudget: null, reserve: null, cost: null, documentation: null, verifiedAt: VERIFIED_AT },
  carto: { provider: "carto", plan: null, quotaPeriod: null, declaredLimit: null, internalBudget: null, reserve: null, cost: null, documentation: null, verifiedAt: VERIFIED_AT }
};

export function getProviderPolicy(provider) {
  const policy = policies[String(provider || "").toLowerCase()] || null;
  return policy ? structuredClone(policy) : null;
}

export function listProviderPolicies() {
  return Object.values(policies).map((policy) => structuredClone(policy));
}

export { VERIFIED_AT };
