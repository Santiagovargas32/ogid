# RSS Catalog Audit

Generated: 2026-07-18T22:30:40.069Z

The audit performs one request per enabled feed, with no retries and no article bodies in the report.

## Summary

| Metric | Value |
|---|---:|
| Catalog feeds | 66 |
| Attempted feeds | 66 |
| Valid feeds | 44 |
| Sources returning articles | 44 |
| Sources with news within 7 days | 42 |
| Degraded sources | 2 |
| Empty sources | 0 |
| Failed sources | 22 |
| Articles observed | 2472 |

## Healthy feeds

| Source | Category | Reason | HTTP | Articles | Newest | Latency | Action | URL |
|---|---|---|---:|---:|---|---:|---|---|
| Bellingcat | healthy | fresh-news-within-7d | 200 | 10 | 2026-07-16T16:00:01.000Z | 287 ms | keep | <https://www.bellingcat.com/feed/> |
| Defense News | healthy | fresh-news-within-7d | 200 | 25 | 2026-07-18T18:00:58.000Z | 111 ms | keep | <https://www.defensenews.com/arc/outboundfeeds/rss/> |
| War on the Rocks | healthy | fresh-news-within-7d | 200 | 100 | 2026-07-17T17:30:33.000Z | 602 ms | keep | <https://warontherocks.com/feed/> |
| The Diplomat | healthy | fresh-news-within-7d | 200 | 96 | 2026-07-17T16:09:00.000Z | 69 ms | keep | <https://thediplomat.com/feed/> |
| Foreign Policy | healthy | fresh-news-within-7d | 200 | 25 | 2026-07-17T21:24:51.000Z | 83 ms | keep | <https://foreignpolicy.com/feed/> |
| Atlantic Council | healthy | fresh-news-within-7d | 200 | 100 | 2026-07-18T15:40:34.000Z | 252 ms | keep | <https://www.atlanticcouncil.org/feed/> |
| Military Times | healthy | fresh-news-within-7d | 200 | 25 | 2026-07-18T18:00:58.000Z | 572 ms | keep | <https://www.militarytimes.com/arc/outboundfeeds/rss/> |
| Breaking Defense | healthy | fresh-news-within-7d | 200 | 15 | 2026-07-17T21:10:00.000Z | 99 ms | keep | <https://breakingdefense.com/feed/> |
| UN News Global | healthy | fresh-news-within-7d | 200 | 30 | 2026-07-17T12:00:00.000Z | 40 ms | keep | <https://news.un.org/feed/subscribe/en/news/all/rss.xml> |
| Google News Geopolitics | healthy | fresh-news-within-7d | 200 | 100 | 2026-07-18T21:24:47.000Z | 469 ms | keep | <https://news.google.com/rss/search?q=geopolitics> |
| Google News War | healthy | fresh-news-within-7d | 200 | 100 | 2026-07-18T22:20:51.000Z | 642 ms | keep | <https://news.google.com/rss/search?q=war+conflict> |
| Google News NATO | healthy | fresh-news-within-7d | 200 | 100 | 2026-07-18T21:56:50.000Z | 469 ms | keep | <https://news.google.com/rss/search?q=nato> |
| Google News China Military | healthy | fresh-news-within-7d | 200 | 100 | 2026-07-18T13:07:53.000Z | 474 ms | keep | <https://news.google.com/rss/search?q=china+military> |
| Google News Russia War | healthy | fresh-news-within-7d | 200 | 102 | 2026-07-18T21:25:23.000Z | 515 ms | keep | <https://news.google.com/rss/search?q=russia+war> |
| Google News Middle East Conflict | healthy | fresh-news-within-7d | 200 | 102 | 2026-07-18T22:19:43.000Z | 509 ms | keep | <https://news.google.com/rss/search?q=middle+east+conflict> |
| Google News Taiwan Strait | healthy | fresh-news-within-7d | 200 | 100 | 2026-07-18T21:30:00.000Z | 524 ms | keep | <https://news.google.com/rss/search?q=taiwan+strait> |
| Google News South China Sea | healthy | fresh-news-within-7d | 200 | 100 | 2026-07-17T13:28:07.000Z | 634 ms | keep | <https://news.google.com/rss/search?q=south+china+sea+military> |
| Google News North Korea | healthy | fresh-news-within-7d | 200 | 100 | 2026-07-17T01:11:50.000Z | 520 ms | keep | <https://news.google.com/rss/search?q=north+korea+missile> |
| Google News Iran Nuclear | healthy | fresh-news-within-7d | 200 | 100 | 2026-07-18T21:06:11.000Z | 568 ms | keep | <https://news.google.com/rss/search?q=iran+nuclear> |
| Google News Cyberwar | healthy | fresh-news-within-7d | 200 | 100 | 2026-07-16T13:00:00.000Z | 468 ms | keep | <https://news.google.com/rss/search?q=cyberwar> |
| Google News Military Technology | healthy | fresh-news-within-7d | 200 | 100 | 2026-07-18T17:33:04.000Z | 462 ms | keep | <https://news.google.com/rss/search?q=military+technology> |
| Google News Defense Industry | healthy | fresh-news-within-7d | 200 | 100 | 2026-07-18T21:54:04.000Z | 514 ms | keep | <https://news.google.com/rss/search?q=defense+industry> |
| Google News Intelligence Agencies | healthy | fresh-news-within-7d | 200 | 100 | 2026-07-18T20:56:34.000Z | 451 ms | keep | <https://news.google.com/rss/search?q=intelligence+agency> |
| Google News Strategic Weapons | healthy | fresh-news-within-7d | 200 | 100 | 2026-07-15T17:25:00.000Z | 622 ms | keep | <https://news.google.com/rss/search?q=strategic+weapons> |
| Google News Global Sanctions | healthy | fresh-news-within-7d | 200 | 100 | 2026-07-18T22:01:26.000Z | 642 ms | keep | <https://news.google.com/rss/search?q=international+sanctions> |
| CNN World | healthy | fresh-news-within-7d | 200 | 29 | 2026-07-18T22:08:13.575Z | 256 ms | keep | <http://rss.cnn.com/rss/edition_world.rss> |
| BBC World | healthy | fresh-news-within-7d | 200 | 31 | 2026-07-18T21:12:28.000Z | 63 ms | keep | <https://feeds.bbci.co.uk/news/world/rss.xml> |
| The Guardian World | healthy | fresh-news-within-7d | 200 | 45 | 2026-07-18T22:17:51.000Z | 63 ms | keep | <https://www.theguardian.com/world/rss> |
| New York Times World | healthy | fresh-news-within-7d | 200 | 57 | 2026-07-18T22:28:01.000Z | 38 ms | keep | <https://rss.nytimes.com/services/xml/rss/nyt/World.xml> |
| Washington Post World | healthy | fresh-news-within-7d | 200 | 8 | 2026-07-18T21:47:57.000Z | 214 ms | keep | <http://feeds.washingtonpost.com/rss/world> |
| Al Jazeera | healthy | fresh-news-within-7d | 200 | 25 | 2026-07-18T21:03:34.000Z | 42 ms | keep | <https://www.aljazeera.com/xml/rss/all.xml> |
| France24 World | healthy | fresh-news-within-7d | 200 | 23 | 2026-07-18T20:10:02.000Z | 54 ms | keep | <https://www.france24.com/en/rss> |
| DW World | healthy | fresh-news-within-7d | 200 | 13 | 2026-07-18T19:57:00.000Z | 36 ms | keep | <https://rss.dw.com/xml/rss-en-world> |
| Sky News World | healthy | fresh-news-within-7d | 200 | 6 | 2026-07-18T14:41:00.000Z | 246 ms | keep | <https://feeds.skynews.com/feeds/rss/world.xml> |
| Financial Times World | healthy | fresh-news-within-7d | 200 | 25 | 2026-07-18T20:00:31.000Z | 169 ms | keep | <https://www.ft.com/world?format=rss> |
| Politico Europe | healthy | fresh-news-within-7d | 200 | 10 | 2026-07-18T22:17:09.000Z | 71 ms | keep | <https://www.politico.eu/feed/> |
| The Independent World | healthy | fresh-news-within-7d | 200 | 46 | 2026-07-18T22:05:33.000Z | 60 ms | keep | <https://www.independent.co.uk/news/world/rss> |
| ABC International | healthy | fresh-news-within-7d | 200 | 25 | 2026-07-18T21:30:02.000Z | 448 ms | keep | <https://abcnews.go.com/abcnews/internationalheadlines> |
| Fox World | healthy | fresh-news-within-7d | 200 | 25 | 2026-07-18T18:31:11.000Z | 106 ms | keep | <https://moxie.foxnews.com/google-publisher/world.xml> |
| NBC World News | healthy | fresh-news-within-7d | 200 | 14 | 2026-07-18T17:38:35.000Z | 513 ms | keep | <http://feeds.nbcnews.com/feeds/worldnews> |
| CBS World News | healthy | fresh-news-within-7d | 200 | 30 | 2026-07-18T22:30:43.000Z | 137 ms | keep | <https://www.cbsnews.com/latest/rss/world> |
| NPR World | healthy | fresh-news-within-7d | 200 | 10 | 2026-07-18T20:06:35.000Z | 45 ms | keep | <https://feeds.npr.org/1004/rss.xml> |

