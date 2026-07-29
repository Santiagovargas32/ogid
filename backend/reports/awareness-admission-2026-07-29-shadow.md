# Awareness Admission Lab

Generated: 2026-07-29T17:39:42.198Z

This isolated probe performs one logical attempt per selected source, with no retries, persistence or publication. Payload bodies and cookies are never included.

A `candidate-for-shadow` result requires manual review and the seven-day gate; this lab never promotes a source to `active`.

## Summary

| Metric | Value |
|---|---:|
| Selected sources | 4 |
| Logical attempts | 4 |
| Parsed events | 25 |
| Candidates for shadow | 3 |
| Automatic promotions | 0 |

## Results

| Source | Catalog state | Probe result | HTTP | Events | Content type | Latency ms | Body SHA-256 |
|---|---|---|---:|---:|---|---:|---|
| awareness-marad-advisories-rss | shadow | blocked-by-upstream | 403 | 0 | text/html | 72 | 19c9dd6a38d7f0a10afc185c0e0c738c6e40a44eaf6560f4353656071a5d9634 |
| awareness-us-defense-releases | shadow | candidate-for-shadow | 200 | 10 | text/xml; charset=utf-8 | 217 | 863e982a2d4778fabe10bf73d2c2dfbc4361e8b43ed7e9f0f50c1c82a2199cf2 |
| awareness-ecb-rss | shadow | candidate-for-shadow | 200 | 15 | application/rss+xml | 115 | bc23e7c7936bd035481cf21080769070f2cf0bcaea1893535fbed365b35579f8 |
| awareness-usgs-significant | shadow | candidate-for-shadow | 200 | 0 | application/json; charset=utf-8 | 149 | 29d137e1e20e62acfced2a88cdc5e547479de6b1f86a2202676c9ef36f8a2e1b |

