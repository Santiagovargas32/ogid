import apiQuotaTracker from "../admin/apiQuotaTrackerService.js";
import { resolveBandByProviderSnapshots } from "../refreshPolicyService.js";
import { createLogger } from "../../utils/logger.js";
import { fetchTwelveDailyCandles, fetchTwelveQuotes } from "./providers/twelveProvider.js";
import { fetchYahooDailyCandles, fetchYahooQuotes } from "./providers/yahooProvider.js";
import { buildFallbackQuote } from "./providers/quoteFallback.js";
import { isMarketOpenEt } from "./marketSessionService.js";
import { buildCoverageByMode } from "./quoteMetadata.js";
import { decorateCanonicalQuote, findMetadataDiscrepancies, getInstrumentById, getProviderSymbol, resolveInstrument, resolveInstrumentSession, resolveVerifiedInstrumentReferences } from "./instrumentRegistry.js";
import { normalizeCanonicalCandle } from "./canonicalCandle.js";

const log = createLogger("backend/services/market/marketProviderRouter");

const PROVIDERS = Object.freeze({
  twelve: {
    fetcher: fetchTwelveQuotes,
    transport: "api",
    estimateUnits: (tickers = []) => Math.max(0, Array.isArray(tickers) ? tickers.length : 0)
  },
  yahoo: {
    fetcher: fetchYahooQuotes,
    transport: "server-library",
    estimateUnits: () => 0
  }
});

const DAILY_CANDLE_FETCHERS = Object.freeze({ twelve: fetchTwelveDailyCandles, yahoo: fetchYahooDailyCandles });

function buildDisabledCoverageByMode() {
  return {
    live: 0,
    webDelayed: 0,
    historicalEod: 0,
    routerStale: 0,
    syntheticFallback: 0
  };
}

function buildMarketSession(timestamp = new Date().toISOString()) {
  const now = new Date(timestamp);
  const open = isMarketOpenEt(now);
  return {
    open,
    state: open ? "open" : "closed",
    checkedAt: timestamp,
    timezone: "America/New_York"
  };
}

function normalizeProvider(value = "") {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized in PROVIDERS ? normalized : "";
}

function resolveDefaultFallbackProvider(primaryProvider = "") {
  return primaryProvider === "twelve" ? "yahoo" : "";
}

function buildProviderChain(primaryProvider = "", fallbackProvider = "") {
  return [primaryProvider, fallbackProvider].filter(Boolean).join("+") || null;
}

function buildProviderConfig(provider, config = {}, session = null) {
  if (provider === "twelve") {
    return {
      baseUrl: config.twelveBaseUrl,
      apiKey: config.twelveApiKey,
      enablePrepost: config.twelveEnablePrepost === true,
      session
    };
  }

  return {
    baseUrl: config.yahooBaseUrl,
    userAgent: config.yahooUserAgent,
    marketDataService: config.marketDataService,
    session
  };
}

function buildAvailabilityFailure(reason = "unavailable", snapshot = null, estimatedUnits = 0, skipWindow = null) {
  return {
    available: false,
    snapshot,
    estimatedUnits,
    reason,
    skipReason: reason,
    skipWindow: skipWindow || null,
    remainingDay: snapshot?.effectiveRemainingDay ?? null,
    remainingMinute: snapshot?.effectiveRemainingMinute ?? null
  };
}

function describeAvailabilityFailure(provider, availability = {}) {
  const reason = availability?.reason || "unavailable";
  const estimatedUnits = Number(availability?.estimatedUnits || 0);
  const skipWindow = availability?.skipWindow || null;
  const scopeLabel = skipWindow === "minute" ? "minute" : skipWindow === "day" ? "daily" : "available";

  if (reason === "insufficient-minute-credits" || reason === "insufficient-daily-credits") {
    return `${provider} was skipped because remaining ${scopeLabel} credits cannot cover ${estimatedUnits} requested units.`;
  }
  if (reason === "reserve-floor-minute" || reason === "reserve-floor-day") {
    return `${provider} was skipped because the request would cross the ${scopeLabel} reserve floor.`;
  }
  if (reason === "exhausted") {
    return `${provider} was skipped because ${scopeLabel} quota is exhausted.`;
  }
  return `${provider} was skipped because quota is unavailable.`;
}

