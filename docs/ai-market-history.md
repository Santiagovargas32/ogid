# Market explanation scheduling and history

Market explanation is an asynchronous consumer of deterministic impact snapshots and canonical evidence. A low `AI_MAX_JOBS_PER_CYCLE` previously favored the first impact item whenever recalculation metadata changed its input hash. The scheduler now prioritizes instruments without an attempt, then the least recently attempted instrument, with deterministic impact priority as the tie breaker. Failed attempts participate in rotation, so they cannot monopolize a cycle ahead of unattempted subjects. Accepted cache hits do not consume the cycle allowance. Other AI features retain their existing scheduling priority.

## Cache and concurrency

`inputHash` still identifies the complete model request. Market jobs additionally persist `cacheInputHash`, a versioned identity that excludes technical `calculatedAt`, quote transport latency/provider score, and polling timestamps/repetitions of identical consecutive impact-history values. Evidence order and object key order are normalized. The prompt retains these original fields; neither deterministic calculations nor their data are mutated.

Evidence text, article publication times, quote observation times, prices, data quality, closed candle times, indicators, distinct impact-history values and coupling observations remain significant. Changes to these inputs, the provider, model or prompt/schema version can create a new analysis. There is no automatic refresh just because a new cycle starts, and no forced request when all eligible inputs are already accepted. An unchanged failed/rejected job may be retried in a subsequent cycle under the existing budget and transport limits.

Only one revision per market instrument can be queued/running at a time, including across overlapping news and market reconciliations. Different instruments can use both concurrency slots. For example, `AI_MAX_CONCURRENCY=2`, `AI_QUEUE_MAX=20`, `AI_MAX_JOBS_PER_CYCLE=1` admits one new job per reconciliation, permits up to two different instruments in flight and bounds total outstanding work to 20. Concurrency does not select the instrument or force two new jobs in each cycle.

## Public history and persistence

The existing `marketExplanations` map is preserved. The additive `marketExplanationHistory` array contains up to three accepted records for the current market scope, sorted by completion time descending and deduplicated by cache identity. It includes the response, model, generation time, validation and source provenance. The dashboard opens the newest answer and folds the previous two beneath it, with the narrative, drivers, evidence links, limitations and uncertainty available on expansion. Expansion choices survive ordinary refreshes; a newly accepted answer becomes the open first entry.

Running, failed and rejected jobs do not displace accepted history. The UI shows their status separately. When the fourth response is accepted, only the oldest history entry leaves the panel. Administrative records and cached results remain in the existing atomic `ai-enrichments.json` store under its existing bounded retention (default 1,000 records). Removing a card therefore does not make that request new again. The cache is bounded by store retention, not permanent.

History is reconstructed from the store during the first reconciliation after restart, including records for instruments beyond the one-job cycle allowance. Removed instruments are excluded when the market scope is reconciled. REST history applies the same country filters as current market explanations, and the dashboard also applies the selected symbols. `shadow` and `off` publish empty history; validation and provider budgets are unchanged.

Existing records remain readable without migration or deletion. Older market records do not contain the normalized cache identity, so they may be regenerated once under the new cache version; their accepted responses remain available in history during that transition. Prompt/output schema versions are unchanged because the request and validation contract are unchanged.

## Verification

`backend/tests/aiMarketHistory.test.js` covers metadata-only refreshes, real input changes, fair rotation at one job per cycle, concurrency/queue limits, completion ordering, retention, failures, restart and dashboard rendering/escaping. `aiIntegration.test.js` verifies REST filters, WebSocket bootstrap/updates and frontend state. Existing llama.cpp integration tests also verify that shadow responses remain private.

Run from `backend`: `npm test` and `npm run check`. Tests use simulated model responses and isolated persistence; they do not validate live model quality or connectivity. No additional environment variable is needed. Restart the backend to load the change when using `npm start`, then reload the dashboard; `npm run dev` watches backend changes automatically.
