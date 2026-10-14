// Shared projection for the HTTP service and the SQLite analysis worker.
export function awarenessMarketArticles(snapshot = {}) {
  if (snapshot.mode !== "visible") return [];
  return (snapshot.recent || [])
    .filter((event) => (["released", "updated"].includes(event.status) || (event.kind === "maritime_alert" && event.status === "live")) && (event.domains || []).includes("financial") && event.publishedAt)
    .map((event) => ({
      id: event.eventId,
      provider: "awareness",
      sourceId: event.source?.sourceId || null,
      sourceName: event.source?.name || "Official awareness source",
      sourceRole: event.source?.role || "official",
      role: event.source?.role || "official",
      publisher: event.source?.name || null,
      title: event.title,
      description: event.summary,
      content: event.summary,
      excerpt: event.summary,
      url: event.canonicalUrl,
      publishedAt: event.publishedAt,
      receivedAt: event.observedAt,
      countryMentions: event.countries || [],
      instrumentIds: event.instrumentIds || [],
      domains: event.domains || ["financial"],
      financial: {
        isFinancial: true,
        domains: (event.domains || []).filter((domain) => ["macro", "market", "corporate", "regulatory"].includes(domain)),
        primaryDomain: (event.domains || []).find((domain) => ["macro", "market", "corporate", "regulatory"].includes(domain)) || "market",
        importance: {
          score: event.importance === "high" ? 80 : event.importance === "medium" ? 55 : 30,
          band: event.importance,
          methodVersion: event.importanceMethod
        },
        methodVersion: "market-awareness-v1"
      },
      financialImportanceScore: event.importance === "high" ? 80 : event.importance === "medium" ? 55 : 30,
      sentiment: { label: "neutral", score: 0 },
      conflict: { totalWeight: 0, tags: [] },
      synthetic: false,
      dataMode: event.dataMode || "observed",
      provenance: event.provenance
    }));
}
