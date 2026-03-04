const LEVEL_PRIORITY = {
  Critical: 4,
  Elevated: 3,
  Monitoring: 2,
  Stable: 1
};

function classifyTrend(delta) {
  if (delta >= 8) {
    return "Escalating";
  }
  if (delta <= -8) {
    return "De-escalating";
  }
  return "Flat";
}

function buildDrivers(country) {
  const drivers = [];
  if (country.metrics.newsVolume > 0) {
    drivers.push(`news-volume:${country.metrics.newsVolume}`);
  }
  if (country.metrics.negativeSentiment > 0) {
    drivers.push(`negative-sentiment:${country.metrics.negativeSentiment}`);
  }
  if (country.metrics.conflictTagWeight > 0) {
    drivers.push(`conflict-weight:${country.metrics.conflictTagWeight}`);
  }
  for (const tag of country.topTags.slice(0, 2)) {
    drivers.push(`${tag.tag.toLowerCase()}:${tag.count}`);
  }
  return drivers.slice(0, 4);
}

function buildSummary(country, trend) {
  if (country.level === "Critical") {
    return `${country.country} is at critical risk with sustained conflict pressure and deteriorating sentiment indicators (${trend}).`;
  }
  if (country.level === "Elevated") {
    return `${country.country} remains elevated due to repeated security-related reporting and conflict-tag concentration (${trend}).`;
  }
  if (country.level === "Monitoring") {
    return `${country.country} is in monitoring status with moderate incident signals and watch-level concern (${trend}).`;
  }
  return `${country.country} remains stable with low-intensity signal activity and no dominant escalation pattern (${trend}).`;
}

export function generateInsights({ countries = {}, previousCountries = {}, inputMode = "live" }) {
  const ordered = Object.values(countries).sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return (LEVEL_PRIORITY[b.level] || 0) - (LEVEL_PRIORITY[a.level] || 0);
  });

  const topCountries = ordered.filter((country) => country.score > 0).slice(0, 8);

  if (!topCountries.length) {
    return [
      {
        id: "insight-global-stable",
        country: "Global",
        iso2: "GL",
        level: "Stable",
        trend: "Flat",
        summary: "No elevated geopolitical signals detected in the current cycle.",
        drivers: ["news-volume:0", "conflict-weight:0"],
        confidence: 70,
        score: 0,
        inputMode
      }
    ];
  }

  return topCountries.map((country, index) => {
    const previousScore = previousCountries[country.iso2]?.score ?? 0;
    const delta = country.score - previousScore;
    const trend = classifyTrend(delta);
    const confidence = Math.min(
      95,
      55 + country.metrics.newsVolume * 2 + country.metrics.conflictTagWeight + country.metrics.negativeSentiment
    );

    return {
      id: `insight-${country.iso2}-${index + 1}`,
      country: country.country,
      iso2: country.iso2,
      level: country.level,
      trend,
      summary: buildSummary(country, trend),
      drivers: buildDrivers(country),
      confidence,
      score: country.score,
      inputMode
    };
  });
}
