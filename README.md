# OGID - OSINT Geopolitical Intelligence Dashboard

OGID is a local web app for monitoring geopolitical OSINT signals and their potential market impact on US-listed assets.

## Stack

- Backend: Node.js + Express + ws
- Frontend: HTML5 + Bootstrap 5 + Vanilla JS modules + Leaflet + Chart.js
- State: in-memory singleton with optional local market snapshot/history persistence on disk

## Core Features (V1)

- Multi-provider news ingestion with fallback chain:
  - Aggregated: NewsAPI + GNews + RSS + GDELT + optional Mediastack
  - Canonical RSS catalog prioritizes validated official feeds, with bounded rotation and per-feed diagnostics
  - Final fallback: deterministic local feed
- Adaptive quota-aware scheduling for news and market refresh intervals.
- Manual user-triggered refresh (`POST /api/intel/refresh`) with cooldown and per-client limits.
- Country risk scoring with deterministic engine.
- Country watchlist default: `US, IL, IR`.
- WebSocket live updates (`/ws`) for snapshot/update/heartbeat, plus admin-visible connection diagnostics.
- Market module (`yahoo-finance2 -> router-stale -> synthetic-fallback`):
  - server-side Yahoo quotes, symbol search and OHLCV through pinned `yahoo-finance2@4.0.0`
  - dynamic persisted watchlist (up to seven instruments); no production symbol catalog is hardcoded
  - low-concurrency queue, request deduplication, timeout, retry/backoff and stale local data on transient failures
  - Twelve Data remains a backward-compatible optional provider, not the default
  - stale quote reuse before deterministic fallback
  - quote diagnostics by mode: `live`, `web-delayed`, `router-stale`, `synthetic-fallback`
  - in-memory quotes/timeseries plus optional persisted `snapshot.json` and per-ticker `jsonl` history
- Deterministic event-window impact model:
  - correlates geopolitical news signals with ticker price reaction
- Frontend controls:
  - country filter chips
  - conflict hotspots + active event signals on map
  - live news feed + risk chart + market impact panel
  - Yahoo instrument search, dynamic watchlist and OHLCV price/volume chart

## Project Structure

```text
osint/
  ├── frontend/
  └── backend/
```

## Environment Configuration

Create `backend/.env` from `backend/.env.example`.

```env
PORT=8080
NEWS_API_KEY=your_newsapi_key
NEWS_API_BASE_URL=https://newsapi.org/v2
GNEWS_API_KEY=your_gnews_key
GNEWS_BASE_URL=https://gnews.io/api/v4
GDELT_BASE_URL=https://api.gdeltproject.org/api/v2/doc/doc
NEWS_RSS_FEEDS=
NEWS_RSS_DISABLED_FEEDS=
NEWS_PROVIDERS=newsapi,gnews,rss,gdelt,mediastack
NEWS_QUERY=geopolitics OR conflict OR sanctions OR military
NEWS_QUERY_PACKS={"editorial":{"defense":"missile OR defense contractor OR arms deal OR air defense","energy":"oil OR gas OR lng OR pipeline OR refinery","sanctions":"sanctions OR export controls OR secondary sanctions","shipping":"shipping lane OR tanker OR strait OR maritime security","macro":"central bank OR inflation OR tariffs OR sovereign risk","semiconductors":"semiconductor OR chip export OR foundry OR fab"},"marketSignals":{"priceAction":"shares OR stock OR stocks OR equity OR equities OR premarket OR \"after hours\" OR \"price target\" OR upgrade OR downgrade OR guidance OR earnings OR selloff OR rally"}}
NEWS_SOURCE_ALLOWLIST=
NEWS_DOMAIN_ALLOWLIST=
NEWS_LANGUAGE=en
NEWS_PAGE_SIZE=50
NEWS_PAGE_SIZE_GREEN=100
NEWS_PAGE_SIZE_YELLOW=75
NEWS_PAGE_SIZE_RED=40
NEWS_PAGE_SIZE_CRITICAL=20
NEWS_TIMEOUT_MS=9000
NEWS_INTERVAL_GREEN_MS=600000
NEWS_INTERVAL_YELLOW_MS=1200000
NEWS_INTERVAL_RED_MS=2700000
NEWS_INTERVAL_CRITICAL_MS=7200000
NEWS_ANALYZE_LIMIT=80
NEWS_CANDIDATE_WINDOW_HOURS=36
NEWS_MAX_PER_SOURCE=3
NEWS_MAX_SIMILAR_HEADLINE=2
WATCHLIST_COUNTRIES=US,IL,IR
REFRESH_INTERVAL_MS=30000
WS_HEARTBEAT_MS=15000
MANUAL_REFRESH_COOLDOWN_MS=120000
MANUAL_REFRESH_PER_CLIENT_WINDOW_MS=900000
MANUAL_REFRESH_PER_CLIENT_MAX=3
MARKET_PROVIDER=yahoo
MARKET_PROVIDER_FALLBACK=
MARKET_TICKERS=
MARKET_TIMEOUT_MS=10000
MARKET_REFRESH_INTERVAL_MS=60000
MARKET_BATCH_CHUNK_SIZE=25
MARKET_HISTORY_PERSIST=1
MARKET_HISTORY_DIR=data/market
MARKET_SNAPSHOT_FILE=snapshot.json
MARKET_STALE_TTL_MS=14400000
MARKET_REQUEST_RESERVE=1
MARKET_ACTIVE_INTERVAL_MS=300000
MARKET_OFFHOURS_INTERVAL_MS=1800000
IMPACT_WINDOW_MIN=120
LOG_LEVEL=info
```

