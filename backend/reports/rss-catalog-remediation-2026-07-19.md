# RSS Catalog Remediation — 2026-07-19

## Outcome

The canonical catalog contains 66 enabled RSS/Atom sources. The final local audit made exactly one sequential request per source, without retries, credentials, persistence or background refresh. All 66 returned HTTP 200, parsed successfully and returned articles. This is a point-in-time health result, not a guarantee of future availability.

| Metric | Baseline | Final |
|---|---:|---:|
| Enabled feeds audited | 66 | 66 |
| Valid feeds | 44 | 66 |
| Sources returning articles | 44 | 66 |
| Sources with news within 7 days | 42 | 62 |
| Degraded but usable sources | 2 | 4 |
| Failed sources | 22 | 0 |
| Articles observed | 2,472 | 2,896 |

Evidence:

- [Baseline Markdown](./rss-catalog-audit-2026-07-19-baseline.md) and [sanitized JSON](./rss-catalog-audit-2026-07-19-baseline.json)
- [Final Markdown](./rss-catalog-audit-2026-07-19-final.md) and [sanitized JSON](./rss-catalog-audit-2026-07-19-final.json)

## Repaired existing sources

| Source | Previous endpoint/result | Validated endpoint | Final result |
|---|---|---|---|
| Chatham House | `/rss.xml` — HTTP 403 | `https://www.chathamhouse.org/path/whatsnew.xml` | HTTP 200, 50 articles, fresh |
| Modern War Institute | `mwi.usma.edu/feed/` — network failure | `https://mwi.westpoint.edu/feed/` | HTTP 200, 5 articles, fresh |
| Small Wars Journal | `/rss.xml` — HTTP 404 | `https://smallwarsjournal.com/rss` | HTTP 200, 10 articles, fresh |
| Defense One | `/rss/` — HTTP 404 | `https://www.defenseone.com/rss/all/` | HTTP 200, 21 articles, fresh |
| Arms Control Association | `/feeds/all` — HTTP 404 | `https://www.armscontrol.org/rss.xml` | HTTP 200, 10 articles, fresh |
| Euronews | obsolete `world` query — HTTP 404 | `https://www.euronews.com/rss?format=mrss&level=theme&name=news` | HTTP 200, 50 articles, fresh |

International Crisis Group remains on its valid endpoint. Its ten items were usable but the newest was 16 days old, which is compatible with a low-cadence specialist publisher.

## Added and validated sources

Primary signals are placed first so the initial runtime batch favors official releases instead of general media.

| Coverage | Source | Role | Final audit |
|---|---|---|---:|
| Defense | U.S. Defense Releases | Official | 10 articles |
| Defense contracts | U.S. Defense Contracts | Official | 10 articles |
| Energy | EIA Today in Energy | Official | 18 articles |
| Energy | EIA Press Releases | Official | 9 articles |
| Regulation | SEC Press Releases | Official | 25 articles |
| Macro/rates | Federal Reserve Press Releases | Official | 20 articles |
| EU sanctions | European Commission Sanctions Guidance | Official | 19 articles |
| Cybersecurity | CISA Cybersecurity Advisories | Official | 30 articles |
| Cybersecurity | CISA News | Official | 10 articles |
| Semiconductors/export control | Federal Register documents filtered to BIS | Official government register | 6 articles |
| Derivatives/BTC regulation | CFTC Press Releases | Official | 10 articles |
| EU policy/sanctions | EU Council Press Releases | Official | 20 articles |
| Defense | UK Ministry of Defence | Official | 20 articles |
| Geopolitics | UN Press | Official | 10 articles |
| Nuclear | IAEA Top News | Official | 15 articles |
| Naval/defense | USNI News | Specialist editorial | 30 articles |
| BTC | CoinDesk | Complementary editorial | 25 articles |

Official discovery pages used to confirm the endpoints:

- U.S. Defense RSS catalog: <https://www.war.gov/News/RSS/>
- EIA RSS catalog: <https://www.eia.gov/tools/rssfeeds/>
- SEC RSS and EDGAR guidance: <https://www.sec.gov/about/rss-feeds>
- Federal Reserve feeds: <https://www.federalreserve.gov/feeds/feeds.htm>
- European Commission sanctions guidance: <https://finance.ec.europa.eu/eu-and-world/sanctions-restrictive-measures/sanctions-adopted-following-russias-military-aggression-against-ukraine/guidance-documents_en>
- CFTC RSS catalog: <https://www.cftc.gov/RSS/index.htm>
- EU Council RSS catalog: <https://www.consilium.europa.eu/en/about-site/rss/>

BIS did not expose a stable RSS endpoint in its current public portal. The catalog therefore uses the official Federal Register RSS API filtered to the Industry and Security Bureau, rather than scraping BIS HTML.

## Retired sources without a usable current feed

