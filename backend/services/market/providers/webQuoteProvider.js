import apiQuotaTracker from "../../admin/apiQuotaTrackerService.js";
import { createLogger } from "../../../utils/logger.js";
import { buildProviderDiagnosticRecord } from "../providerDiagnostics.js";

const log = createLogger("backend/services/market/providers/webQuoteProvider");
const DEFAULT_WEB_SOURCE = "stooq";
const DEFAULT_WEB_BASE_URL = "https://stooq.com";
const DEFAULT_WEB_USER_AGENT = "ogid/1.0";

function parsePrice(value) {
  const normalized = String(value ?? "")
    .replaceAll(",", "")
    .trim();
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

function ensureTrailingSlash(baseUrl = DEFAULT_WEB_BASE_URL) {
  return String(baseUrl).endsWith("/") ? String(baseUrl) : `${String(baseUrl)}/`;
}

function parseCsvLine(line = "") {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const nextCharacter = line[index + 1];

    if (character === '"' && inQuotes && nextCharacter === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (character === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (character === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += character;
  }

  values.push(current);
  return values.map((value) => String(value || "").trim());
}

function parseCsvTable(text = "") {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseCsvLine(line));
}

function normalizeWebSymbol(ticker = "", source = DEFAULT_WEB_SOURCE) {
  const normalizedTicker = String(ticker || "").trim().toLowerCase();
  if (!normalizedTicker) {
    return "";
  }

  if (source !== "stooq") {
    return normalizedTicker;
  }

  if (normalizedTicker.endsWith(".us")) {
    return normalizedTicker;
  }

  return `${normalizedTicker.replaceAll(".", "-")}.us`;
}

export function buildWebBatchQuoteUrl({
  source = DEFAULT_WEB_SOURCE,
  baseUrl = DEFAULT_WEB_BASE_URL,
  symbols = []
}) {
  if (source !== "stooq") {
    throw new Error(`Unsupported market web source: ${source}`);
  }

  const url = new URL("q/l/", ensureTrailingSlash(baseUrl));
  url.searchParams.set("s", symbols.join(","));
  url.searchParams.set("f", "sd2t2ohlcvn");
  url.searchParams.set("e", "csv");
  return url;
}

export function buildWebHistoricalUrl({
  source = DEFAULT_WEB_SOURCE,
  baseUrl = DEFAULT_WEB_BASE_URL,
  symbol = ""
}) {
  if (source !== "stooq") {
    throw new Error(`Unsupported market web source: ${source}`);
  }

  const url = new URL("q/d/l/", ensureTrailingSlash(baseUrl));
  url.searchParams.set("s", symbol);
  url.searchParams.set("i", "d");
  return url;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function buildProviderError({
  scope,
  code,
  message,
  tickers = [],
  ticker = null,
  status = null,
  requestUrl = null,
  responsePreview = null
}) {
  return {
    provider: "web",
    scope,
    code,
    reason: code,
    message,
    status,
    tickers: tickers.length ? tickers : undefined,
    ticker: ticker || undefined,
    requestUrl,
    responsePreview
  };
}

function buildSourceInvalidResult(tickers = [], timestamp = new Date().toISOString(), options = {}) {
  const error = buildProviderError({
    scope: "provider",
    code: "web-source-invalid",
    message: "The configured market web source is not supported.",
    tickers
  });

  return {
    provider: "web",
    quotes: {},
    missingTickers: tickers,
    historicalSeries: {},
    sourceMode: "fallback",
    sourceMeta: {
      provider: "web",
      reason: "web-source-invalid",
      requestMode: "unavailable",
      liveCount: 0,
      totalTickers: tickers.length,
      errors: [error],
      providerDiagnostics: {
        web: buildProviderDiagnosticRecord({
          provider: "web",
          configuredProvider: options.configuredProvider || "web",
          configuredFallbackProvider: options.configuredFallbackProvider || null,
          effectiveProvider: null,
          configuredSource: options.source || DEFAULT_WEB_SOURCE,
          requestMode: "unavailable",
          lastAttemptAt: timestamp,
          requestedTickers: tickers,
          returnedTickers: [],
          missingTickers: tickers,
          errorCode: "web-source-invalid",
          errorMessage: "The configured market web source is not supported."
        })
      }
    },
    updatedAt: timestamp
  };
}

function buildSymbolUnmappedResult(tickers = [], timestamp = new Date().toISOString(), options = {}) {
  const error = buildProviderError({
    scope: "provider",
    code: "web-symbol-unmapped",
    message: "No valid symbols were produced for the configured web source.",
    tickers
  });

  return {
    provider: "web",
    quotes: {},
    missingTickers: tickers,
    historicalSeries: {},
    sourceMode: "fallback",
    sourceMeta: {
      provider: "web",
      reason: "web-symbol-unmapped",
      requestMode: "web-delayed",
      liveCount: 0,
      totalTickers: tickers.length,
      errors: [error],
      providerDiagnostics: {
        web: buildProviderDiagnosticRecord({
          provider: "web",
          configuredProvider: options.configuredProvider || "web",
          configuredFallbackProvider: options.configuredFallbackProvider || null,
          effectiveProvider: null,
          configuredSource: options.source || DEFAULT_WEB_SOURCE,
          requestMode: "web-delayed",
          lastAttemptAt: timestamp,
          requestedTickers: tickers,
          returnedTickers: [],
          missingTickers: tickers,
          errorCode: "web-symbol-unmapped",
          errorMessage: "No valid symbols were produced for the configured web source."
        })
      }
    },
    updatedAt: timestamp
  };
}

function parseBatchQuoteRows(rows = [], tickerBySymbol = new Map()) {
  if (rows.length <= 1) {
    return {};
  }

  return Object.fromEntries(
    rows
      .slice(1)
      .map((row) => {
        const [symbol, date, time, open, high, low, close] = row;
        const normalizedSymbol = String(symbol || "").trim().toLowerCase();
        const ticker = tickerBySymbol.get(normalizedSymbol);
        const price = parsePrice(close);
        const openPrice = parsePrice(open);

        if (!ticker || !Number.isFinite(price)) {
          return null;
        }

        return [
          ticker,
          {
            ticker,
            symbol: normalizedSymbol,
            date: String(date || "").trim(),
            time: String(time || "").trim(),
            price,
            openPrice: Number.isFinite(openPrice) ? openPrice : null,
            dayRange: {
              high: parsePrice(high),
              low: parsePrice(low)
            }
          }
        ];
      })
      .filter(Boolean)
  );
}

function parseHistoricalRows(rows = []) {
  if (rows.length <= 1) {
    return [];
  }

  return rows
    .slice(1)
    .map((row) => {
      const [date, open, high, low, close] = row;
      const price = parsePrice(close);
      return {
        timestamp: date ? new Date(`${date}T00:00:00.000Z`).toISOString() : null,
        open: parsePrice(open),
        high: parsePrice(high),
        low: parsePrice(low),
        price
      };
    })
    .filter((row) => row.timestamp && Number.isFinite(row.price))
    .sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime());
}

function deriveChangePct({ price, previousClose, openPrice }) {
  if (Number.isFinite(previousClose) && previousClose > 0) {
    return Number((((price - previousClose) / previousClose) * 100).toFixed(2));
  }

  if (Number.isFinite(openPrice) && openPrice > 0) {
    return Number((((price - openPrice) / openPrice) * 100).toFixed(2));
  }

  return 0;
}

async function fetchHistoricalPreviousClose({
  ticker,
  symbol,
  source,
  baseUrl,
  timeoutMs,
  userAgent
}) {
  const url = buildWebHistoricalUrl({
    source,
    baseUrl,
    symbol
  });
  const attemptedAt = new Date().toISOString();
  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        "User-Agent": userAgent || DEFAULT_WEB_USER_AGENT
      }
    },
    timeoutMs
  );
  const text = await response.text();

  if (!response.ok) {
    const providerError = buildProviderError({
      scope: "historical",
      ticker,
      code: "web-upstream-status",
      message: `Market web historical source returned HTTP ${response.status}.`,
      status: response.status,
      requestUrl: url.toString(),
      responsePreview: text
    });
    const error = new Error(providerError.message);
    error.providerError = providerError;
    throw error;
  }

  const rows = parseHistoricalRows(parseCsvTable(text));
  const latest = rows.at(-1) || null;
  const previous = rows.length >= 2 ? rows.at(-2) : null;

  return {
    latestPrice: latest?.price ?? null,
    previousClose: previous?.price ?? null,
    series: rows.map((row, index) => ({
      timestamp: row.timestamp,
      price: row.price,
      changePct:
        index > 0 && Number.isFinite(rows[index - 1]?.price) && rows[index - 1].price > 0
          ? Number((((row.price - rows[index - 1].price) / rows[index - 1].price) * 100).toFixed(2))
          : 0
    })),
    requestUrl: url.toString(),
    attemptedAt,
    responsePreview: text
  };
}