The versioned backend source catalog is the default inventory: 68 RSS entries (67 enabled and one retained as disabled) plus 435 explicitly typed generated searches. `NEWS_RSS_FEEDS` and `NEWS_RSS_DISABLED_FEEDS` are optional complete overrides; leave them empty to use the catalog.

`MARKET_TICKERS` is an optional initial selection. The Market Quotes dialog discovers candidates with one Yahoo search by symbol or company. A selected candidate is verified once with a Yahoo quote when the watchlist is saved, then persisted with its metadata. Only that selection feeds quotes, OHLCV, predictions and news-impact analysis. Accepted search result types are equities, ETFs, mutual funds, indices, currencies, cryptocurrencies and futures. Provider symbols preserve Yahoo notation (for example `NQ=F`, `^GSPC`, `EURUSD=X`, `BTC-USD` and `BRK.B`) and selected symbols survive restart in `data/market/watchlist-selection.json`.

Search is limited server-side to 30 requests per client per minute; this is an internal abuse guard, not a declared Yahoo quota. Successful identical searches are cached for five minutes. An upstream Yahoo `429` is not retried immediately: it opens a global cooldown (at least 60 seconds), and the search API returns `503 MARKET_SEARCH_PROVIDER_RATE_LIMITED` with `Retry-After`. The UI deduplicates an identical in-flight search and preserves existing results/watchlist entries during the cooldown. An existing schema-v1 watchlist is migrated from the local snapshot and revalidated with Yahoo; failures remain explicit.

OHLCV uses Yahoo `chart()` server-side and is normalized to UTC `{symbol, source, timestamp, open, high, low, close, volume}`. Data is upserted under `data/market/candles`; daily cache TTL is six hours and intraday TTL is 15–60 minutes. The public candle route preserves its existing contract and adds `status: fresh|partial|stale|stored|empty` plus a sanitized degradation error when applicable. Historical `from` and `to` boundaries must be supplied together; incomplete provider coverage is persisted but never promoted to a fresh cache hit.

Supported Yahoo intervals are `5min`, `15min`, `30min`, `1h` and `1day`; the internal module also supports `1wk` and `1mo`. Long intraday combinations are rejected before any upstream request. Scheduled intraday ingestion remains feature-flagged with `MARKET_INTRADAY_CANDLES_ENABLED=1`.

News-to-Price Coupling v2 is calculated locally from normalized news and persisted canonical candles. It reports temporal association and observed returns, never causality; optional benchmarks must be supplied as verified `instrumentId` values.

## Run Locally

1. Install Node.js 24 LTS (`.nvmrc` and `.node-version` pin the supported baseline to 24; Node 22-26 is accepted by the package manifest).
2. `cd backend`
3. `npm install`
4. Create `.env` from `.env.example`
5. `npm run dev` (or `npm start`)
6. Open `http://localhost:8080`

Administrative routes, mutations and `force=1` requests are allowed from loopback by default. For non-local access, configure `ADMIN_API_TOKEN` and send it as a Bearer token or `X-Admin-Token`. Set `ALLOW_LOCAL_ADMIN=0` to require the token on loopback too.

## Controlled Local RSS Lab

RSS has no single global quota: every publisher or feed host can still throttle or block repeated clients. Running production and a local server against the same feeds is technically valid, but it doubles upstream traffic. Use the bounded lab instead of copying the full production catalog.

