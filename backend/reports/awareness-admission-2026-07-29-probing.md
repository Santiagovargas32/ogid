# Awareness Admission Lab

Generated: 2026-07-29T17:39:01.393Z

This isolated probe performs one logical attempt per selected source, with no retries, persistence or publication. Payload bodies and cookies are never included.

A `candidate-for-shadow` result requires manual review and the seven-day gate; this lab never promotes a source to `active`.

## Summary

| Metric | Value |
|---|---:|
| Selected sources | 4 |
| Logical attempts | 4 |
| Parsed events | 35 |
| Candidates for shadow | 2 |
| Automatic promotions | 0 |

## Results

| Source | Catalog state | Probe result | HTTP | Events | Content type | Latency ms | Body SHA-256 |
|---|---|---|---:|---:|---|---:|---|
| awareness-centcom-dvids | probing | candidate-for-shadow | 200 | 10 | application/rss+xml | 505 | 6887367b37e3c8325b6326bf1919fe6299bd167bb8be0480f7bb023710f6fb02 |
| awareness-treasury-releases | probing | transient-timeout | - | 0 | - | 9005 | - |
| awareness-ofac-actions | probing | transient-timeout | - | 0 | - | 9003 | - |
| awareness-bis-rss | probing | candidate-for-shadow | 200 | 25 | application/rss+xml | 249 | 83b8006149eee22c075d70a61241090129e75fe42ed24c97fb4168a48fa51889 |