function resolveProviderAvailability(provider, config = {}, { reserve = 0, allowExhaustedProviders = false, tickers = [] } = {}) {
  const snapshot = apiQuotaTracker.getProviderSnapshot(provider);
  const normalizedReserve = Math.max(0, Number.parseInt(String(reserve ?? 0), 10) || 0);
  const estimatedUnits = PROVIDERS[provider]?.estimateUnits?.(tickers) ?? 0;
  const remainingDay = snapshot?.effectiveRemainingDay;
  const remainingMinute = snapshot?.effectiveRemainingMinute;

  if (allowExhaustedProviders) {
    return {
      available: true,
      snapshot,
      estimatedUnits,
      reason: null,
      skipReason: null,
      skipWindow: null,
      remainingDay,
      remainingMinute
    };
  }

  if (snapshot?.exhaustedMinute || (Number.isFinite(remainingMinute) && remainingMinute <= 0)) {
    return buildAvailabilityFailure("exhausted", snapshot, estimatedUnits, "minute");
  }
  if (snapshot?.exhaustedDay || (Number.isFinite(remainingDay) && remainingDay <= 0)) {
    return buildAvailabilityFailure("exhausted", snapshot, estimatedUnits, "day");
  }
  if (Number.isFinite(remainingMinute) && remainingMinute < estimatedUnits) {
    return buildAvailabilityFailure("insufficient-minute-credits", snapshot, estimatedUnits, "minute");
  }
  if (Number.isFinite(remainingDay) && remainingDay < estimatedUnits) {
    return buildAvailabilityFailure("insufficient-daily-credits", snapshot, estimatedUnits, "day");
  }
  if (Number.isFinite(remainingMinute) && remainingMinute - estimatedUnits < normalizedReserve) {
    return buildAvailabilityFailure("reserve-floor-minute", snapshot, estimatedUnits, "minute");
  }
  if (Number.isFinite(remainingDay) && remainingDay - estimatedUnits < normalizedReserve) {
    return buildAvailabilityFailure("reserve-floor-day", snapshot, estimatedUnits, "day");
  }

  return {
    available: true,
    snapshot,
    estimatedUnits,
    reason: null,
    skipReason: null,
    skipWindow: null,
    remainingDay,
    remainingMinute
  };
}

function buildStaleQuote(previousQuote, { timestamp, staleTtlMs }) {
  if (!previousQuote || !Number.isFinite(previousQuote.price)) {
    return null;
  }

  const asOfValue = previousQuote.asOf || previousQuote.updatedAt;
  const asOfTime = new Date(asOfValue || 0).getTime();
  const ttlMs = Math.max(0, Number.parseInt(String(staleTtlMs ?? 0), 10) || 0);
  if (!Number.isFinite(asOfTime)) {
    return null;
  }

  if (ttlMs > 0 && Date.now() - asOfTime > ttlMs) {
    return null;
  }

  return {
    ...previousQuote,
    synthetic: false,
    dataMode: "stale",
    providerDataMode: "router-stale",
    staleAt: timestamp
  };
}

function buildFallbackSet(unresolved, timestamp) {
  return Object.fromEntries(unresolved.map((ticker) => [ticker, buildFallbackQuote(ticker, timestamp)]));
}

function resolveProviderStatus(result = null, { idle = false, skipped = false, disabled = false } = {}) {
  if (disabled) {
    return "disabled";
  }
  if (skipped) {
    return "skipped";
  }
  if (idle) {
    return "idle";
  }
  if (!result) {
    return "idle";
  }

  const returnedCount = Number((result.returnedTickers || []).length || 0);
  const missingCount = Number((result.missingTickers || []).length || 0);
  const errorCount = Number((result.errors || []).length || 0);

  if (returnedCount <= 0) {
    return errorCount > 0 ? "error" : "empty";
  }
  if (missingCount > 0 || errorCount > 0) {
    return "partial";
  }
  return "ok";
}

function buildSampleQuotes(quotes = {}, orderedTickers = [], maxItems = 5) {
  const order = [...new Set((orderedTickers || []).map((ticker) => String(ticker || "").toUpperCase()).filter(Boolean))];
  return order
    .map((ticker) => {
      const quote = quotes?.[ticker];
      if (!quote) {
        return null;
      }
      return {
        ticker,
        price: Number.isFinite(Number(quote.price)) ? Number(quote.price) : null,
        asOf: quote.asOf || quote.updatedAt || null,
        source: quote.source || null,
        sourceDetail: quote.sourceDetail || null,
        dataMode: quote.dataMode || null,
        providerScore: Number.isFinite(Number(quote.providerScore)) ? Number(quote.providerScore) : null,
        providerLatencyMs: Number.isFinite(Number(quote.providerLatencyMs)) ? Number(quote.providerLatencyMs) : null,
        marketState: quote.marketState || null
      };
    })
    .filter(Boolean)
    .slice(0, maxItems);
}