Do not use the normal `npm run dev` profile for isolated feed experiments. With the repository's current `.env`, the main news pipeline enables RSS every 60 seconds and passes the complete active catalog to the provider. The lab replaces that catalog with only the explicitly selected feeds and disables background refresh.

For a local UI session, explicitly select between one and five feeds in PowerShell:

```powershell
cd backend
$env:NEWS_RSS_FEEDS = 'BBC World|https://feeds.bbci.co.uk/news/world/rss.xml,UN News|https://news.un.org/feed/subscribe/en/news/all/rss.xml'
npm run dev:rss-lab
```

Open `http://localhost:8081` and stop with `Ctrl+C`. The lab profile:

- clears every configured API credential and disables market providers;
- disables background refresh and persistence;
- limits RSS aggregation to the explicitly supplied feeds, with a one-hour cache;
- permits backend outbound HTTP only to those feed hosts and loopback;
- blocks redirects to undeclared hosts and limits manual refreshes.

Opening the dashboard performs one bounded RSS aggregate load. Other dashboard requests reuse the in-flight result or cache. Browser-side CDN, map-tile and media traffic is outside the backend guard.

For diagnosing a feed without starting either server, run a single live probe. It performs one attempt per feed and never retries:

```powershell
npm run rss:probe -- 'BBC World|https://feeds.bbci.co.uk/news/world/rss.xml'
```

The JSON report contains feed status, error category, latency and quality coverage for titles, URLs, timestamps, 48-hour freshness, summaries, images, country mentions, topic tags and duplicates. It never returns article bodies. Feed failures are reported in the `status` field without failing the command; invalid lab configuration exits with code `1`.

To audit every canonical RSS source with one request per feed, no retries and a short delay between requests:

```powershell
npm run rss:audit -- --output-prefix=rss-catalog-audit-latest
```

The command runs sequentially and writes sanitized JSON and Markdown reports under `backend/reports/`. It classifies fresh, degraded, empty, broken, blocked, rate-limited and transient feeds. This is an explicit live operation; unlike `npm test`, it contacts every enabled RSS host in the catalog.

The dated remediation report in `backend/reports/rss-catalog-remediation-2026-07-19.md` records the baseline failures, repaired URLs, replacements and intentionally retired sources. Audit results are a point-in-time health check; rerun the command before promoting later catalog changes.

Before promoting a new source into the canonical catalog, validate its HTTP/XML stability, publishing cadence, timestamp quality, topical relevance, duplicate rate, metadata coverage and publisher terms in small batches. Clear the local selection after the session with `Remove-Item Env:NEWS_RSS_FEEDS`.

## API Endpoints

- `GET /api/health`
- `GET /api/intel/snapshot?countries=US,IL,IR&limit=50&sources=newsapi,gnews`
- `POST /api/intel/refresh`
- `GET /api/intel/hotspots?countries=US,IL,IR`
- `GET /api/intel/risks?countries=US,IL,IR`
- `GET /api/intel/news?countries=US,IL,IR&limit=50&sources=newsapi,gnews`
- `GET /api/intel/insights?countries=US,IL,IR`
- `GET /api/market/quotes?tickers=GD,BA,NOC`
- `GET /api/market/instruments/search?q=Microsoft&limit=10`
- `GET /api/market/watchlist`
- `PUT /api/market/watchlist` with `{ "instrumentIds": ["..."] }` (authenticated mutation)
- `GET /api/market/candles?instrumentId=<dynamic-id>&interval=1day&limit=100&adjusted=splits`
- `GET /api/market/candles/metrics`
- `GET /api/market/indicators?instrumentId=us-equity-general-dynamics&interval=1day&adjusted=splits`
- `POST /api/market/candles/backfill` (authenticated mutation)
- `GET /api/market/impact?tickers=GD,BA,NOC&countries=US,IL,IR&windowMin=120`
- `GET /api/market/analytics?tickers=GD,BA,NOC&countries=US,IL,IR&windowMin=120`
- `GET /api/admin/api-limits`
- `GET /api/admin/pipeline-status`

Yahoo Finance is not an official guaranteed API. Upstream limits and intraday retention can change; the application therefore uses a bounded queue and stale local fallback, and throws an explicit error when neither fresh nor stored data exists.

## Tests

From `backend/`:

- `npm run check`
- `npm test`
- `npm run build`

Includes:
- deterministic unit tests (risk, sentiment, filters, impact)
- provider stability tests (GNews query policy, GDELT cooldown, RSS invalid/disabled feeds)
- integration tests (REST + WebSocket + pipeline diagnostics)