async function recoverWebBatchQuotes({
  symbolEntries = [],
  source = DEFAULT_WEB_SOURCE,
  baseUrl = DEFAULT_WEB_BASE_URL,
  timeoutMs = 9_000,
  userAgent = DEFAULT_WEB_USER_AGENT,
  timestamp = new Date().toISOString()
}) {
  const quotes = {};
  const historicalSeries = {};
  const requestUrls = [];
  const errors = [];

  for (const [ticker, symbol] of symbolEntries) {
    const url = buildWebBatchQuoteUrl({
      source,
      baseUrl,
      symbols: [symbol]
    });

    try {
      const response = await fetchWithTimeout(
        url,
        {
          headers: {
            "User-Agent": userAgent || DEFAULT_WEB_USER_AGENT
          }
        },
        timeoutMs
      );
      const text = await response.text();
      requestUrls.push(url.toString());

      if (!response.ok) {
        errors.push(
          buildProviderError({
            scope: "batch",
            tickers: [ticker],
            code: "web-upstream-status",
            message: `Market web source returned HTTP ${response.status}.`,
            status: response.status,
            requestUrl: url.toString(),
            responsePreview: text
          })
        );
        continue;
      }

      const table = parseCsvTable(text);
      const parsedRows = parseBatchQuoteRows(table, new Map([[symbol, ticker]]));
      const item = parsedRows[ticker];
      if (!item) {
        const reason = table.length <= 1 ? "web-csv-empty" : "web-symbol-unmapped";
        errors.push(
          buildProviderError({
            scope: "batch",
            tickers: [ticker],
            code: reason,
            message:
              reason === "web-csv-empty"
                ? "Market web batch CSV returned no quote rows."
                : "Market web batch CSV did not contain usable symbols for the requested ticker.",
            status: response.status,
            requestUrl: url.toString(),
            responsePreview: text
          })
        );
        continue;
      }

      const historical = await fetchHistoricalPreviousClose({
        ticker,
        symbol: item.symbol,
        source,
        baseUrl,
        timeoutMs,
        userAgent
      });
      requestUrls.push(historical.requestUrl);
      if (Array.isArray(historical.series) && historical.series.length) {
        historicalSeries[ticker] = historical.series;
      }

      quotes[ticker] = {
        price: item.price,
        changePct: deriveChangePct({
          price: item.price,
          previousClose: historical.previousClose,
          openPrice: item.openPrice
        }),
        asOf: timestamp,
        source: "web",
        synthetic: false,
        dataMode: "web-delayed"
      };
    } catch (error) {
      const providerError =
        error.providerError ||
        buildProviderError({
          scope: "batch",
          tickers: [ticker],
          code: error?.name === "AbortError" ? "web-timeout" : "request-failed",
          message:
            error?.name === "AbortError"
              ? "Market web batch request timed out."
              : error?.message || "Market web batch request failed.",
          requestUrl: url.toString()
        });
      errors.push(providerError);
    }
  }

  return {
    quotes,
    historicalSeries,
    requestUrls,
    errors
  };
}

