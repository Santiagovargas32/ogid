# Awareness source admission — 2026-07-29

This report records the initial bounded admission decision. It does not promote any candidate directly to `active` and contains no response bodies, event titles, cookies or credentials.

## Request policy

- Two isolated batches, eight logical attempts and eight network requests.
- Concurrency 1, retries 0, timeout 9 seconds, maximum response 1 MB.
- Credential-free HTTPS only; redirects restricted to declared source hosts.
- No Express server, scheduler, event persistence or publication.

Machine-readable evidence is available in:

- `awareness-admission-2026-07-29-probing.json`
- `awareness-admission-2026-07-29-shadow.json`

## Admission decisions

| Source | Evidence | Decision | Reason |
|---|---|---|---|
| Federal Reserve calendar/releases, BLS calendar/releases, BEA schedule | Existing local runtime healthy | `active` | Existing official P0 set; unchanged. |
| DVIDS / U.S. Central Command Public Affairs | HTTP 200; 10 `/news/` events after filtering 45 mixed feed items | `shadow` | Official distributor with preserved DVIDS/CENTCOM attribution; not presented as a direct `centcom.mil` fetch. |
| BIS press releases | HTTP 200; 25 events | `shadow` | RSS parser now prioritizes the official `dc:date` and accepts the BIS central-bank date fields instead of poll-time fallbacks. |
| U.S. Defense Releases | HTTP 200; 10 events | `shadow` | Independent official thematic coverage, not a silent CENTCOM fallback. |
| ECB press releases | HTTP 200; 15 events | `shadow` | Stable official RSS and source timestamps. |
| USGS significant events | HTTP 200; 0 features | `shadow` | Valid empty GeoJSON state; recorded as `empty-valid`, never as a fabricated event or failed poll. |
| MARAD MSCI RSS | Initial audit HTTP 200/10 events; admission lab HTTP 403 | `probing` | Official alternate transport is not yet stable from the configured client. No scheduled calls until reviewed. |
| Treasury press releases | Admission poll timed out; earlier HTML inspection produced navigation false positives | `probing` | Requires a Treasury-specific release selector. |
| OFAC Recent Actions | Admission poll timed out; earlier HTML inspection produced category false positives | `probing` | Requires an OFAC-specific result selector. OFAC retired its RSS in 2025. |
| CENTCOM public-release HTML | Three consecutive local HTTP 403 responses | `blocked` | Persistent upstream denial; no fourth call after deployment/restart. |
| MARAD advisory HTML | Three consecutive local HTTP 403 responses | `blocked` | Persistent upstream denial; the separate RSS candidate does not inherit this identity/state. |
| IDF media releases | Official page serves a challenge/placeholder to the server client | `blocked` | No WAF bypass, browser emulation or X fallback. |
| SEC EDGAR watchlist | Adapter/mapping contract incomplete | `blocked` | Requires verified instrument-to-CIK mapping before any request. |

## Sanitized 403 evidence

The MARAD RSS admission response returned HTTP 403 in 72 ms with `content-type: text/html`, `server: AkamaiGHost`, 410 body bytes and SHA-256 `19c9dd6a38d7f0a10afc185c0e0c738c6e40a44eaf6560f4353656071a5d9634`. It included no allowlisted request ID or `Retry-After`. The body itself was discarded and is not present in either report.

## Source references and attribution

- [MARAD MSCI RSS](https://www.maritime.dot.gov/taxonomy/term/441/feed)
- [DVIDS U.S. Central Command Public Affairs](https://www.dvidshub.net/unit/CENTCOM/)
- [U.S. Defense RSS directory](https://www.war.gov/News/RSS/)
- [ECB RSS directory](https://www.ecb.europa.eu/home/html/rss.en.html)
- [BIS RSS directory](https://www.bis.org/rss/index.htm)
- [USGS real-time feeds](https://earthquake.usgs.gov/earthquakes/feed/)
- [OFAC notice retiring RSS](https://ofac.treasury.gov/recent-actions/20250206)
- [DVIDS copyright/credit guidance](https://www.dvidshub.net/about/copyright)
- [BIS terms](https://www.bis.org/terms_conditions.htm)

Use headline, bounded excerpt, attribution and canonical link only. A source may move from `shadow` to `active` only after seven rolling days with stable structure/times, at least 95% successful polls and no false coordinates.

`fallbackFor` and `coverageRole` are descriptive provenance fields only. There is no automatic failover, source relabeling or security-release corroboration in this rollout; DVIDS and Defense can publish overlapping material, so correlation/deduplication remains a gate before activation.