function buildProviderSlot({
  role,
  provider,
  requestResult = null,
  configuredBaseUrl = null,
  quotaSnapshot = null,
  requestedTickers = [],
  statusOverride = null,
  marketEnabled = true
} = {}) {
  const transport = PROVIDERS[provider]?.transport || null;
  const status = statusOverride || resolveProviderStatus(requestResult, { disabled: marketEnabled === false });
  const result = requestResult || {};
  const errors = Array.isArray(result.errors) ? result.errors : [];
  const sampleQuotes = buildSampleQuotes(result.quotes || {}, requestedTickers, 5);
  const resolvedQuotaSnapshot = quotaSnapshot || result.quotaSnapshot || apiQuotaTracker.getProviderSnapshot(provider);

  return {
    role,
    provider,
    transport,
    configuredBaseUrl,
    status,
    requestMode: result.requestMode || (status === "idle" ? "standby" : "unavailable"),
    returnedTickers: result.returnedTickers || [],
    missingTickers: result.missingTickers || [],
    score: Number.isFinite(Number(result.score)) ? Number(result.score) : 0,
    latencyMs: Number.isFinite(Number(result.durationMs)) ? Number(result.durationMs) : 0,
    quotaSnapshot: resolvedQuotaSnapshot,
    estimatedUnits:
      Number.isFinite(Number(result.estimatedUnits))
        ? Number(result.estimatedUnits)
        : PROVIDERS[provider]?.estimateUnits?.(requestedTickers) ?? null,
    remainingDay:
      Number.isFinite(Number(result.remainingDay)) || Number(result.remainingDay) === 0
        ? Number(result.remainingDay)
        : resolvedQuotaSnapshot?.effectiveRemainingDay ?? null,
    remainingMinute:
      Number.isFinite(Number(result.remainingMinute)) || Number(result.remainingMinute) === 0
        ? Number(result.remainingMinute)
        : resolvedQuotaSnapshot?.effectiveRemainingMinute ?? null,
    skipReason: result.skipReason || errors.at(-1)?.code || errors.at(-1)?.reason || null,
    skipWindow: result.skipWindow || null,
    upstreamPaused: result.upstreamPaused === true,
    requestUrls: result.requestUrls || [],
    httpStatus: Number.isFinite(Number(result.httpStatus)) ? Number(result.httpStatus) : null,
    errorCode: errors.at(-1)?.code || errors.at(-1)?.reason || null,
    errorMessage: errors.at(-1)?.message || null,
    responsePreview: result.responsePreview || errors.at(-1)?.responsePreview || null,
    sampleQuotes,
    lastAttemptAt: result.lastAttemptAt || null,
    lastSuccessAt: result.lastSuccessAt || null
  };
}

function buildSkippedSlot({
  role,
  provider,
  requestedTickers = [],
  availability,
  configuredBaseUrl = null
} = {}) {
  const reason = availability?.reason || "unavailable";
  const message = describeAvailabilityFailure(provider, availability);

  return buildProviderSlot({
    role,
    provider,
    configuredBaseUrl,
    quotaSnapshot: availability?.snapshot || apiQuotaTracker.getProviderSnapshot(provider),
    requestedTickers,
    statusOverride: "skipped",
    requestResult: {
      requestMode: "unavailable",
      returnedTickers: [],
      missingTickers: requestedTickers,
      score: 0,
      durationMs: 0,
      requestUrls: [],
      httpStatus: null,
      lastAttemptAt: new Date().toISOString(),
      lastSuccessAt: null,
      estimatedUnits: availability?.estimatedUnits ?? null,
      remainingDay: availability?.remainingDay ?? null,
      remainingMinute: availability?.remainingMinute ?? null,
      skipReason: reason,
      skipWindow: availability?.skipWindow || null,
      errors: [
        {
          provider,
          code: reason,
          reason,
          message
        }
      ]
    }
  });
}

function resolveSourceMode(providerCount, totalCount) {
  if (providerCount <= 0) {
    return "fallback";
  }
  if (providerCount >= totalCount) {
    return "live";
  }
  return "mixed";
}

function resolveRouterFallbackReason({ providersSkipped = [], usedStaleQuotes = [], syntheticFallbackTickers = [], errors = [] }) {
  if (syntheticFallbackTickers.length) {
    return "synthetic-fallback";
  }
  if (usedStaleQuotes.length) {
    return "router-stale";
  }
  if (providersSkipped.length) {
    return providersSkipped.map((item) => `${item.provider}:${item.reason}`).join(", ");
  }
  if ((errors || []).length) {
    return errors.map((error) => `${error.provider}:${error.code || error.reason || "error"}`).join(", ");
  }
  return null;
}

function buildDisabledProviderSlots(config = {}) {
  const slots = [];
  if (config.provider) {
    slots.push(
      buildProviderSlot({
        role: "primary",
        provider: config.provider,
        configuredBaseUrl: config.provider === "twelve" ? config.twelveBaseUrl : config.yahooBaseUrl,
        requestedTickers: config.tickers || [],
        marketEnabled: false
      })
    );
  }
  if (config.fallbackProvider) {
    slots.push(
      buildProviderSlot({
        role: "fallback",
        provider: config.fallbackProvider,
        configuredBaseUrl: config.fallbackProvider === "twelve" ? config.twelveBaseUrl : config.yahooBaseUrl,
        requestedTickers: config.tickers || [],
        marketEnabled: false
      })
    );
  }
  return slots;
}