| Source | Observed problem | Decision and replacement coverage |
|---|---|---|
| ACLED | HTTP 404 | Retired; conflict discovery remains covered by UN, ICG, Bellingcat and targeted Google News queries. This does not replace ACLED structured event data. |
| ReliefWeb | HTTP 406, including explicit RSS/XML `Accept` headers | Retired from direct RSS; UN News and UN Press cover primary humanitarian/geopolitical releases. |
| CSIS | Parsed, but newest item was from 2016 | Retired as a stale endpoint; Atlantic Council, Chatham House and ICG cover specialist analysis. |
| Council on Foreign Relations | HTTP 404 | Retired; Chatham House, Atlantic Council and ICG retained. |
| Carnegie Endowment | HTTP 200 HTML without RSS/Atom items | Retired; specialist coverage retained through the validated think-tank feeds. |
| RAND | HTTP 403 | Retired; no brittle bypass or HTML scraper added. |
| ISW | HTTP 403; alternate `/feed/` was not a valid feed | Retired; MWI, Small Wars Journal and War on the Rocks retained. |
| Jane's Defence | HTTP 404 | Retired; official defense releases/contracts plus Defense News and USNI News added. |
| Global Conflict Tracker | HTTP 404 | Retired; targeted conflict discovery and UN sources retained. |
| Humanitarian Response | HTTP 406 after redirect/migration | Retired; UN sources retained. |
| UN Peacekeeping | HTTP 404 | Retired; UN News and UN Press retained. |
| NATO News | HTTP 404; tested current candidate also returned 404 | Direct feed retired; NATO-targeted Google News discovery remains, supplemented by EU Council and UK MOD. |
| EU External Action | HTTP 404 | Retired; European Commission sanctions and EU Council feeds added. |
| OSCE News | HTTP 404; published RSS candidate also returned 404 | Retired; no HTML scraper added. |
| Reuters World | Obsolete host/network failure | Retired; BBC, DW, France24, Al Jazeera and other validated world feeds remain. |
| Telegraph World | HTTP 403 | Retired; no access-control bypass added. |
| Yahoo World | HTTP 403 | Retired; no access-control bypass added. |

### Previously removed candidates

- **GlobalSecurity:** the isolated local probe of `https://www.globalsecurity.org/wmd/library/news/rss.xml` returned HTTP 404 and zero articles. No current public XML endpoint was found. Its current subscription page advertises a paid JSON API for institutions, so it was not restored as RSS: <https://www.globalsecurity.org/subscribe/index.html>.
- **ZeroHedge:** the catalog entry pointed to a website page, not RSS/XML. It remains removed rather than pretending a page URL is a disabled feed.

## Valid but degraded sources

| Source | Reason | Decision |
|---|---|---|
| EIA Press Releases | Newest item was 11 days old | Keep: official and naturally low cadence. |
| European Commission Sanctions Guidance | Newest item was from 2026-01-15 | Keep: authoritative guidance with event-driven cadence. |
| IAEA Top News | 15 items but no parser-usable publication dates | Keep and flag metadata quality; the feed content is valid. |
| International Crisis Group | Newest item was 16 days old | Keep: specialist, low-cadence source. |

## Runtime behavior and API impact

The application has two distinct RSS call paths:

1. **Main news-provider path:** with the repository's current `.env`, `NEWS_PROVIDERS=rss` and `NEWS_INTERVAL_MS=60000`. Each completed news cycle passes all 66 active feeds to `fetchRss`, which processes one feed operation at a time. The catalog had 66 active feeds before and after this remediation, so this change does not increase that path's baseline operation count; transient-policy retries can still add HTTP attempts.
2. **RSS aggregate/intelligence path:** `NEWS_RSS_AGGREGATE_INTERVAL_MS=900000` and `NEWS_RSS_AGGREGATE_FEEDS_PER_RUN=18`. This separate service supplies aggregate/map consumers and retains its 18-feed cap.

The aggregate/intelligence path now rotates configured feeds instead of selecting the same first 18 forever:

- before: the same 18 configured feeds were contacted on every refresh; the remaining configured feeds were starved;
- after: all 66 configured feeds are covered in four refresh cycles, without increasing the 18-feed per-cycle cap;
- with the configured 15-minute aggregate interval, a healthy continuous server reaches each configured feed through that path approximately once per hour;
- two independent normal servers may read the same public feeds, but they create separate upstream traffic in both paths. There is no universal RSS quota, yet individual publishers can throttle or block clients;
- for focused testing, use the bounded local RSS lab. It replaces the catalog with one to five explicit feeds, clears API credentials, disables background refresh and blocks undeclared outbound hosts.

## Repeatable local checks

From `backend/`:

```powershell
# One source, one attempt, no retry
npm run rss:probe -- 'GlobalSecurity|https://www.globalsecurity.org/wmd/library/news/rss.xml'

# Entire canonical catalog, sequential and without retries
npm run rss:audit -- --output-prefix=rss-catalog-audit-latest

# Offline automated tests; outbound network is blocked by test setup
npm test
```

The reports contain diagnostics and aggregate quality metrics, not article bodies or credentials.

## Deliberately pending

SEC company-filings ingestion is not implemented by this catalog change. The repository has no authoritative `instrumentId -> CIK` mapping, and a global SEC search feed would produce incorrect instrument attribution. A later structured EDGAR change should add and validate that mapping, generate company-specific SEC queries, and keep SEC press releases as the global regulatory signal.
