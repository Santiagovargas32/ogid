# OGID - OSINT Geopolitical Intelligence Dashboard

OGID is a local web app for monitoring geopolitical OSINT signals and their potential market impact on US-listed assets.

## Stack

- Backend: Node.js + Express + ws
- Frontend: HTML5 + Bootstrap 5 + Vanilla JS modules + Leaflet + Chart.js
- State: in-memory singleton (no database)

## Core Features (V1)

- Multi-provider news ingestion with fallback chain:
  - Aggregated: NewsAPI + GNews + RSS + GDELT + optional Mediastack
  - RSS diagnostics include disabled feeds such as `ZeroHedge` until a valid XML feed is available
  - Final fallback: deterministic local feed
- Adaptive quota-aware scheduling for news and market refresh intervals.
- Manual user-triggered refresh (`POST /api/intel/refresh`) with cooldown and per-client limits.
- Country risk scoring with deterministic engine.
- Country watchlist default: `US, IL, IR`.
- WebSocket live updates (`/ws`) for snapshot/update/heartbeat.
- Market module (FMP stable + Alpha Vantage fallback):
  - FMP `stable/batch-quote` for live bulk quotes
  - FMP `stable/historical-price-eod/full` for EOD backfill
  - Alpha Vantage burst protection via local backoff and per-run request cap
  - stale quote reuse before deterministic fallback
  - quote diagnostics by mode: `live`, `historical-eod`, `router-stale`, `synthetic-fallback`
  - live quotes cache and ticker timeseries in memory
- Deterministic event-window impact model:
  - correlates geopolitical news signals with ticker price reaction
- Frontend controls:
  - country filter chips
  - conflict hotspots + active event signals on map
  - live news feed + risk chart + market impact panel

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
NEWS_RSS_FEEDS=BBC World|https://feeds.bbci.co.uk/news/world/rss.xml,ABC International|https://abcnews.go.com/abcnews/internationalheadlines,Fox World|https://moxie.foxnews.com/google-publisher/world.xml
NEWS_RSS_DISABLED_FEEDS=ZeroHedge|https://www.zerohedge.com/|disabled-until-valid-xml-feed
NEWS_PROVIDERS=newsapi,gnews,rss,gdelt,mediastack
NEWS_QUERY=geopolitics OR conflict OR sanctions OR military
NEWS_QUERY_PACKS={"defense":"missile OR defense contractor OR arms deal OR air defense","energy":"oil OR gas OR lng OR pipeline OR refinery","sanctions":"sanctions OR export controls OR secondary sanctions","shipping":"shipping lane OR tanker OR strait OR maritime security","macro":"central bank OR inflation OR tariffs OR sovereign risk","semiconductors":"semiconductor OR chip export OR foundry OR fab"}
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
MARKET_PROVIDER=fmp
MARKET_PROVIDER_FALLBACK=alphavantage
FMP_API_KEY=your_fmp_key
FMP_BASE_URL=https://financialmodelingprep.com/stable
FMP_STABLE_BASE_URL=https://financialmodelingprep.com/stable
ALPHAVANTAGE_API_KEY=your_alphavantage_key
ALPHAVANTAGE_BASE_URL=https://www.alphavantage.co/query
ALPHAVANTAGE_MAX_REQUESTS_PER_RUN=5
MARKET_TICKERS=GD,BA,NOC,LMT,RTX,XOM,CVX
MARKET_TIMEOUT_MS=10000
MARKET_REFRESH_INTERVAL_MS=60000
MARKET_BATCH_CHUNK_SIZE=25
MARKET_STALE_TTL_MS=14400000
MARKET_REQUEST_RESERVE=25
MARKET_ACTIVE_INTERVAL_MS=180000
MARKET_OFFHOURS_INTERVAL_MS=1800000
FMP_DAILY_LIMIT=250
IMPACT_WINDOW_MIN=120
LOG_LEVEL=info
```

## Run Locally

1. `cd backend`
2. `npm install`
3. Create `.env` from `.env.example`
4. `npm run dev` (or `npm start`)
5. Open `http://localhost:8080`

## API Endpoints

- `GET /api/health`
- `GET /api/intel/snapshot?countries=US,IL,IR&limit=50&sources=newsapi,gnews`
- `POST /api/intel/refresh`
- `GET /api/intel/hotspots?countries=US,IL,IR`
- `GET /api/intel/risks?countries=US,IL,IR`
- `GET /api/intel/news?countries=US,IL,IR&limit=50&sources=newsapi,gnews`
- `GET /api/intel/insights?countries=US,IL,IR`
- `GET /api/market/quotes?tickers=GD,BA,NOC`
- `GET /api/market/impact?tickers=GD,BA,NOC&countries=US,IL,IR&windowMin=120`
- `GET /api/market/analytics?tickers=GD,BA,NOC&countries=US,IL,IR&windowMin=120`
- `GET /api/admin/api-limits`
- `GET /api/admin/pipeline-status`

## Tests

From `backend/`:

- `npm test`

Includes:
- deterministic unit tests (risk, sentiment, filters, impact)
- provider stability tests (GNews query policy, GDELT cooldown, RSS invalid/disabled feeds)
- integration tests (REST + WebSocket + pipeline diagnostics)