function buildDisabledMarketResult(config = {}, timestamp = new Date().toISOString()) {
  const resolution = resolveVerifiedInstrumentReferences(config.tickers || []);
  const tickers = resolution.instruments.map((instrument) => instrument.canonicalSymbol);
  const batchSize = Number.parseInt(String(config.batchChunkSize ?? 25), 10) || 25;
  const session = buildMarketSession(timestamp);
  const providerChain = buildProviderChain(config.provider, config.fallbackProvider);

  return {
    provider: "disabled",
    sourceMode: "disabled",
    revision: null,
    session,
    sourceMeta: {
      enabled: false,
      provider: "disabled",
      providerChain,
      configuredProvider: config.provider || null,
      configuredFallbackProvider: config.fallbackProvider || null,
      effectiveProvider: null,
      providerScore: 0,
      providersUsed: [],
      providersSkipped: [],
      liveCount: 0,
      totalTickers: tickers.length,
      fallbackCount: 0,
      unresolvedTickers: tickers,
      usedStaleQuotes: [],
      coverageByMode: buildDisabledCoverageByMode(),
      quotaBand: null,
      requestMode: "disabled",
      batchSize,
      lastUpstreamError: null,
      errors: [],
      providerErrors: [],
      providerSlots: buildDisabledProviderSlots(config),
      routerDecision: {
        attemptedOrder: [],
        providersSkipped: [],
        usedStaleQuotes: [],
        syntheticFallbackTickers: [],
        fallbackReason: config.disabledReason || "market-provider-empty"
      },
      disabledReason: config.disabledReason || "market-provider-empty",
      marketSession: session,
      providerScores: {}
    },
    quotes: Object.fromEntries(
      tickers.map((ticker) => [
        ticker,
        decorateCanonicalQuote({
          price: null,
          changePct: 0,
          asOf: null,
          source: "disabled",
          synthetic: true,
          dataMode: "synthetic",
          providerDataMode: "synthetic-fallback",
          providerScore: 0,
          providerLatencyMs: null
        }, resolveInstrument(ticker), { fetchedAt: timestamp, session: resolveInstrumentSession(resolveInstrument(ticker), session) })
      ])
    ),
    activeTickers: tickers,
    historicalSeries: {},
    updatedAt: timestamp
  };
}