## Degraded or stale feeds

| Source | Category | Reason | HTTP | Articles | Newest | Latency | Action | URL |
|---|---|---|---:|---:|---|---:|---|---|
| Center for Strategic and International Studies | degraded | stale-news-over-30d | 200 | 10 | 2016-03-03T20:36:33.000Z | 80 ms | replace-or-remove | <https://www.csis.org/rss.xml> |
| International Crisis Group | degraded | low-cadence-or-aging-news | 200 | 10 | 2026-07-03T17:07:09.000Z | 300 ms | review-cadence | <https://www.crisisgroup.org/rss.xml> |

## Valid but empty feeds

_None._

## Broken feeds

| Source | Category | Reason | HTTP | Articles | Newest | Latency | Action | URL |
|---|---|---|---:|---:|---|---:|---|---|
| ACLED Conflict Data | broken | http-404 | 404 | 0 | - | 199 ms | replace-or-remove | <https://acleddata.com/feed/> |
| ReliefWeb Global Crisis | broken | rss-upstream-406 | 406 | 0 | - | 366 ms | investigate | <https://reliefweb.int/updates/rss.xml> |
| Council on Foreign Relations | broken | http-404 | 404 | 0 | - | 263 ms | replace-or-remove | <https://www.cfr.org/rss> |
| Carnegie Endowment | broken | missing-rss-or-atom-items | 200 | 0 | - | 70 ms | replace-or-remove | <https://carnegieendowment.org/rss> |
| Small Wars Journal | broken | http-404 | 404 | 0 | - | 450 ms | replace-or-remove | <https://smallwarsjournal.com/rss.xml> |
| Jane's Defence | broken | http-404 | 404 | 0 | - | 99 ms | replace-or-remove | <https://www.janes.com/feeds/rss> |
| Defense One | broken | http-404 | 404 | 0 | - | 482 ms | replace-or-remove | <https://www.defenseone.com/rss/> |
| Arms Control Association | broken | http-404 | 404 | 0 | - | 338 ms | replace-or-remove | <https://www.armscontrol.org/feeds/all> |
| Global Conflict Tracker | broken | http-404 | 404 | 0 | - | 289 ms | replace-or-remove | <https://www.cfr.org/global-conflict-tracker/rss.xml> |
| Humanitarian Response | broken | rss-upstream-406 | 406 | 0 | - | 833 ms | investigate | <https://www.humanitarianresponse.info/rss.xml> |
| UN Peacekeeping | broken | http-404 | 404 | 0 | - | 736 ms | replace-or-remove | <https://peacekeeping.un.org/en/rss.xml> |
| NATO News | broken | http-404 | 404 | 0 | - | 143 ms | replace-or-remove | <https://www.nato.int/cps/en/natohq/rss.xml> |
| EU External Action | broken | http-404 | 404 | 0 | - | 291 ms | replace-or-remove | <https://eeas.europa.eu/rss_en.xml> |
| OSCE News | broken | http-404 | 404 | 0 | - | 399 ms | replace-or-remove | <https://www.osce.org/rss.xml> |
| Euronews World | broken | http-404 | 404 | 0 | - | 48 ms | replace-or-remove | <https://www.euronews.com/rss?level=theme&name=world> |