export async function fetchWebQuotes({
  source = DEFAULT_WEB_SOURCE,
  baseUrl = DEFAULT_WEB_BASE_URL,
  tickers = [],
  timeoutMs = 9_000,
  timestamp = new Date().toISOString(),
  userAgent = DEFAULT_WEB_USER_AGENT,
  configuredProvider = "web",
  configuredFallbackProvider = null
}) {
  const normalizedTickers = tickers.map((ticker) => String(ticker).toUpperCase());
  if (source !== "stooq") {
    return buildSourceInvalidResult(normalizedTickers, timestamp, {
      configuredProvider,
      configuredFallbackProvider,
      source
    });
  }

  const symbolEntries = normalizedTickers
    .map((ticker) => [ticker, normalizeWebSymbol(ticker, source)])
    .filter(([, symbol]) => symbol);
  const symbols = symbolEntries.map(([, symbol]) => symbol);
  const tickerBySymbol = new Map(symbolEntries.map(([ticker, symbol]) => [symbol, ticker]));

  if (!symbols.length) {
    return buildSymbolUnmappedResult(normalizedTickers, timestamp, {
      configuredProvider,
      configuredFallbackProvider,
      source
    });
  }

  const startedAt = Date.now();
  const errors = [];
  const historicalSeries = {};
  const requestUrls = [];
  let quotes = {};
  let batchStatus = null;
  let batchPreview = null;
  let lastSuccessAt = null;
  const attemptedAt = new Date().toISOString();

  try {
    const url = buildWebBatchQuoteUrl({
      source,
      baseUrl,
      symbols
    });
    requestUrls.push(url.toString());
    const response = await fetchWithTimeout(
      url,
      {
        headers: {
          "User-Agent": userAgent || DEFAULT_WEB_USER_AGENT
        }
      },
      timeoutMs
    );
    batchStatus = response.status;
    const text = await response.text();
    batchPreview = text;

    if (!response.ok) {
      const providerError = buildProviderError({
        scope: "batch",
        tickers: normalizedTickers,
        code: "web-upstream-status",
        message: `Market web source returned HTTP ${response.status}.`,
        status: response.status,
        requestUrl: url.toString(),
        responsePreview: text
      });
      apiQuotaTracker.recordCall("web", { status: "error", fallback: true, timestamp });
      return {
        provider: "web",
        quotes: {},
        missingTickers: normalizedTickers,
        historicalSeries: {},
        sourceMode: "fallback",
        sourceMeta: {
          provider: "web",
          reason: providerError.code,
          requestMode: "web-delayed",
          liveCount: 0,
          totalTickers: normalizedTickers.length,
          errors: [providerError],
          providerDiagnostics: {
            web: buildProviderDiagnosticRecord({
              provider: "web",
              configuredProvider,
              configuredFallbackProvider,
              effectiveProvider: null,
              configuredSource: source,
              requestMode: "web-delayed",
              lastAttemptAt: attemptedAt,
              durationMs: Date.now() - startedAt,
              requestUrl: url.toString(),
              requestUrls,
              requestedTickers: normalizedTickers,
              returnedTickers: [],
              missingTickers: normalizedTickers,
              httpStatus: response.status,
              responsePreview: text,
              errorCode: providerError.code,
              errorMessage: providerError.message
            })
          }
        },
        updatedAt: timestamp
      };
    }

    let table = [];
    try {
      table = parseCsvTable(text);
    } catch {
      const providerError = buildProviderError({
        scope: "batch",
        tickers: normalizedTickers,
        code: "web-parse-failed",
        message: "Market web batch CSV could not be parsed.",
        status: response.status,
        requestUrl: url.toString(),
        responsePreview: text
      });
      apiQuotaTracker.recordCall("web", { status: "error", fallback: true, timestamp });
      return {
        provider: "web",
        quotes: {},
        missingTickers: normalizedTickers,
        historicalSeries: {},
        sourceMode: "fallback",
        sourceMeta: {
          provider: "web",
          reason: providerError.code,
          requestMode: "web-delayed",
          liveCount: 0,
          totalTickers: normalizedTickers.length,
          errors: [providerError],
          providerDiagnostics: {
            web: buildProviderDiagnosticRecord({
              provider: "web",
              configuredProvider,
              configuredFallbackProvider,
              effectiveProvider: null,
              configuredSource: source,
              requestMode: "web-delayed",
              lastAttemptAt: attemptedAt,
              durationMs: Date.now() - startedAt,
              requestUrl: url.toString(),
              requestUrls,
              requestedTickers: normalizedTickers,
              returnedTickers: [],
              missingTickers: normalizedTickers,
              httpStatus: response.status,
              responsePreview: text,
              errorCode: providerError.code,
              errorMessage: providerError.message
            })
          }
        },
        updatedAt: timestamp
      };
    }

    if (table.length <= 1) {
      const recoveryResult =
        symbolEntries.length > 1
          ? await recoverWebBatchQuotes({
              symbolEntries,
              source,
              baseUrl,
              timeoutMs,
              userAgent,
              timestamp
            })
          : null;

      if (recoveryResult?.quotes && Object.keys(recoveryResult.quotes).length) {
        quotes = recoveryResult.quotes;
        Object.assign(historicalSeries, recoveryResult.historicalSeries || {});
        requestUrls.push(...(recoveryResult.requestUrls || []));
        errors.push(...(recoveryResult.errors || []));
        lastSuccessAt = new Date().toISOString();
      } else {
        const providerError = buildProviderError({
          scope: "batch",
          tickers: normalizedTickers,
          code: "web-csv-empty",
          message: "Market web batch CSV returned no quote rows.",
          status: response.status,
          requestUrl: url.toString(),
          responsePreview: text
        });
        errors.push(...(recoveryResult?.errors || []));
        errors.push(providerError);
        apiQuotaTracker.recordCall("web", { status: "empty", fallback: true, timestamp });
        return {
          provider: "web",
          quotes: {},
          missingTickers: normalizedTickers,
          historicalSeries: {},
          sourceMode: "fallback",
          sourceMeta: {
            provider: "web",
            reason: providerError.code,
            requestMode: "web-delayed",
            liveCount: 0,
            totalTickers: normalizedTickers.length,
            errors,
            providerDiagnostics: {
              web: buildProviderDiagnosticRecord({
                provider: "web",
                configuredProvider,
                configuredFallbackProvider,
                effectiveProvider: null,
                configuredSource: source,
                requestMode: "web-delayed",
                lastAttemptAt: attemptedAt,
                durationMs: Date.now() - startedAt,
                requestUrl: url.toString(),
                requestUrls,
                requestedTickers: normalizedTickers,
                returnedTickers: [],
                missingTickers: normalizedTickers,
                httpStatus: response.status,
                responsePreview: text,
                errorCode: providerError.code,
                errorMessage: providerError.message
              })
            }
          },
          updatedAt: timestamp
        };
      }
    }

    const parsedRows = parseBatchQuoteRows(table, tickerBySymbol);
    if (!Object.keys(parsedRows).length) {
      const recoveryResult =
        symbolEntries.length > 1
          ? await recoverWebBatchQuotes({
              symbolEntries,
              source,
              baseUrl,
              timeoutMs,
              userAgent,
              timestamp
            })
          : null;

      if (recoveryResult?.quotes && Object.keys(recoveryResult.quotes).length) {
        quotes = recoveryResult.quotes;
        Object.assign(historicalSeries, recoveryResult.historicalSeries || {});
        requestUrls.push(...(recoveryResult.requestUrls || []));
        errors.push(...(recoveryResult.errors || []));
        lastSuccessAt = new Date().toISOString();
      } else {
        const providerError = buildProviderError({
          scope: "batch",
          tickers: normalizedTickers,
          code: "web-symbol-unmapped",
          message: "Market web batch CSV did not contain usable symbols for the requested tickers.",
          status: response.status,
          requestUrl: url.toString(),
          responsePreview: text
        });
        errors.push(...(recoveryResult?.errors || []));
        errors.push(providerError);
        apiQuotaTracker.recordCall("web", { status: "empty", fallback: true, timestamp });
        return {
          provider: "web",
          quotes: {},
          missingTickers: normalizedTickers,
          historicalSeries: {},
          sourceMode: "fallback",
          sourceMeta: {
            provider: "web",
            reason: providerError.code,
            requestMode: "web-delayed",
            liveCount: 0,
            totalTickers: normalizedTickers.length,
            errors,
            providerDiagnostics: {
              web: buildProviderDiagnosticRecord({
                provider: "web",
                configuredProvider,
                configuredFallbackProvider,
                effectiveProvider: null,
                configuredSource: source,
                requestMode: "web-delayed",
                lastAttemptAt: attemptedAt,
                durationMs: Date.now() - startedAt,
                requestUrl: url.toString(),
                requestUrls,
                requestedTickers: normalizedTickers,
                returnedTickers: [],
                missingTickers: normalizedTickers,
                httpStatus: response.status,
                responsePreview: text,
                errorCode: providerError.code,
                errorMessage: providerError.message
              })
            }
          },
          updatedAt: timestamp
        };
      }
    }

    if (Object.keys(parsedRows).length) {
      quotes = Object.fromEntries(
        Object.entries(parsedRows).map(([ticker, item]) => [
          ticker,
          {
            price: item.price,
            changePct: deriveChangePct({ price: item.price, previousClose: null, openPrice: item.openPrice }),
            asOf: timestamp,
            source: "web",
            synthetic: false,
            dataMode: "web-delayed"
          }
        ])
      );
      lastSuccessAt = new Date().toISOString();

      const historicalResults = await Promise.allSettled(
        Object.entries(parsedRows).map(async ([ticker, item]) => {
          const historical = await fetchHistoricalPreviousClose({
            ticker,
            symbol: item.symbol,
            source,
            baseUrl,
            timeoutMs,
            userAgent
          });
          return {
            ticker,
            historical,
            openPrice: item.openPrice
          };
        })
      );

      for (const result of historicalResults) {
        if (result.status === "fulfilled") {
          const { ticker, historical, openPrice } = result.value;
          requestUrls.push(historical.requestUrl);
          if (Array.isArray(historical.series) && historical.series.length) {
            historicalSeries[ticker] = historical.series;
          }
          if (quotes[ticker]) {
            quotes[ticker] = {
              ...quotes[ticker],
              changePct: deriveChangePct({
                price: quotes[ticker].price,
                previousClose: historical.previousClose,
                openPrice
              })
            };
          }
          continue;
        }

        const providerError =
          result.reason?.providerError ||
          buildProviderError({
            scope: "historical",
            code: result.reason?.name === "AbortError" ? "web-timeout" : "historical-request-failed",
            message:
              result.reason?.name === "AbortError"
                ? "Market web historical request timed out."
                : result.reason?.message || "Market web historical request failed."
          });
        errors.push(providerError);
      }
    }

    const missingTickers = normalizedTickers.filter((ticker) => !quotes[ticker]);
    apiQuotaTracker.recordCall("web", {
      status: Object.keys(quotes).length > 0 ? "success" : "empty",
      fallback: missingTickers.length > 0,
      timestamp
    });
    const durationMs = Date.now() - startedAt;

    log.info("market_provider_summary", {
      provider: "web",
      source,
      webDelayedCount: Object.keys(quotes).length,
      fallbackCount: missingTickers.length,
      totalTickers: normalizedTickers.length,
      durationMs
    });

    return {
      provider: "web",
      quotes,
      missingTickers,
      historicalSeries,
      sourceMode:
        Object.keys(quotes).length <= 0
          ? "fallback"
          : Object.keys(quotes).length >= normalizedTickers.length
            ? "live"
            : "mixed",
      sourceMeta: {
        provider: "web",
        requestMode: "web-delayed",
        liveCount: 0,
        totalTickers: normalizedTickers.length,
        errors,
        providerDiagnostics: {
          web: buildProviderDiagnosticRecord({
            provider: "web",
            configuredProvider,
            configuredFallbackProvider,
            effectiveProvider: Object.keys(quotes).length ? "web" : null,
            configuredSource: source,
            requestMode: "web-delayed",
            lastAttemptAt: attemptedAt,
            lastSuccessAt,
            durationMs,
            requestUrl: url.toString(),
            requestUrls,
            requestedTickers: normalizedTickers,
            returnedTickers: Object.keys(quotes),
            missingTickers,
            httpStatus: batchStatus,
            responsePreview: batchPreview,
            errorCode: errors.at(-1)?.code || null,
            errorMessage: errors.at(-1)?.message || null
          })
        }
      },
      updatedAt: timestamp
    };
  } catch (error) {
    const providerError =
      error.providerError ||
      buildProviderError({
        scope: "batch",
        tickers: normalizedTickers,
        code: error?.name === "AbortError" ? "web-timeout" : "request-failed",
        message:
          error?.name === "AbortError"
            ? "Market web batch request timed out."
            : error.message || "Market web batch request failed.",
        requestUrl: requestUrls[0] || null,
        responsePreview: batchPreview
      });
    apiQuotaTracker.recordCall("web", { status: "error", fallback: true, timestamp });
    return {
      provider: "web",
      quotes: {},
      missingTickers: normalizedTickers,
      historicalSeries: {},
      sourceMode: "fallback",
      sourceMeta: {
        provider: "web",
        reason: providerError.code,
        requestMode: "web-delayed",
        liveCount: 0,
        totalTickers: normalizedTickers.length,
        errors: [providerError],
        providerDiagnostics: {
          web: buildProviderDiagnosticRecord({
            provider: "web",
            configuredProvider,
            configuredFallbackProvider,
            effectiveProvider: null,
            configuredSource: source,
            requestMode: "web-delayed",
            lastAttemptAt: attemptedAt,
            durationMs: Date.now() - startedAt,
            requestUrl: requestUrls[0] || null,
            requestUrls,
            requestedTickers: normalizedTickers,
            returnedTickers: [],
            missingTickers: normalizedTickers,
            httpStatus: batchStatus,
            responsePreview: batchPreview,
            errorCode: providerError.code,
            errorMessage: providerError.message
          })
        }
      },
      updatedAt: timestamp
    };
  }
}

export { DEFAULT_WEB_BASE_URL, DEFAULT_WEB_SOURCE, DEFAULT_WEB_USER_AGENT };