export async function fetchMarketQuotes(config = {}) {
  if (config.enabled === false) {
    return buildDisabledMarketResult(config);
  }

  const instrumentResolution = resolveVerifiedInstrumentReferences(config.tickers || []);
  const instruments = config.watchlistService?.applySelection?.(instrumentResolution.instruments) || instrumentResolution.instruments;
  const tickers = instruments.map((instrument) => instrument.canonicalSymbol);
  const creditScheduler = config.creditScheduler || null;
  let creditProjection = creditScheduler?.plan?.({ instruments, trigger: config.trigger || "scheduled-market" }) || null;
  const creditRejections = [];
  const timestampSource = config.timestamp || new Date().toISOString();
  const parsedTimestamp = new Date(timestampSource);
  const timestamp = Number.isFinite(parsedTimestamp.getTime()) ? parsedTimestamp.toISOString() : new Date().toISOString();
  const session = buildMarketSession(timestamp);
  const primaryProvider = normalizeProvider(config.provider);
  const fallbackProvider = normalizeProvider(config.fallbackProvider || resolveDefaultFallbackProvider(primaryProvider));
  const providerChain = buildProviderChain(primaryProvider, fallbackProvider);

  if (!primaryProvider) {
    return buildDisabledMarketResult({
      ...config,
      provider: "",
      fallbackProvider: "",
      disabledReason: config.disabledReason || "market-provider-invalid"
    });
  }

  const attemptedOrder = [...new Set([primaryProvider, fallbackProvider].filter(Boolean))];
  const requestReserve = Math.max(0, Number.parseInt(String(config.requestReserve ?? 0), 10) || 0);
  const staleTtlMs = Math.max(0, Number.parseInt(String(config.staleTtlMs ?? 0), 10) || 0);
  const previousQuotes = config.previousQuotes || {};
  const mergedQuotes = {};
  const historicalSeries = {};
  const providersUsed = [];
  const providersSkipped = [];
  const providerErrors = [];
  const providerResults = {};
  let unresolved = instruments.map((instrument) => instrument.instrumentId);
  let lastUpstreamError = null;

  for (const provider of attemptedOrder) {
    if (!unresolved.length) {
      break;
    }

    const role = provider === primaryProvider ? "primary" : "fallback";
    const configuredBaseUrl = provider === "twelve" ? config.twelveBaseUrl : config.yahooBaseUrl;
    const availability = provider === "yahoo" ? {
      available: true,
      snapshot: null,
      estimatedUnits: 0,
      reason: null,
      remainingDay: null,
      remainingMinute: null
    } : provider === "twelve" && creditScheduler ? {
      available: true,
      snapshot: apiQuotaTracker.getProviderSnapshot(provider),
      estimatedUnits: creditProjection?.predictedCreditsMinute || 0,
      reason: null,
      remainingDay: creditScheduler.snapshot().policy.internalHardLimit - creditScheduler.snapshot().consumedDay,
      remainingMinute: creditScheduler.snapshot().policy.absoluteMinuteLimit - creditScheduler.snapshot().consumedMinute
    } : resolveProviderAvailability(provider, config, {
      reserve: requestReserve,
      allowExhaustedProviders: config.allowExhaustedProviders === true,
      tickers: unresolved
    });

    if (!availability.available) {
      providersSkipped.push({
        provider,
        reason: availability.reason,
        skipReason: availability.skipReason || availability.reason || null,
        skipWindow: availability.skipWindow || null,
        remaining: availability.snapshot?.effectiveRemaining ?? null,
        remainingDay: availability.remainingDay ?? null,
        remainingMinute: availability.remainingMinute ?? null,
        estimatedUnits: availability.estimatedUnits,
        transport: PROVIDERS[provider]?.transport || null
      });
      providerResults[provider] = buildSkippedSlot({
        role,
        provider,
        requestedTickers: unresolved.map((instrumentId) => getInstrumentById(instrumentId)?.canonicalSymbol).filter(Boolean),
        availability,
        configuredBaseUrl
      });
      continue;
    }

    const mappings = unresolved.map((instrumentId) => {
      const instrument = getInstrumentById(instrumentId);
      return { instrument, instrumentId, canonicalSymbol: instrument?.canonicalSymbol || null, providerSymbol: instrument ? getProviderSymbol(instrument.instrumentId, provider) : null };
    });
    const mappedRequests = mappings.filter((mapping) => mapping.providerSymbol);
    if (!mappedRequests.length) {
      providersSkipped.push({ provider, reason: "provider-symbol-missing", estimatedUnits: 0, transport: PROVIDERS[provider]?.transport || null });
      continue;
    }

    let rawProviderResult;
    if (provider === "twelve" && creditScheduler) {
      creditProjection = creditScheduler.plan({ instruments: mappedRequests.map((mapping) => mapping.instrument), trigger: config.trigger || "scheduled-market" });
      const allowedIds = new Set(creditProjection.batches.flatMap((batch) => batch.instruments.map((instrument) => instrument.instrumentId)));
      const scheduledMappings = mappedRequests.filter((mapping) => allowedIds.has(mapping.instrument.instrumentId));
      const dedupeKey = `twelve:quote:${scheduledMappings.map((mapping) => mapping.providerSymbol).sort().join(",")}`;
      const execution = await creditScheduler.deduplicate(dedupeKey, async () => {
        const attempts = [];
        const rejections = [];
        for (const batch of creditProjection.batches) {
          await creditScheduler.waitUntil(batch.scheduledAt);
          const batchIds = new Set(batch.instruments.map((instrument) => instrument.instrumentId));
          const batchMappings = scheduledMappings.filter((mapping) => batchIds.has(mapping.instrument.instrumentId));
          const leaseResult = creditScheduler.acquireLease({
            symbols: batchMappings.map((mapping) => mapping.providerSymbol),
            instrumentIds: batchMappings.map((mapping) => mapping.instrumentId),
            tier: batch.tier,
            trigger: config.trigger || "scheduled-market"
          });
          if (!leaseResult.accepted) { rejections.push(leaseResult); continue; }
          const result = await PROVIDERS[provider].fetcher({
            ...buildProviderConfig(provider, config, session),
            tickers: batchMappings.map((mapping) => mapping.providerSymbol),
            timeoutMs: config.timeoutMs,
            timestamp
          });
          creditScheduler.commitLease(leaseResult.lease.leaseId, {
            status: result.errors?.length ? "error" : "success",
            headers: {
              "api-credits-used": result.quotaSnapshot?.apiCreditsUsed,
              "api-credits-left": result.quotaSnapshot?.apiCreditsLeft,
              "retry-after": result.retryAfterMs ? new Date(creditScheduler.now() + result.retryAfterMs).toUTCString() : null
            }
          });
          attempts.push(result);
        }
        if (!attempts.length) return { result: null, rejections };
        const quotes = Object.assign({}, ...attempts.map((attempt) => attempt.quotes || {}));
        const requestedTickers = scheduledMappings.map((mapping) => mapping.providerSymbol);
        return {
          rejections,
          result: {
            ...attempts.at(-1),
            quotes,
            requestedTickers,
            returnedTickers: Object.keys(quotes),
            missingTickers: requestedTickers.filter((ticker) => !quotes[ticker]),
            requestUrls: attempts.flatMap((attempt) => attempt.requestUrls || []),
            errors: attempts.flatMap((attempt) => attempt.errors || []),
            durationMs: attempts.reduce((total, attempt) => total + (attempt.durationMs || 0), 0)
          }
        };
      });
      creditRejections.push(...execution.rejections);
      if (!execution.result) {
        const rejection = execution.rejections.at(-1) || { reason: "credit-plan-empty", cost: 0, nextEligibleAt: creditProjection.nextValidExecutionAt };
        providersSkipped.push({ provider, reason: rejection.reason, nextEligibleAt: rejection.nextEligibleAt, estimatedUnits: rejection.cost, transport: "api" });
        providerResults[provider] = buildSkippedSlot({ role, provider, requestedTickers: scheduledMappings.map((mapping) => mapping.canonicalSymbol), availability: { ...rejection, available: false, estimatedUnits: rejection.cost }, configuredBaseUrl });
        continue;
      }
      rawProviderResult = execution.result;
    } else {
      rawProviderResult = await PROVIDERS[provider].fetcher({
        ...buildProviderConfig(provider, config, session),
        tickers: mappedRequests.map((mapping) => mapping.providerSymbol),
        timeoutMs: config.timeoutMs,
        timestamp
      });
    }
    const mappedQuotes = {};
    const metadataDiscrepancies = [];
    for (const mapping of mappedRequests) {
      const quote = rawProviderResult.quotes?.[mapping.providerSymbol];
      if (!quote) continue;
      metadataDiscrepancies.push(...findMetadataDiscrepancies(mapping.instrument, quote.providerMetadata).map((item) => ({
        code: "provider-metadata-mismatch", instrumentId: mapping.instrument.instrumentId, provider, ...item
      })));
      mappedQuotes[mapping.canonicalSymbol] = decorateCanonicalQuote(quote, mapping.instrument, {
        providerId: provider,
        providerSymbol: mapping.providerSymbol,
        fetchedAt: timestamp,
        session: resolveInstrumentSession(mapping.instrument, session)
      });
    }
    const unexpectedProviderSymbols = Object.keys(rawProviderResult.quotes || {}).filter(
      (providerSymbol) => !mappedRequests.some((mapping) => mapping.providerSymbol === providerSymbol)
    );
    const providerResult = {
      ...rawProviderResult,
      quotes: mappedQuotes,
      returnedTickers: Object.keys(mappedQuotes),
      missingTickers: mappings.filter((mapping) => !mappedQuotes[mapping.canonicalSymbol]).map((mapping) => mapping.canonicalSymbol),
      errors: [
        ...(rawProviderResult.errors || []),
        ...metadataDiscrepancies,
        ...unexpectedProviderSymbols.map((providerSymbol) => ({ code: "unexpected-provider-symbol", providerSymbol }))
      ]
    };

    providersUsed.push(provider);
    providerResults[provider] = buildProviderSlot({
      role,
      provider,
      requestResult: providerResult,
      configuredBaseUrl,
      quotaSnapshot: providerResult.quotaSnapshot,
      requestedTickers: mappings.map((mapping) => mapping.canonicalSymbol)
    });
    Object.assign(mergedQuotes, providerResult.quotes || {});
    Object.assign(historicalSeries, providerResult.historicalSeries || {});
    providerErrors.push(
      ...(providerResult.errors || []).map((error) => ({
        provider,
        ...error,
        code: error.code || error.reason || "unknown-error",
        reason: error.reason || error.code || "unknown-error"
      }))
    );
    const providerErrorCode = providerResult.errors?.at(-1)?.code || providerResult.errors?.at(-1)?.reason || null;
    if (providerErrorCode) {
      lastUpstreamError = providerErrorCode;
    }
    unresolved = unresolved.filter((instrumentId) => {
      const instrument = getInstrumentById(instrumentId);
      return !instrument || !providerResult.quotes?.[instrument.canonicalSymbol];
    });
  }

  for (const provider of attemptedOrder) {
    if (providerResults[provider]) {
      continue;
    }
    const role = provider === primaryProvider ? "primary" : "fallback";
    providerResults[provider] = buildProviderSlot({
      role,
      provider,
      configuredBaseUrl: provider === "twelve" ? config.twelveBaseUrl : config.yahooBaseUrl,
      requestedTickers: tickers,
      statusOverride: "idle"
    });
  }

  const staleQuotes = {};
  if (unresolved.length && staleTtlMs > 0) {
    for (const instrumentId of unresolved) {
      const instrument = getInstrumentById(instrumentId);
      const ticker = instrument?.canonicalSymbol;
      if (!ticker) continue;
      const staleQuote = buildStaleQuote(previousQuotes[ticker], {
        timestamp,
        staleTtlMs
      });
      if (!staleQuote) {
        continue;
      }
      staleQuotes[ticker] = staleQuote;
      mergedQuotes[ticker] = decorateCanonicalQuote(staleQuote, instrument, {
        providerId: staleQuote.sourceDetail || staleQuote.source,
        providerSymbol: staleQuote.providerSymbol || ticker,
        fetchedAt: timestamp,
        session: resolveInstrumentSession(instrument, session)
      });
    }
    unresolved = unresolved.filter((instrumentId) => !staleQuotes[getInstrumentById(instrumentId)?.canonicalSymbol]);
  }

  const syntheticFallbackTickers = unresolved.map((instrumentId) => getInstrumentById(instrumentId)?.canonicalSymbol).filter(Boolean);
  if (syntheticFallbackTickers.length) {
    const fallbackSet = buildFallbackSet(syntheticFallbackTickers, timestamp);
    for (const ticker of syntheticFallbackTickers) {
      const instrument = resolveInstrument(ticker);
      mergedQuotes[ticker] = decorateCanonicalQuote(fallbackSet[ticker], instrument, {
        providerId: "fallback",
        providerSymbol: null,
        fetchedAt: timestamp,
        session: resolveInstrumentSession(instrument, session)
      });
    }
  }

  const coverageByMode = buildCoverageByMode(mergedQuotes);
  const providerBackedCount = coverageByMode.live + coverageByMode.webDelayed;
  const fallbackCount = coverageByMode.routerStale + coverageByMode.syntheticFallback;
  const usedStaleQuotes = Object.keys(staleQuotes);

  const providerSlots = attemptedOrder.map((provider) => providerResults[provider]).filter(Boolean);
  const effectiveProvider =
    providerSlots
      .filter((slot) => Number((slot.returnedTickers || []).length || 0) > 0)
      .sort((left, right) => {
        const leftReturned = Number((left.returnedTickers || []).length || 0);
        const rightReturned = Number((right.returnedTickers || []).length || 0);
        if (rightReturned !== leftReturned) {
          return rightReturned - leftReturned;
        }
        if ((right.score || 0) !== (left.score || 0)) {
          return (right.score || 0) - (left.score || 0);
        }
        return (left.latencyMs || Number.MAX_SAFE_INTEGER) - (right.latencyMs || Number.MAX_SAFE_INTEGER);
      })[0]?.provider || null;
  const effectiveSlot = providerSlots.find((slot) => slot.provider === effectiveProvider) || null;
  const providerSnapshots = attemptedOrder
    .map((provider) => apiQuotaTracker.getProviderSnapshot(provider))
    .filter(Boolean);
  const quotaBand = resolveBandByProviderSnapshots(providerSnapshots);
  const requestMode = [
    ...new Set(
      providerSlots
        .map((slot) => slot.requestMode)
        .filter((mode) => mode && mode !== "standby")
    )
  ].join("+") || "unavailable";
  const routerDecision = {
    attemptedOrder,
    providersSkipped,
    usedStaleQuotes,
    syntheticFallbackTickers,
    fallbackReason: resolveRouterFallbackReason({
      providersSkipped,
      usedStaleQuotes,
      syntheticFallbackTickers,
      errors: providerErrors
    })
  };

  log.info("market_router_completed", {
    providerChain,
    effectiveProvider,
    providersUsed,
    providersSkipped,
    liveCount: coverageByMode.live,
    fallbackCount,
    totalTickers: tickers.length,
    quotaBand,
    sourceMode: resolveSourceMode(providerBackedCount, tickers.length)
  });

  return {
    provider: providerChain || primaryProvider,
    sourceMode: resolveSourceMode(providerBackedCount, tickers.length),
    sourceMeta: {
      enabled: true,
      provider: providerChain || primaryProvider,
      providerChain,
      configuredProvider: primaryProvider,
      configuredFallbackProvider: fallbackProvider || null,
      effectiveProvider,
      providerScore: effectiveSlot?.score ?? 0,
      providerLatencyMs: effectiveSlot?.latencyMs ?? null,
      marketSession: session,
      session,
      providerScores: Object.fromEntries(providerSlots.map((slot) => [slot.provider, slot.score || 0])),
      providersUsed,
      providersSkipped,
      liveCount: coverageByMode.live,
      delayedCount: coverageByMode.webDelayed,
      webDelayedCount: coverageByMode.webDelayed,
      totalTickers: tickers.length,
      fallbackCount,
      unresolvedTickers: syntheticFallbackTickers,
      usedStaleQuotes,
      coverageByMode,
      quotaBand,
      requestMode,
      upstreamPaused: false,
      pauseReason: null,
      batchSize: Number.parseInt(String(config.batchChunkSize ?? 25), 10) || 25,
      lastUpstreamError,
      errors: providerErrors,
      providerErrors,
      rejectedInstrumentReferences: instrumentResolution.rejected,
      creditProjection,
      creditMetrics: creditScheduler?.snapshot?.() || null,
      creditRejections,
      providerSlots,
      routerDecision
    },
    quotes: mergedQuotes,
    activeTickers: tickers,
    historicalSeries,
    updatedAt: timestamp,
    session,
    revision: null
  };
}

