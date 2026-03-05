# OGID - OSINT Geopolitical Intelligence Dashboard

OGID is a local web app for monitoring geopolitical OSINT signals and their potential market impact on US-listed assets.

## Stack

- Backend: Node.js + Express + ws
- Frontend: HTML5 + Bootstrap 5 + Vanilla JS modules + Leaflet + Chart.js
- State: in-memory singleton (no database)

## Core Features (V1)

- Multi-provider news ingestion with fallback chain:
  - Primary: NewsAPI
  - Fallback: GNews
  - Final fallback: deterministic local feed
- Adaptive quota-aware scheduling for news and market refresh intervals.
- Manual user-triggered refresh (`POST /api/intel/refresh`) with cooldown and per-client limits.
- Country risk scoring with deterministic engine.
- Country watchlist default: `US, IL, IR`.
- WebSocket live updates (`/ws`) for snapshot/update/heartbeat.
- Market module (Alpha Vantage + fallback):
  - live quotes cache in memory
  - ticker timeseries in memory
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
NEWS_PROVIDERS=newsapi,gnews
NEWS_QUERY=geopolitics OR conflict OR sanctions OR military
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
MARKET_PROVIDER=alphavantage
ALPHAVANTAGE_API_KEY=your_alphavantage_key
ALPHAVANTAGE_BASE_URL=https://www.alphavantage.co/query
MARKET_TICKERS=GD,BA,NOC,LMT,RTX,XOM,CVX
MARKET_TIMEOUT_MS=10000
MARKET_REFRESH_INTERVAL_MS=60000
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

## Tests

From `backend/`:

- `npm test`

Includes:
- deterministic unit tests (risk, sentiment, filters, impact)
- integration tests (REST + WebSocket)