## Blocked feeds

| Source | Category | Reason | HTTP | Articles | Newest | Latency | Action | URL |
|---|---|---|---:|---:|---|---:|---|---|
| Chatham House | blocked | http-403 | 403 | 0 | - | 108 ms | verify-access-or-replace | <https://www.chathamhouse.org/rss.xml> |
| RAND Corporation | blocked | http-403 | 403 | 0 | - | 63 ms | verify-access-or-replace | <https://www.rand.org/topics/national-security.rss> |
| ISW Institute for the Study of War | blocked | http-403 | 403 | 0 | - | 575 ms | verify-access-or-replace | <https://www.understandingwar.org/rss.xml> |
| The Telegraph World | blocked | http-403 | 403 | 0 | - | 354 ms | verify-access-or-replace | <https://www.telegraph.co.uk/news/world/rss.xml> |
| Yahoo World News | blocked | http-403 | 403 | 0 | - | 63 ms | verify-access-or-replace | <https://www.yahoo.com/news/rss/world> |

## Rate-limited feeds

_None._

## Transient failures

| Source | Category | Reason | HTTP | Articles | Newest | Latency | Action | URL |
|---|---|---|---:|---:|---|---:|---|---|
| Modern War Institute | transient | rss-network-error | - | 0 | - | 116 ms | recheck-later | <https://mwi.usma.edu/feed/> |
| Reuters World | transient | rss-network-error | - | 0 | - | 9 ms | recheck-later | <http://feeds.reuters.com/Reuters/worldNews> |

## Disabled feeds

_None._