export async function fetchDailyCandles(config = {}) {
  const timestamp = new Date(config.timestamp || Date.now()).toISOString(); const scheduler = config.creditScheduler;
  const interval = config.interval || "1day";
  const references = Array.isArray(config.instrumentIds) ? config.instrumentIds : [];
  const resolution = resolveVerifiedInstrumentReferences(references); const instruments = resolution.instruments;
  const provider = normalizeProvider(config.provider || "twelve");
  if (provider === "yahoo") {
    const symbols = instruments.map((instrument) => getProviderSymbol(instrument.instrumentId, provider));
    const result = await DAILY_CANDLE_FETCHERS.yahoo({
      symbols,
      outputsize: config.outputsize,
      period: config.period,
      adjustmentMode: config.adjustmentMode || "splits",
      interval,
      timeoutMs: config.timeoutMs,
      timestamp,
      marketDataService: config.marketDataService,
      force: config.force === true
    });
    const candles = [];
    const errors = [...(result.errors || [])];
    const durationMs = interval === "5min" ? 300_000 : interval === "15min" ? 900_000 : interval === "30min" ? 1_800_000 : interval === "1h" ? 3_600_000 : interval === "1day" ? 86_400_000 : null;
    for (const instrument of instruments) {
      const providerSymbol = getProviderSymbol(instrument.instrumentId, provider);
      const series = result.candlesBySymbol?.[providerSymbol];
      if (!series) {
        errors.push({ code: "daily-symbol-missing", instrumentId: instrument.instrumentId, providerSymbol });
        continue;
      }
      for (const value of series.values || []) {
        const openTime = new Date(value.datetime);
        const closeTime = durationMs && Number.isFinite(openTime.getTime())
          ? new Date(openTime.getTime() + durationMs).toISOString()
          : null;
        const timeFields = interval === "1day"
          ? { date: String(value.datetime || "").slice(0, 10), datetime: value.datetime }
          : {
              openTime: Number.isFinite(openTime.getTime()) ? openTime.toISOString() : null,
              closeTime
            };
        const normalized = normalizeCanonicalCandle({
          instrumentId: instrument.instrumentId,
          interval,
          ...timeFields,
          open: value.open,
          high: value.high,
          low: value.low,
          close: value.close,
          volume: value.volume,
          currency: instrument.currency,
          source: provider,
          providerSymbol,
          dataMode: series.meta?.stale ? "stale" : "observed",
          session: instrument.sessionPolicy
        }, { instrument, fetchedAt: result.fetchedAt || timestamp, source: provider, providerSymbol, adjustmentMode: config.adjustmentMode || "splits" });
        if (normalized.valid) candles.push(normalized.candle);
        else errors.push({ code: "daily-candle-invalid", instrumentId: instrument.instrumentId, providerSymbol, details: normalized.errors });
      }
    }
    return {
      candles,
      errors,
      rejectedInstrumentReferences: resolution.rejected,
      creditRejections: [],
      persistedByProvider: true,
      persistence: result.persistence,
      fetchedAt: result.fetchedAt || timestamp,
      source: provider,
      methodVersion: interval === "1day" ? "daily-candle-v1" : "intraday-candle-v1"
    };
  }
  if (provider !== "twelve") return { candles: [], errors: [{ code: "daily-provider-unsupported", provider }], rejectedInstrumentReferences: resolution.rejected, creditRejections: [], fetchedAt: timestamp };
  if (!scheduler) return { candles: [], errors: [{ code: "credit-authority-missing" }], rejectedInstrumentReferences: resolution.rejected, creditRejections: [], fetchedAt: timestamp };
  const maxBatchSymbols = Math.max(1, Math.floor((scheduler.policy.normalMinuteLimit - scheduler.policy.costPerOperation) / scheduler.policy.costPerSymbol)); const batches = [];
  for (let index = 0; index < instruments.length; index += maxBatchSymbols) batches.push(instruments.slice(index, index + maxBatchSymbols));
  const candles = []; const errors = []; const creditRejections = [];
  for (let index = 0; index < batches.length; index += 1) {
    if (index > 0) await scheduler.waitUntil(new Date((Math.floor(scheduler.now() / 60_000) + 1) * 60_000).toISOString());
    const batch = batches[index]; const symbols = batch.map((instrument) => getProviderSymbol(instrument.instrumentId, provider));
    const key = `${provider}:time_series:${interval}:${config.adjustmentMode || "splits"}:${symbols.slice().sort().join(",")}:${config.outputsize || 5}`;
    const execution = await scheduler.deduplicate(key, async () => {
      const lease = scheduler.acquireLease({ symbols, instrumentIds: batch.map((instrument) => instrument.instrumentId), tier: "normal", trigger: config.trigger || "scheduled-daily-candles", operation: "time_series" });
      if (!lease.accepted) return { lease, result: null };
      const result = await DAILY_CANDLE_FETCHERS[provider]({ baseUrl: config.twelveBaseUrl, apiKey: config.twelveApiKey, symbols, outputsize: config.outputsize, adjustmentMode: config.adjustmentMode || "splits", interval, timeoutMs: config.timeoutMs, timestamp });
      scheduler.commitLease(lease.lease.leaseId, { status: result.errors?.length ? "error" : "success", headers: { "api-credits-used": result.quotaSnapshot?.apiCreditsUsed, "api-credits-left": result.quotaSnapshot?.apiCreditsLeft, "retry-after": result.retryAfterMs ? new Date(scheduler.now() + result.retryAfterMs).toUTCString() : null } });
      return { lease, result };
    });
    if (!execution.lease.accepted) { creditRejections.push(execution.lease); continue; }
    errors.push(...(execution.result.errors || []));
    for (const instrument of batch) {
      const providerSymbol = getProviderSymbol(instrument.instrumentId, provider); const series = execution.result.candlesBySymbol?.[providerSymbol];
      if (!series) { errors.push({ code: "daily-symbol-missing", instrumentId: instrument.instrumentId, providerSymbol }); continue; }
      for (const value of series.values || []) {
        const normalized = normalizeCanonicalCandle({ instrumentId: instrument.instrumentId, interval, datetime: value.datetime, date: String(value.datetime || "").slice(0, 10), open: value.open, high: value.high, low: value.low, close: value.close, volume: value.volume, currency: series.meta?.currency || instrument.currency, source: provider, providerSymbol, dataMode: "observed" }, { instrument, fetchedAt: timestamp, source: provider, providerSymbol, adjustmentMode: config.adjustmentMode || "splits" });
        if (normalized.valid) candles.push(normalized.candle); else errors.push({ code: "daily-candle-invalid", instrumentId: instrument.instrumentId, providerSymbol, details: normalized.errors });
      }
    }
  }
  return { candles, errors, rejectedInstrumentReferences: resolution.rejected, creditRejections, fetchedAt: timestamp, source: provider, methodVersion: interval === "1day" ? "daily-candle-v1" : "intraday-candle-v1" };
}

export async function fetchIntradayCandles(config = {}) { return fetchDailyCandles({ ...config, interval: config.interval || "15min", trigger: config.trigger || "scheduled-intraday-candles" }); }
