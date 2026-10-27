# Inventario API → MCP

Contrato 1.12.0. Generado desde backend/contracts/ogidOperations.js; no editar a mano.

98 rutas JSON con método; 71 operaciones de investigación y 36 de operador. Las variantes almacenadas/proveedor comparten algunas rutas.

Las cuatro herramientas compatibles se conservan. ogid_get_awareness_sources compone el catálogo local versionado y la salud pública Awareness, sin una ruta adicional. El inventario cubre las rutas de backend/routes montadas bajo /api; WebSocket, archivos estáticos y transporte del túnel tienen contratos independientes.

El research general conserva diez herramientas. El servicio OpenCode dedicado usa OGID_RESEARCH_SCOPE=agent-evidence: ogid_agent_evidence, ogid_agent_evidence_chunk, ogid_agent_clusters, ogid_get_capabilities y ogid_health; ogid_query se conserva para compatibilidad y se excluye de los permisos del analista v1.9; sus consultas quedan limitadas a evidencia congelada, clusters y metadata operativa. El alcance se verifica también al ejecutar la lectura, no sólo en el schema.

Las rutas privadas de chat, dispositivos y control agentivo son de primera parte y no se exportan como herramientas MCP. Las rutas de medios retiradas responden MEDIA_RETIRED / HTTP 410 sin adquisición ni llamadas upstream; los consumidores deben dejar de consultarlas.

| Operación | Método y ruta | Herramienta | Perfil / permiso | Proyección | Efectos / coste |
| --- | --- | --- | --- | --- | --- |
| situations.list | GET /api/situations | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| situations.status | GET /api/situations/status | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| situations.changes | GET /api/situation-changes | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| situations.detail | GET /api/situations/:id | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| situations.revisions | GET /api/situations/:id/revisions | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| situations.review | POST /api/admin/situations/review | ogid_operator | operator / situations:write | public | mutation; attributed idempotent incident creation/association/review; exact processed evidence required; no providers |
| news.comparisons | GET /api/news/comparisons | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| news.comparison.changes | GET /api/news/comparisons/changes | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| news.comparison | GET /api/news/comparisons/:id | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| news.claim | GET /api/news/claims/:id | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| news.comparison.review | POST /api/admin/news/comparisons/review | ogid_operator | operator / news:comparisons:write | public | mutation; audited idempotent merge/split/origin/claim-link; at most 500 publications per merge; no providers |
| news.source-assessments | GET /api/news/source-assessments | ogid_query | research / read:stored | public | pure stored temporal source assessments; no providers; no-provider |
| news.source-assessment | GET /api/news/source-assessments/:id | ogid_query | research / read:stored | public | pure stored assessment detail; no providers; no-provider |
| news.source-coverage | GET /api/news/source-coverage | ogid_query | research / read:stored | public | bounded normalized archive facets; no providers; pending backfill explicit; no-provider |
| news.source-assessments.import | POST /api/admin/news/source-assessments/import | ogid_operator | operator / news:assessments:write | public | mutation; max 25 assessments and 25 profiles / 64 KiB; dry-run default; redistribution permission required |
| intel.advanced.status | GET /api/intel/advanced-snapshot/status | ogid_query | research / read:stored | public | stored pure read; no job admission; no-provider |
| agent.capabilities | GET /api/agent/v1/capabilities | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| agent.brief | GET /api/agent/v1/brief | ogid_query | research / read:stored | agent-bundle | stored/local-calculation; no-provider |
| agent.geopolitical | GET /api/agent/v1/geopolitical | ogid_query | research / read:stored | agent-bundle | stored/local-calculation; no-provider |
| agent.outlooks | GET /api/agent/v1/outlooks | ogid_query | research / read:stored | agent-bundle | stored/local-calculation; no-provider |
| agent.evidence | GET /api/agent/v1/evidence | ogid_query | research / read:stored | agent-bundle | stored/local-calculation; no-provider |
| agent.evidence.chunk | GET /api/agent/v1/evidence/chunk | ogid_query | research / read:stored | agent-bundle | stored/local-calculation; no-provider |
| agent.clusters | GET /api/agent/v1/clusters | ogid_query | research / read:stored | agent-bundle | stored/local-calculation; no-provider |
| intel.bootstrap | GET /api/intel/bootstrap | ogid_query | research / read:stored | public | stored compact projection; never admits acquisition or calculation; no-provider |
| intel.sync | GET /api/intel/sync | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| intel.changes | GET /api/intel/changes | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| health | GET /api/health | ogid_health | research / read:stored | health | stored/local-calculation; no-provider |
| health.live | GET /api/health/live | ogid_query | research / read:stored | health | stored/local-calculation; no-provider |
| health.ready | GET /api/health/ready | ogid_query | research / read:stored | health | stored/local-calculation; no-provider |
| admin.runtime | GET /api/admin/runtime | ogid_operator | operator / admin:read | admin-counts | bounded administrative metrics; no-provider |
| capabilities | GET /api/capabilities | ogid_get_capabilities | research / read:stored | public | stored/local-calculation; no-provider |
| intel.snapshot | GET /api/intel/snapshot | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| intel.hotspots | GET /api/intel/hotspots | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| intel.risks | GET /api/intel/risks | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| intel.news | GET /api/intel/news | ogid_get_news | research / read:stored | news | stored/local-calculation; no-provider |
| intel.insights | GET /api/intel/insights | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| awareness | GET /api/intel/awareness-snapshot | ogid_get_awareness | research / read:stored | awareness | stored/local-calculation; no-provider |
| intel.advanced-snapshot | GET /api/intel/advanced-snapshot | ogid_query | research / read:stored | public | stored/local-calculation; explicit force preserves refresh contract; no-provider |
| intel.hotspots-v2 | GET /api/intel/hotspots-v2 | ogid_query | research / read:stored | public | stored/local-calculation; explicit force preserves refresh contract; no-provider |
| intel.anomalies | GET /api/intel/anomalies | ogid_query | research / read:stored | public | stored/local-calculation; explicit force preserves refresh contract; no-provider |
| intel.country-instability | GET /api/intel/country-instability | ogid_query | research / read:stored | public | stored/local-calculation; explicit force preserves refresh contract; no-provider |
| country-instability.alias | GET /api/country-instability | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| news.aggregate | GET /api/news/aggregate | ogid_query | research / read:stored | aggregate | stored/local-calculation; no-provider |
| news.search | GET /api/news/search | ogid_search_news | research / read:stored | archive | stored/local-calculation; no-provider |
| news.item | GET /api/news/items/:id | ogid_get_news_item | research / read:stored | archive | stored/local-calculation; no-provider |
| instruments.resolve | GET /api/market/instruments/resolve | ogid_resolve_instruments | research / read:stored | instruments | stored/local-calculation; no-provider |
| market.watchlist | GET /api/market/watchlist | ogid_query | research / read:stored | watchlist | stored/local-calculation; no-provider |
| market.quotes | GET /api/market/quotes | ogid_query | research / read:stored | quotes | stored/local-calculation; no-provider |
| market.provider-status | GET /api/market/provider-status | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| market.candles | GET /api/market/candles | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| market.candles.metrics | GET /api/market/candles/metrics | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| market.indicators | GET /api/market/indicators | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| market.technical-context | GET /api/market/technical-context | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| research.forecast-evaluation | GET /api/research/forecast-evaluation | ogid_query | research / read:stored | public | stored evaluation; no forecast registration or providers; no-provider |
| research.forecast.register | POST /api/research/forecasts | ogid_operator | operator / forecasts:write | public | mutation; prospective local registration only |
| research.scenarios | GET /api/research/scenarios | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| signals.change | GET /api/signals/change | ogid_query | research / read:stored | public | immutable historical public revision in base64 UTF-8 pages; verify sha256; never acknowledges processing; no-provider |
| signals.delta | GET /api/signals/delta | ogid_query | research / read:stored | public | stored read; never advances consumer checkpoint; no-provider |
| research.scenarios.refresh | POST /api/research/scenarios/refresh | ogid_operator | operator / signals:generate | public | mutation; stored calculations; no provider |
| research.scenarios.delete | POST /api/research/scenarios/delete | ogid_operator | operator / signals:generate | public | mutation; local audited tombstone |
| signals.checkpoint | POST /api/signals/checkpoint | ogid_operator | operator / signals:ack | public | mutation; processing acknowledgement only; no delivery receipt |
| signals.recover | POST /api/signals/recover | ogid_operator | operator / signals:ack | public | mutation; explicit recovery after snapshot review; acknowledges retained gap |
| research.event-impact | GET /api/research/event-impact | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| research.companyfacts | GET /api/research/companyfacts | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| research.sources | GET /api/research/sources | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| etf.holdings | GET /api/etf/holdings | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| market.history.job | GET /api/market/history/jobs | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| market.history.create | POST /api/market/history/jobs | ogid_operator | operator / candles:backfill | public | mutation; local job creation; run is explicit |
| market.history.datasets | GET /api/market/history/datasets | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| admin.history.status | GET /api/admin/history | ogid_operator | operator / admin:read | public | bounded stored projection; queries readonly; no-provider |
| admin.history.create | POST /api/admin/history/jobs | ogid_operator | operator / candles:backfill | public | mutation; local job creation only |
| admin.history.run | POST /api/admin/history/run | ogid_operator | operator / candles:backfill | public | mutation; max 4 Yahoo requests per explicit run |
| admin.events.replay | POST /api/admin/events/replay | ogid_operator | operator / sources:ingest | public | mutation; local Awareness snapshot replay; dryRun defaults true; no providers; snapshotId required to commit |
| admin.history.import | POST /api/admin/history/import | ogid_operator | operator / candles:backfill | public | mutation; local validated CSV; preview default; no external requests |
| market.history.run | POST /api/market/history/run | ogid_operator | operator / candles:backfill | public | mutation; max 4 Yahoo requests per run; provider limits |
| research.sources.run | POST /api/research/sources/run | ogid_operator | operator / sources:ingest | public | mutation; configured public sources only; max 4 requests |
| market.impact | GET /api/market/impact | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| market.analytics | GET /api/market/analytics | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| market.conditions | GET /api/market/conditions | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| map.config | GET /api/map/config | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| map.presets | GET /api/map/presets | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| map.themes | GET /api/map/themes | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| map.layers | GET /api/map/layers | ogid_query | research / read:stored | public | stored/local-calculation; explicit force preserves refresh contract; no-provider |
| media.streams | GET /api/media/streams | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| media.health | GET /api/media/streams/health | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| media.item | GET /api/media/streams/:id | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| diagnostics | GET /api/diagnostics | ogid_query | research / read:stored | diagnostics | sanitized counts; excludes private admin payloads; no-provider |
| portfolio.context | GET /api/portfolio/context | ogid_get_portfolio_context | research / read:stored | public | stored/local-calculation; persists observed alert candidates, never delivery; no-provider |
| market.instruments.search | GET /api/market/instruments/search | ogid_operator | operator / provider:query | public | provider requests and cache updates; provider quota/rate limits |
| intel.refresh | POST /api/intel/refresh | ogid_operator | operator / intel:refresh | public | mutation; see runtime quotas |
| market.watchlist.update | PUT /api/market/watchlist | ogid_operator | operator / watchlist:write | public | mutation; see runtime quotas |
| market.candles.backfill | POST /api/market/candles/backfill | ogid_operator | operator / candles:backfill | public | mutation; provider quota |
| media.refresh | POST /api/media/streams/refresh | ogid_operator | operator / media:refresh | public | mutation; provider requests |
| portfolio.alerts.ack | POST /api/portfolio/alerts/ack | ogid_operator | operator / alerts:ack | public | mutation; see runtime quotas |
| admin.api-limits | GET /api/admin/api-limits | ogid_operator | operator / admin:read | admin-counts | sanitized administrative projection; full internal bodies never relayed; no-provider |
| admin.news-raw | GET /api/admin/news-raw | ogid_operator | operator / admin:read | admin-counts | sanitized administrative projection; full internal bodies never relayed; no-provider |
| admin.pipeline-status | GET /api/admin/pipeline-status | ogid_operator | operator / admin:read | admin-counts | sanitized administrative projection; full internal bodies never relayed; no-provider |
| admin.ai-enrichments | GET /api/admin/ai-enrichments | ogid_operator | operator / admin:read | admin-counts | sanitized administrative projection; full internal bodies never relayed; no-provider |
| news.aggregate.fetch | GET /api/news/aggregate | ogid_operator | operator / provider:query | aggregate | provider requests and cache updates; provider quota/rate limits |
| intel.advanced.fetch | GET /api/intel/advanced-snapshot | ogid_operator | operator / provider:query | public | provider requests and cache updates; provider quota/rate limits |
| intel.instability.fetch | GET /api/intel/country-instability | ogid_operator | operator / provider:query | public | provider requests and cache updates; provider quota/rate limits |
| intel.hotspots.fetch | GET /api/intel/hotspots-v2 | ogid_operator | operator / provider:query | public | provider requests and cache updates; provider quota/rate limits |
| intel.instability-alias.fetch | GET /api/country-instability | ogid_operator | operator / provider:query | public | provider requests and cache updates; provider quota/rate limits |
| market.candles.fetch | GET /api/market/candles | ogid_operator | operator / provider:query | public | provider requests and cache updates; provider quota/rate limits |
| map.layers.fetch | GET /api/map/layers | ogid_operator | operator / provider:query | public | provider requests and cache updates; provider quota/rate limits |
| media.streams.resolve | GET /api/media/streams | ogid_operator | operator / provider:query | public | provider requests and cache updates; provider quota/rate limits |
| media.item.resolve | GET /api/media/streams/:id | ogid_operator | operator / provider:query | public | provider requests and cache updates; provider quota/rate limits |

## Contratos, cobertura y pruebas

Los query arrays viajan como CSV tipado; no se permiten claves extra, cabeceras, URLs o rutas libres. fixed se añade exclusivamente en el cliente y se verifica en backend para operador. La API existente mantiene su autenticación sensible; el permiso MCP añade credenciales de alcance, sin retirarla.

researchRoutes.integration.test.js compara todas las rutas montadas con este registro y ejecuta todas las lecturas contra backend real con proveedores bloqueados. operations.test.js verifica todas las operaciones operador mediante fixtures HTTP, métodos, permisos y cuerpos; no demuestra ejecución de proveedores reales. Las pruebas de archivo, protocolo y e2e comprueban los contratos especializados.

### situations.list

Retención: stable domain-sequence cut; candidate situations and explicitly reviewed incidents; event time may be unknown. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "kind": {
        "type": "string",
        "enum": [
          "situation",
          "incident"
        ]
      },
      "timeField": {
        "type": "string",
        "enum": [
          "changed",
          "occurred",
          "published"
        ]
      },
      "from": {
        "type": "string",
        "format": "date-time"
      },
      "to": {
        "type": "string",
        "format": "date-time"
      },
      "cursor": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4096
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "maxBytes": {
        "type": "integer",
        "minimum": 4096,
        "maximum": 262144
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### situations.status

Retención: durable source cursors, bootstrap and explicit backlog/error; no provider or model calls. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### situations.changes

Retención: durable idempotent outbox; historical changes explicit; reading does not ACK delivery. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "sinceSequence": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "cursor": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4096
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "maxBytes": {
        "type": "integer",
        "minimum": 4096,
        "maximum": 262144
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### situations.detail

Retención: exact evidence at a frozen domain cut; corrections invalidate current use without rewriting history. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "atSequence": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "cursor": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4096
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "maxBytes": {
        "type": "integer",
        "minimum": 4096,
        "maximum": 262144
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      }
    },
    "required": [
      "id"
    ],
    "additionalProperties": false
  },
  "fixed": {}
}
```

### situations.revisions

Retención: immutable domain revisions; occurrence, publication, reception and knowledge changes are distinct. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "cursor": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4096
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "maxBytes": {
        "type": "integer",
        "minimum": 4096,
        "maximum": 262144
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      }
    },
    "required": [
      "id"
    ],
    "additionalProperties": false
  },
  "fixed": {}
}
```

### situations.review

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": {
    "type": "object",
    "properties": {
      "requestId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128,
        "pattern": "^[A-Za-z0-9._:-]+$"
      },
      "action": {
        "type": "string",
        "enum": [
          "create-incident",
          "link-incident",
          "verification"
        ]
      },
      "entityId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128,
        "pattern": "^[A-Za-z0-9._:-]+$"
      },
      "title": {
        "type": "string",
        "minLength": 1,
        "maxLength": 512
      },
      "reviewer": {
        "type": "string",
        "minLength": 1,
        "maxLength": 120
      },
      "reason": {
        "type": "string",
        "minLength": 1,
        "maxLength": 2000
      },
      "references": {
        "type": "array",
        "minItems": 1,
        "maxItems": 20,
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 2048
        }
      },
      "sourceRefs": {
        "type": "array",
        "maxItems": 25,
        "items": {
          "type": "object",
          "properties": {
            "stream": {
              "type": "string",
              "enum": [
                "news",
                "awareness"
              ]
            },
            "sourceId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128,
              "pattern": "^[A-Za-z0-9._:-]+$"
            },
            "sourceRevision": {
              "type": "integer",
              "minimum": 1,
              "maximum": 2147483647
            }
          },
          "required": [
            "stream",
            "sourceId",
            "sourceRevision"
          ],
          "additionalProperties": false
        }
      },
      "verification": {
        "type": "string",
        "enum": [
          "unverified",
          "reviewed-supported",
          "reviewed-disputed",
          "retracted"
        ]
      },
      "occurredAt": {
        "type": "string",
        "minLength": 1,
        "maxLength": 80,
        "format": "date-time"
      },
      "occurrenceBasis": {
        "type": "string",
        "minLength": 1,
        "maxLength": 500
      }
    },
    "required": [
      "requestId",
      "action",
      "entityId",
      "reviewer",
      "reason",
      "references"
    ],
    "additionalProperties": false
  },
  "pathParameters": null,
  "fixed": {}
}
```

### news.comparisons

Retención: append-only derived coverage; cursor freezes revisions and window; at most 31 days. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "articleId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "from": {
        "type": "string",
        "format": "date-time"
      },
      "to": {
        "type": "string",
        "format": "date-time"
      },
      "cursor": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4096
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "maxBytes": {
        "type": "integer",
        "minimum": 4096,
        "maximum": 262144
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### news.comparison.changes

Retención: durable ordered revision log; no consumer ACK; follow every nextCursor. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "sinceSequence": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "cursor": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4096
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "maxBytes": {
        "type": "integer",
        "minimum": 4096,
        "maximum": 262144
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### news.comparison

Retención: frozen member page with attributed claims; relation hints only for returned publications. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "cursor": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4096
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "maxBytes": {
        "type": "integer",
        "minimum": 4096,
        "maximum": 262144
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      }
    },
    "required": [
      "id"
    ],
    "additionalProperties": false
  },
  "fixed": {}
}
```

### news.claim

Retención: immutable publication revision and paginated reviewer links; currentness explicit. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "cursor": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4096
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "maxBytes": {
        "type": "integer",
        "minimum": 4096,
        "maximum": 262144
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      }
    },
    "required": [
      "id"
    ],
    "additionalProperties": false
  },
  "fixed": {}
}
```

### news.comparison.review

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": {
    "type": "object",
    "properties": {
      "requestId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:-]{1,128}$"
      },
      "action": {
        "type": "string",
        "enum": [
          "merge",
          "split",
          "origin",
          "claim-link"
        ]
      },
      "reviewer": {
        "type": "string",
        "minLength": 1,
        "maxLength": 100
      },
      "reason": {
        "type": "string",
        "minLength": 8,
        "maxLength": 1000
      },
      "references": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 500
        },
        "minItems": 1,
        "maxItems": 5,
        "uniqueItems": true
      },
      "groupIds": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[A-Za-z0-9._:-]{1,128}$"
        },
        "minItems": 2,
        "maxItems": 10,
        "uniqueItems": true
      },
      "groupId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:-]{1,128}$"
      },
      "articleIds": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[A-Za-z0-9._:-]{1,128}$"
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "originChainId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:-]{1,128}$"
      },
      "leftClaimId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:-]{1,128}$"
      },
      "rightClaimId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:-]{1,128}$"
      },
      "relation": {
        "type": "string",
        "enum": [
          "support",
          "contradiction",
          "context"
        ]
      }
    },
    "required": [
      "requestId",
      "action",
      "reviewer",
      "reason",
      "references"
    ],
    "additionalProperties": false
  },
  "pathParameters": null,
  "fixed": {}
}
```

### news.source-assessments

Retención: append-only revisions; asOf and knownAt distinguish validity and knowledge. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "publisherIds": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 100
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "edition": {
        "type": "string",
        "minLength": 1,
        "maxLength": 100
      },
      "politicalScope": {
        "type": "string",
        "minLength": 1,
        "maxLength": 80
      },
      "view": {
        "type": "string",
        "enum": [
          "subjects",
          "records"
        ]
      },
      "asOf": {
        "type": "string",
        "format": "date-time"
      },
      "knownAt": {
        "type": "string",
        "format": "date-time"
      },
      "cursor": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4096
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "maxBytes": {
        "type": "integer",
        "minimum": 4096,
        "maximum": 262144
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### news.source-assessment

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "revision": {
        "type": "integer",
        "minimum": 1,
        "maximum": 1000000
      },
      "asOf": {
        "type": "string",
        "format": "date-time"
      },
      "knownAt": {
        "type": "string",
        "format": "date-time"
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 100
      }
    },
    "required": [
      "id"
    ],
    "additionalProperties": false
  },
  "fixed": {}
}
```

### news.source-coverage

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "from": {
        "type": "string",
        "format": "date-time"
      },
      "to": {
        "type": "string",
        "format": "date-time"
      },
      "knownAt": {
        "type": "string",
        "format": "date-time"
      },
      "politicalScope": {
        "type": "string",
        "minLength": 1,
        "maxLength": 80
      },
      "maxBytes": {
        "type": "integer",
        "minimum": 4096,
        "maximum": 262144
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### news.source-assessments.import

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": {
    "type": "object",
    "properties": {
      "requestId": {
        "type": "string",
        "pattern": "^[A-Za-z0-9._:-]{1,100}$"
      },
      "dryRun": {
        "type": "boolean"
      },
      "permission": {
        "type": "object",
        "properties": {
          "basis": {
            "type": "string",
            "enum": [
              "self-authored",
              "licensed",
              "permission"
            ]
          },
          "reference": {
            "type": "string",
            "minLength": 1,
            "maxLength": 500
          },
          "redistributionAllowed": {
            "type": "boolean"
          }
        },
        "required": [
          "basis",
          "reference",
          "redistributionAllowed"
        ],
        "additionalProperties": false
      },
      "assessments": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "assessmentId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9._:-]{1,100}$"
            },
            "revision": {
              "type": "integer",
              "minimum": 1,
              "maximum": 1000000
            },
            "publisherId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9._:-]{1,100}$"
            },
            "edition": {
              "type": "string",
              "minLength": 1,
              "maxLength": 100
            },
            "evaluatorId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9._:-]{1,100}$"
            },
            "evaluatorName": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160
            },
            "politicalScope": {
              "type": "string",
              "minLength": 1,
              "maxLength": 80
            },
            "methodId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9._:-]{1,100}$"
            },
            "methodVersion": {
              "type": "string",
              "minLength": 1,
              "maxLength": 80
            },
            "methodUrl": {
              "type": "string",
              "minLength": 1,
              "maxLength": 500
            },
            "originalRating": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160
            },
            "rating": {
              "type": "string",
              "enum": [
                "left",
                "center-left",
                "center",
                "center-right",
                "right",
                "not-applicable",
                "unmapped"
              ]
            },
            "scaleVersion": {
              "type": "string",
              "enum": [
                "political-five-v1",
                "external-unmapped"
              ]
            },
            "assessedAt": {
              "type": "string",
              "format": "date-time"
            },
            "validFrom": {
              "type": "string",
              "format": "date-time"
            },
            "validUntil": {
              "type": "string",
              "format": "date-time"
            },
            "state": {
              "type": "string",
              "enum": [
                "published",
                "withdrawn"
              ]
            },
            "evidenceUrls": {
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 500
              },
              "maxItems": 5,
              "uniqueItems": true
            },
            "licenseName": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160
            },
            "licenseUrl": {
              "type": "string",
              "minLength": 1,
              "maxLength": 500
            }
          },
          "required": [
            "assessmentId",
            "revision",
            "publisherId",
            "edition",
            "evaluatorId",
            "evaluatorName",
            "politicalScope",
            "methodId",
            "methodVersion",
            "methodUrl",
            "originalRating",
            "rating",
            "scaleVersion",
            "assessedAt",
            "validFrom",
            "state",
            "evidenceUrls",
            "licenseName",
            "licenseUrl"
          ],
          "additionalProperties": false
        },
        "maxItems": 25,
        "uniqueItems": true
      },
      "profiles": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "publisherId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9._:-]{1,100}$"
            },
            "edition": {
              "type": "string",
              "minLength": 1,
              "maxLength": 100
            },
            "revision": {
              "type": "integer",
              "minimum": 1,
              "maximum": 1000000
            },
            "verifiedAt": {
              "type": "string",
              "format": "date-time"
            },
            "editorialCountries": {
              "type": "array",
              "items": {
                "type": "string",
                "pattern": "^[A-Z]{2}$"
              },
              "maxItems": 10,
              "uniqueItems": true
            },
            "languages": {
              "type": "array",
              "items": {
                "type": "string",
                "pattern": "^[a-z]{2,3}$"
              },
              "maxItems": 10,
              "uniqueItems": true
            },
            "ownerGroupId": {
              "type": "string",
              "pattern": "^[A-Za-z0-9._:-]{1,100}$"
            },
            "ownerGroupName": {
              "type": "string",
              "minLength": 1,
              "maxLength": 160
            },
            "evidenceUrls": {
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 500
              },
              "maxItems": 5,
              "uniqueItems": true
            }
          },
          "required": [
            "publisherId",
            "edition",
            "revision",
            "verifiedAt",
            "editorialCountries",
            "languages",
            "evidenceUrls"
          ],
          "additionalProperties": false
        },
        "maxItems": 25,
        "uniqueItems": true
      }
    },
    "required": [
      "requestId",
      "permission"
    ],
    "additionalProperties": false
  },
  "pathParameters": null,
  "fixed": {}
}
```

### intel.advanced.status

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "jobId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      }
    },
    "required": [
      "jobId"
    ],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### agent.capabilities

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### agent.brief

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### agent.geopolitical

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### agent.outlooks

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "instrumentId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "cursor": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### agent.evidence

Retención: durable immutable bundle; permitted metadata only. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "snapshotId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "cursor": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "domain": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      }
    },
    "required": [
      "snapshotId"
    ],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### agent.evidence.chunk

Retención: recoverable base64 or readable UTF-8 chunks with sha256. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "snapshotId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "evidenceId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "offset": {
        "type": "integer",
        "minimum": 0,
        "maximum": 2147483647
      },
      "format": {
        "type": "string",
        "enum": [
          "base64",
          "utf8"
        ]
      }
    },
    "required": [
      "snapshotId",
      "evidenceId"
    ],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### agent.clusters

Retención: durable ranked catalogue and members from frozen evidence. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "snapshotId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "clusterId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "cursor": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      }
    },
    "required": [
      "snapshotId"
    ],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### intel.bootstrap

Retención: versioned dashboard-v1; full details retain v2 contracts. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "profile": {
        "type": "string",
        "enum": [
          "dashboard-v1"
        ]
      },
      "countries": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[A-Z]{2}$"
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "sources": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 20
      },
      "order": {
        "type": "string",
        "enum": [
          "recent",
          "critical"
        ]
      }
    },
    "required": [
      "profile"
    ],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### intel.sync

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "resource": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64
      },
      "epoch": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64
      },
      "revision": {
        "type": "integer",
        "minimum": 0,
        "maximum": 2147483647
      },
      "cursor": {
        "type": "integer",
        "minimum": 0,
        "maximum": 2147483647
      },
      "profile": {
        "type": "string",
        "enum": [
          "dashboard-v1"
        ]
      },
      "downloadId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 160
      },
      "filterKey": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### intel.changes

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "epoch": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64
      },
      "since": {
        "type": "integer",
        "minimum": 0,
        "maximum": 2147483647
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### health

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### health.live

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### health.ready

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### admin.runtime

Retención: last minute event-loop; last 512 HTTP samples; last 20 WS events. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### capabilities

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### intel.snapshot

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "countries": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^(ALL|[A-Z]{2})$"
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "sources": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 40
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "order": {
        "type": "string",
        "enum": [
          "critical",
          "recent"
        ]
      },
      "q": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "page": {
        "type": "integer",
        "minimum": 1,
        "maximum": 10000
      },
      "windowHours": {
        "type": "integer",
        "minimum": 1,
        "maximum": 720
      },
      "includeOlder": {
        "type": "boolean"
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### intel.hotspots

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "countries": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^(ALL|[A-Z]{2})$"
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "sources": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 40
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "order": {
        "type": "string",
        "enum": [
          "critical",
          "recent"
        ]
      },
      "q": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "page": {
        "type": "integer",
        "minimum": 1,
        "maximum": 10000
      },
      "windowHours": {
        "type": "integer",
        "minimum": 1,
        "maximum": 720
      },
      "includeOlder": {
        "type": "boolean"
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### intel.risks

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "countries": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^(ALL|[A-Z]{2})$"
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "sources": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 40
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "order": {
        "type": "string",
        "enum": [
          "critical",
          "recent"
        ]
      },
      "q": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "page": {
        "type": "integer",
        "minimum": 1,
        "maximum": 10000
      },
      "windowHours": {
        "type": "integer",
        "minimum": 1,
        "maximum": 720
      },
      "includeOlder": {
        "type": "boolean"
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### intel.news

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "countries": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^(ALL|[A-Z]{2})$"
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "sources": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 40
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "order": {
        "type": "string",
        "enum": [
          "critical",
          "recent"
        ]
      },
      "q": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "page": {
        "type": "integer",
        "minimum": 1,
        "maximum": 10000
      },
      "windowHours": {
        "type": "integer",
        "minimum": 1,
        "maximum": 720
      },
      "includeOlder": {
        "type": "boolean"
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### intel.insights

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "countries": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^(ALL|[A-Z]{2})$"
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "sources": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 40
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "order": {
        "type": "string",
        "enum": [
          "critical",
          "recent"
        ]
      },
      "q": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "page": {
        "type": "integer",
        "minimum": 1,
        "maximum": 10000
      },
      "windowHours": {
        "type": "integer",
        "minimum": 1,
        "maximum": 720
      },
      "includeOlder": {
        "type": "boolean"
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### awareness

Retención: backend retention policy (365-day default); public admission only. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "domain": {
        "type": "array",
        "items": {
          "type": "string",
          "enum": [
            "financial",
            "macro",
            "market",
            "corporate",
            "regulatory",
            "geopolitical",
            "security"
          ]
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "kinds": {
        "type": "array",
        "items": {
          "type": "string",
          "enum": [
            "macro_scheduled",
            "macro_release",
            "market_moving_news",
            "regulatory_filing",
            "official_security_release",
            "maritime_alert"
          ]
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "status": {
        "type": "array",
        "items": {
          "type": "string",
          "enum": [
            "scheduled",
            "live",
            "released",
            "updated",
            "cancelled"
          ]
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "countries": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[A-Z]{2}$"
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "instrumentIds": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "from": {
        "type": "string",
        "format": "date-time"
      },
      "to": {
        "type": "string",
        "format": "date-time"
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### intel.advanced-snapshot

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "countries": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[A-Z]{2}$"
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "windowHours": {
        "type": "integer",
        "minimum": 6,
        "maximum": 168
      },
      "maxEvents": {
        "type": "integer",
        "minimum": 50,
        "maximum": 1000
      },
      "activeWindowHours": {
        "type": "integer",
        "minimum": 1,
        "maximum": 48
      },
      "baselineDays": {
        "type": "integer",
        "enum": [
          7,
          30
        ]
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {
    "stored": true
  }
}
```

### intel.hotspots-v2

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "countries": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[A-Z]{2}$"
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "windowHours": {
        "type": "integer",
        "minimum": 6,
        "maximum": 168
      },
      "maxEvents": {
        "type": "integer",
        "minimum": 50,
        "maximum": 1000
      },
      "activeWindowHours": {
        "type": "integer",
        "minimum": 1,
        "maximum": 48
      },
      "baselineDays": {
        "type": "integer",
        "enum": [
          7,
          30
        ]
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {
    "stored": true
  }
}
```

### intel.anomalies

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "countries": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[A-Z]{2}$"
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "windowHours": {
        "type": "integer",
        "minimum": 6,
        "maximum": 168
      },
      "maxEvents": {
        "type": "integer",
        "minimum": 50,
        "maximum": 1000
      },
      "activeWindowHours": {
        "type": "integer",
        "minimum": 1,
        "maximum": 48
      },
      "baselineDays": {
        "type": "integer",
        "enum": [
          7,
          30
        ]
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {
    "stored": true
  }
}
```

### intel.country-instability

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "countries": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[A-Z]{2}$"
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "windowHours": {
        "type": "integer",
        "minimum": 6,
        "maximum": 168
      },
      "maxEvents": {
        "type": "integer",
        "minimum": 50,
        "maximum": 1000
      },
      "activeWindowHours": {
        "type": "integer",
        "minimum": 1,
        "maximum": 48
      },
      "baselineDays": {
        "type": "integer",
        "enum": [
          7,
          30
        ]
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {
    "stored": true
  }
}
```

### country-instability.alias

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "countries": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[A-Z]{2}$"
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "windowHours": {
        "type": "integer",
        "minimum": 6,
        "maximum": 168
      },
      "maxEvents": {
        "type": "integer",
        "minimum": 50,
        "maximum": 1000
      },
      "activeWindowHours": {
        "type": "integer",
        "minimum": 1,
        "maximum": 48
      },
      "baselineDays": {
        "type": "integer",
        "enum": [
          7,
          30
        ]
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {
    "stored": true
  }
}
```

### news.aggregate

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "countries": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[A-Z]{2}$"
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "topic": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64
      },
      "threat": {
        "type": "string",
        "enum": [
          "critical",
          "elevated",
          "monitoring",
          "low"
        ]
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {
    "stored": true
  }
}
```

### news.search

Retención: 30 days of permitted metadata, starting on activation. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "countries": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[A-Z]{2}$"
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "symbols": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "instrumentIds": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "q": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "topics": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        },
        "minItems": 1,
        "maxItems": 20,
        "uniqueItems": true
      },
      "sectors": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        },
        "minItems": 1,
        "maxItems": 20,
        "uniqueItems": true
      },
      "sources": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "minItems": 1,
        "maxItems": 30,
        "uniqueItems": true
      },
      "providers": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 40
        },
        "minItems": 1,
        "maxItems": 20,
        "uniqueItems": true
      },
      "from": {
        "type": "string",
        "format": "date-time"
      },
      "to": {
        "type": "string",
        "format": "date-time"
      },
      "timeField": {
        "type": "string",
        "enum": [
          "publishedAt",
          "updatedAt",
          "receivedAt",
          "archiveChangedAt"
        ]
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "cursor": {
        "type": "string",
        "minLength": 1,
        "maxLength": 2048
      },
      "maxBytes": {
        "type": "integer",
        "minimum": 4096,
        "maximum": 524288
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### news.item

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      }
    },
    "required": [
      "id"
    ],
    "additionalProperties": false
  },
  "fixed": {}
}
```

### instruments.resolve

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "references": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "exchange": {
        "type": "string",
        "minLength": 1,
        "maxLength": 80
      },
      "currency": {
        "type": "string",
        "pattern": "^[A-Z]{3}$"
      },
      "isin": {
        "type": "string",
        "pattern": "^[A-Z]{2}[A-Z0-9]{9}[0-9]$"
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### market.watchlist

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### market.quotes

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "tickers": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "includeSeries": {
        "type": "boolean"
      },
      "seriesLimit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {
    "view": "compact"
  }
}
```

### market.provider-status

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### market.candles

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "instrumentId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "interval": {
        "type": "string",
        "enum": [
          "1day",
          "1h",
          "30min",
          "15min",
          "5min"
        ]
      },
      "from": {
        "type": "string",
        "format": "date-time"
      },
      "to": {
        "type": "string",
        "format": "date-time"
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "adjusted": {
        "type": "string",
        "enum": [
          "splits",
          "none"
        ]
      },
      "source": {
        "type": "string",
        "enum": [
          "stored"
        ]
      }
    },
    "required": [
      "instrumentId"
    ],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {
    "source": "stored"
  }
}
```

### market.candles.metrics

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### market.indicators

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "instrumentId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "interval": {
        "type": "string",
        "enum": [
          "1day",
          "1h",
          "30min",
          "15min",
          "5min"
        ]
      },
      "adjusted": {
        "type": "string",
        "enum": [
          "splits",
          "none"
        ]
      },
      "package": {
        "type": "string",
        "enum": [
          "standard-v1"
        ]
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 2500
      }
    },
    "required": [
      "instrumentId"
    ],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### market.technical-context

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "instrumentId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "datasetId": {
        "type": "string",
        "pattern": "^csv-[a-f0-9]{32}$"
      },
      "interval": {
        "type": "string",
        "enum": [
          "1day",
          "1wk",
          "1h",
          "30min",
          "15min",
          "5min"
        ]
      },
      "adjusted": {
        "type": "string",
        "enum": [
          "splits",
          "none"
        ]
      },
      "package": {
        "type": "string",
        "enum": [
          "standard-v1"
        ]
      },
      "benchmarkInstrumentId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "limit": {
        "type": "integer",
        "minimum": 30,
        "maximum": 2500
      },
      "anchor": {
        "type": "string",
        "enum": [
          "live",
          "last-close"
        ]
      }
    },
    "required": [
      "instrumentId"
    ],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### research.forecast-evaluation

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "instrumentIds": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "modelVersion": {
        "type": "string",
        "minLength": 1,
        "maxLength": 100
      },
      "minSamples": {
        "type": "integer",
        "minimum": 20,
        "maximum": 500
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "asOf": {
        "type": "string",
        "format": "date-time"
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### research.forecast.register

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": {
    "type": "object",
    "properties": {
      "forecastId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "instrumentId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "benchmarkInstrumentId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "eventId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "target": {
        "type": "string",
        "enum": [
          "return",
          "relative-return",
          "direction"
        ]
      },
      "horizonHours": {
        "type": "integer",
        "minimum": 1,
        "maximum": 720
      },
      "issuedAt": {
        "type": "string",
        "format": "date-time"
      },
      "modelVersion": {
        "type": "string",
        "minLength": 1,
        "maxLength": 100
      },
      "predictedValue": {
        "type": "number"
      },
      "direction": {
        "type": "string",
        "enum": [
          "up",
          "down",
          "flat"
        ]
      },
      "probability": {
        "type": "number",
        "minimum": 0,
        "maximum": 1
      },
      "probabilityModelVersion": {
        "type": "string",
        "minLength": 1,
        "maxLength": 100
      },
      "costs": {
        "type": "object",
        "properties": {
          "commissionBps": {
            "type": "number",
            "minimum": 0,
            "maximum": 1000
          },
          "spreadBps": {
            "type": "number",
            "minimum": 0,
            "maximum": 1000
          },
          "slippageBps": {
            "type": "number",
            "minimum": 0,
            "maximum": 1000
          }
        },
        "required": [
          "commissionBps",
          "spreadBps",
          "slippageBps"
        ],
        "additionalProperties": false
      },
      "evidence": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "sourceId": {
              "type": "string",
              "minLength": 1,
              "maxLength": 128
            },
            "availableAt": {
              "type": "string",
              "format": "date-time"
            }
          },
          "required": [
            "sourceId",
            "availableAt"
          ],
          "additionalProperties": false
        },
        "minItems": 1,
        "maxItems": 20,
        "uniqueItems": true
      }
    },
    "required": [
      "forecastId",
      "instrumentId",
      "target",
      "horizonHours",
      "modelVersion"
    ],
    "additionalProperties": false
  },
  "pathParameters": null,
  "fixed": {}
}
```

### research.scenarios

Retención: durable scenarios; bounded audited revisions. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "instrumentIds": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "statuses": {
        "type": "array",
        "items": {
          "type": "string",
          "enum": [
            "pending-data",
            "watch",
            "confirmed",
            "invalidated",
            "expired"
          ]
        },
        "minItems": 1,
        "maxItems": 5,
        "uniqueItems": true
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### signals.change

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "changeId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "offset": {
        "type": "integer",
        "minimum": 0,
        "maximum": 2147483647
      },
      "maxBytes": {
        "type": "integer",
        "minimum": 4096,
        "maximum": 524288
      }
    },
    "required": [
      "changeId"
    ],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### signals.delta

Retención: durable SQL journal; legacy retention gaps remain explicit; compact references resolve via signals.change. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "consumerId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 100
      },
      "instrumentIds": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "cursor": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4096
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "maxBytes": {
        "type": "integer",
        "minimum": 4096,
        "maximum": 524288
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### research.scenarios.refresh

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": {
    "type": "object",
    "properties": {
      "instrumentIds": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      }
    },
    "required": [
      "instrumentIds"
    ],
    "additionalProperties": false
  },
  "pathParameters": null,
  "fixed": {}
}
```

### research.scenarios.delete

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": {
    "type": "object",
    "properties": {
      "scenarioId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "reason": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      }
    },
    "required": [
      "scenarioId",
      "reason"
    ],
    "additionalProperties": false
  },
  "pathParameters": null,
  "fixed": {}
}
```

### signals.checkpoint

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": {
    "type": "object",
    "properties": {
      "consumerId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 100
      },
      "checkpointCursor": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4096
      },
      "expectedSequence": {
        "type": "integer",
        "minimum": 0,
        "maximum": 2147483647
      }
    },
    "required": [
      "consumerId",
      "checkpointCursor",
      "expectedSequence"
    ],
    "additionalProperties": false
  },
  "pathParameters": null,
  "fixed": {}
}
```

### signals.recover

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": {
    "type": "object",
    "properties": {
      "consumerId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 100
      },
      "sequence": {
        "type": "integer",
        "minimum": 0,
        "maximum": 2147483647
      },
      "expectedSequence": {
        "type": "integer",
        "minimum": 0,
        "maximum": 2147483647
      },
      "reason": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      }
    },
    "required": [
      "consumerId",
      "sequence",
      "expectedSequence",
      "reason"
    ],
    "additionalProperties": false
  },
  "pathParameters": null,
  "fixed": {}
}
```

### research.event-impact

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "instrumentIds": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "eventIds": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "from": {
        "type": "string",
        "format": "date-time"
      },
      "to": {
        "type": "string",
        "format": "date-time"
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### research.companyfacts

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "companyId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      }
    },
    "required": [
      "companyId"
    ],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### research.sources

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### etf.holdings

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "instrumentId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "offset": {
        "type": "integer",
        "minimum": 0,
        "maximum": 10000
      },
      "snapshotId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      }
    },
    "required": [
      "instrumentId"
    ],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### market.history.job

Retención: durable bounded job ledger. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "jobId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      }
    },
    "required": [
      "jobId"
    ],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### market.history.create

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": {
    "type": "object",
    "properties": {
      "requestId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "instrumentIds": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "minItems": 1,
        "maxItems": 20,
        "uniqueItems": true
      },
      "targetBars": {
        "type": "integer",
        "minimum": 30,
        "maximum": 2500
      },
      "startAt": {
        "type": "string",
        "format": "date-time"
      },
      "endAt": {
        "type": "string",
        "format": "date-time"
      }
    },
    "required": [
      "requestId",
      "instrumentIds"
    ],
    "additionalProperties": false
  },
  "pathParameters": null,
  "fixed": {}
}
```

### market.history.datasets

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### admin.history.status

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "jobsLimit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 50
      },
      "legacyLimit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "datasetsLimit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "jobsCursor": {
        "type": "string",
        "minLength": 1,
        "maxLength": 2048
      },
      "legacyCursor": {
        "type": "string",
        "minLength": 1,
        "maxLength": 2048
      },
      "datasetsCursor": {
        "type": "string",
        "minLength": 1,
        "maxLength": 2048
      },
      "maxBytes": {
        "type": "integer",
        "minimum": 4096,
        "maximum": 524288
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### admin.history.create

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": {
    "type": "object",
    "properties": {
      "requestId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "instrumentIds": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "minItems": 1,
        "maxItems": 20,
        "uniqueItems": true
      },
      "targetBars": {
        "type": "integer",
        "minimum": 30,
        "maximum": 2500
      },
      "startAt": {
        "type": "string",
        "format": "date-time"
      },
      "endAt": {
        "type": "string",
        "format": "date-time"
      }
    },
    "required": [
      "requestId",
      "instrumentIds"
    ],
    "additionalProperties": false
  },
  "pathParameters": null,
  "fixed": {}
}
```

### admin.history.run

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": {
    "type": "object",
    "properties": {
      "jobId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "maxRequests": {
        "type": "integer",
        "minimum": 1,
        "maximum": 4
      }
    },
    "required": [
      "jobId"
    ],
    "additionalProperties": false
  },
  "pathParameters": null,
  "fixed": {}
}
```

### admin.events.replay

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": {
    "type": "object",
    "properties": {
      "dryRun": {
        "type": "boolean"
      },
      "snapshotId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "pathParameters": null,
  "fixed": {}
}
```

### admin.history.import

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": {
    "type": "object",
    "properties": {
      "requestId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "instrumentId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "source": {
        "type": "string",
        "minLength": 1,
        "maxLength": 60
      },
      "sourceUrl": {
        "type": "string",
        "minLength": 1,
        "maxLength": 512
      },
      "providerSymbol": {
        "type": "string",
        "minLength": 1,
        "maxLength": 80
      },
      "currency": {
        "type": "string",
        "pattern": "^[A-Z]{3}$"
      },
      "adjustmentMode": {
        "type": "string",
        "enum": [
          "splits",
          "none"
        ]
      },
      "startAt": {
        "type": "string",
        "format": "date-time"
      },
      "endAt": {
        "type": "string",
        "format": "date-time"
      },
      "csv": {
        "type": "string",
        "minLength": 1,
        "maxLength": 500000
      },
      "dryRun": {
        "type": "boolean"
      }
    },
    "required": [
      "instrumentId",
      "source",
      "sourceUrl",
      "providerSymbol",
      "currency",
      "adjustmentMode",
      "startAt",
      "endAt",
      "csv"
    ],
    "additionalProperties": false
  },
  "pathParameters": null,
  "fixed": {}
}
```

### market.history.run

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": {
    "type": "object",
    "properties": {
      "jobId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "maxRequests": {
        "type": "integer",
        "minimum": 1,
        "maximum": 4
      }
    },
    "required": [
      "jobId"
    ],
    "additionalProperties": false
  },
  "pathParameters": null,
  "fixed": {}
}
```

### research.sources.run

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": {
    "type": "object",
    "properties": {
      "sourceIds": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 100
        },
        "minItems": 1,
        "maxItems": 4,
        "uniqueItems": true
      },
      "maxRequests": {
        "type": "integer",
        "minimum": 1,
        "maximum": 4
      }
    },
    "required": [
      "sourceIds"
    ],
    "additionalProperties": false
  },
  "pathParameters": null,
  "fixed": {}
}
```

### market.impact

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "tickers": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "countries": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[A-Z]{2}$"
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "windowMin": {
        "type": "integer",
        "minimum": 10,
        "maximum": 1440
      },
      "couplingInterval": {
        "type": "string",
        "enum": [
          "1day",
          "1h",
          "30min",
          "15min",
          "5min"
        ]
      },
      "couplingWindows": {
        "type": "array",
        "items": {
          "type": "integer",
          "minimum": 15,
          "maximum": 1440
        },
        "minItems": 1,
        "maxItems": 4,
        "uniqueItems": true
      },
      "benchmarkInstrumentId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### market.analytics

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "tickers": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "countries": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[A-Z]{2}$"
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "windowMin": {
        "type": "integer",
        "minimum": 10,
        "maximum": 1440
      },
      "couplingInterval": {
        "type": "string",
        "enum": [
          "1day",
          "1h",
          "30min",
          "15min",
          "5min"
        ]
      },
      "couplingWindows": {
        "type": "array",
        "items": {
          "type": "integer",
          "minimum": 15,
          "maximum": 1440
        },
        "minItems": 1,
        "maxItems": 4,
        "uniqueItems": true
      },
      "benchmarkInstrumentId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### market.conditions

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "windowMin": {
        "type": "integer",
        "enum": [
          15,
          60,
          240,
          1440
        ]
      },
      "countries": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[A-Z]{2}$"
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "anchor": {
        "type": "string",
        "enum": [
          "live",
          "last-close"
        ]
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### map.config

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### map.presets

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### map.themes

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### map.layers

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "layers": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        },
        "minItems": 1,
        "maxItems": 30,
        "uniqueItems": true
      },
      "timeWindow": {
        "type": "string",
        "enum": [
          "1h",
          "6h",
          "24h",
          "3d",
          "7d"
        ]
      },
      "countries": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[A-Z]{2}$"
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "bbox": {
        "type": "array",
        "items": {
          "type": "number",
          "minimum": -180,
          "maximum": 180
        },
        "minItems": 4,
        "maxItems": 4
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "preset": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {
    "stored": true
  }
}
```

### media.streams

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "ids": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 80
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {
    "stored": true,
    "resolve": "none"
  }
}
```

### media.health

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### media.item

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 80
      }
    },
    "required": [
      "id"
    ],
    "additionalProperties": false
  },
  "fixed": {
    "stored": true,
    "resolve": "none"
  }
}
```

### diagnostics

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### portfolio.context

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "mode": {
        "type": "string",
        "enum": [
          "agenda",
          "daily",
          "material",
          "weekly"
        ]
      },
      "symbols": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "instrumentIds": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "countries": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[A-Z]{2}$"
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "from": {
        "type": "string",
        "format": "date-time"
      },
      "to": {
        "type": "string",
        "format": "date-time"
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "minImportance": {
        "type": "string",
        "enum": [
          "medium",
          "high"
        ]
      },
      "includeUncorroborated": {
        "type": "boolean"
      }
    },
    "required": [
      "mode"
    ],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### market.instruments.search

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "q": {
        "type": "string",
        "minLength": 1,
        "maxLength": 80
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 20
      }
    },
    "required": [
      "q"
    ],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### intel.refresh

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "countries": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[A-Z]{2}$"
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": {
    "type": "object",
    "properties": {
      "countries": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[A-Z]{2}$"
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "reason": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "pathParameters": null,
  "fixed": {}
}
```

### market.watchlist.update

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": {
    "type": "object",
    "properties": {
      "instrumentIds": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "minItems": 0,
        "maxItems": 50,
        "uniqueItems": true
      }
    },
    "required": [
      "instrumentIds"
    ],
    "additionalProperties": false
  },
  "pathParameters": null,
  "fixed": {}
}
```

### market.candles.backfill

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": {
    "type": "object",
    "properties": {
      "instrumentIds": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "minItems": 1,
        "maxItems": 20,
        "uniqueItems": true
      },
      "days": {
        "type": "integer",
        "minimum": 1,
        "maximum": 30
      },
      "adjusted": {
        "type": "string",
        "enum": [
          "splits",
          "none"
        ]
      }
    },
    "required": [
      "instrumentIds"
    ],
    "additionalProperties": false
  },
  "pathParameters": null,
  "fixed": {}
}
```

### media.refresh

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": {
    "type": "object",
    "properties": {
      "ids": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 80
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "force": {
        "type": "boolean"
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "pathParameters": null,
  "fixed": {}
}
```

### portfolio.alerts.ack

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": {
    "type": "object",
    "properties": {
      "candidateIds": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 128
        },
        "minItems": 1,
        "maxItems": 100,
        "uniqueItems": true
      },
      "deliveredAt": {
        "type": "string",
        "format": "date-time"
      }
    },
    "required": [
      "candidateIds",
      "deliveredAt"
    ],
    "additionalProperties": false
  },
  "pathParameters": null,
  "fixed": {}
}
```

### admin.api-limits

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### admin.news-raw

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "dataset": {
        "type": "string",
        "enum": [
          "intel",
          "rss-aggregate"
        ]
      },
      "page": {
        "type": "integer",
        "minimum": 1,
        "maximum": 10000
      },
      "pageSize": {
        "type": "integer",
        "minimum": 10,
        "maximum": 100
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {
    "stored": true
  }
}
```

### admin.pipeline-status

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### admin.ai-enrichments

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "status": {
        "type": "string",
        "enum": [
          "pending",
          "running",
          "ready",
          "rejected",
          "failed",
          "stale"
        ]
      },
      "kind": {
        "type": "string",
        "enum": [
          "article_summary",
          "country_insight",
          "market_explanation"
        ]
      },
      "page": {
        "type": "integer",
        "minimum": 1,
        "maximum": 10000
      },
      "pageSize": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {}
}
```

### news.aggregate.fetch

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "countries": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[A-Z]{2}$"
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "topic": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64
      },
      "threat": {
        "type": "string",
        "minLength": 1,
        "maxLength": 32
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {
    "force": true
  }
}
```

### intel.advanced.fetch

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "countries": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[A-Z]{2}$"
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "windowHours": {
        "type": "integer",
        "minimum": 6,
        "maximum": 168
      },
      "maxEvents": {
        "type": "integer",
        "minimum": 50,
        "maximum": 1000
      },
      "activeWindowHours": {
        "type": "integer",
        "minimum": 1,
        "maximum": 48
      },
      "baselineDays": {
        "type": "integer",
        "enum": [
          7,
          30
        ]
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {
    "force": true
  }
}
```

### intel.instability.fetch

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "countries": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[A-Z]{2}$"
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "windowHours": {
        "type": "integer",
        "minimum": 6,
        "maximum": 168
      },
      "maxEvents": {
        "type": "integer",
        "minimum": 50,
        "maximum": 1000
      },
      "activeWindowHours": {
        "type": "integer",
        "minimum": 1,
        "maximum": 48
      },
      "baselineDays": {
        "type": "integer",
        "enum": [
          7,
          30
        ]
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {
    "force": true
  }
}
```

### intel.hotspots.fetch

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "countries": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[A-Z]{2}$"
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "windowHours": {
        "type": "integer",
        "minimum": 6,
        "maximum": 168
      },
      "maxEvents": {
        "type": "integer",
        "minimum": 50,
        "maximum": 1000
      },
      "activeWindowHours": {
        "type": "integer",
        "minimum": 1,
        "maximum": 48
      },
      "baselineDays": {
        "type": "integer",
        "enum": [
          7,
          30
        ]
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {
    "force": true
  }
}
```

### intel.instability-alias.fetch

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "countries": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[A-Z]{2}$"
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "windowHours": {
        "type": "integer",
        "minimum": 6,
        "maximum": 168
      },
      "maxEvents": {
        "type": "integer",
        "minimum": 50,
        "maximum": 1000
      },
      "activeWindowHours": {
        "type": "integer",
        "minimum": 1,
        "maximum": 48
      },
      "baselineDays": {
        "type": "integer",
        "enum": [
          7,
          30
        ]
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {
    "force": true
  }
}
```

### market.candles.fetch

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "instrumentId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 128
      },
      "interval": {
        "type": "string",
        "enum": [
          "1day",
          "1h",
          "30min",
          "15min",
          "5min"
        ]
      },
      "from": {
        "type": "string",
        "format": "date-time"
      },
      "to": {
        "type": "string",
        "format": "date-time"
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "adjusted": {
        "type": "string",
        "enum": [
          "splits",
          "none"
        ]
      },
      "source": {
        "type": "string",
        "enum": [
          "stored",
          "yahoo"
        ]
      }
    },
    "required": [
      "instrumentId"
    ],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {
    "force": true
  }
}
```

### map.layers.fetch

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "layers": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        },
        "minItems": 1,
        "maxItems": 30,
        "uniqueItems": true
      },
      "timeWindow": {
        "type": "string",
        "enum": [
          "1h",
          "6h",
          "24h",
          "3d",
          "7d"
        ]
      },
      "countries": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^[A-Z]{2}$"
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "bbox": {
        "type": "array",
        "items": {
          "type": "number",
          "minimum": -180,
          "maximum": 180
        },
        "minItems": 4,
        "maxItems": 4
      },
      "limit": {
        "type": "integer",
        "minimum": 1,
        "maximum": 100
      },
      "preset": {
        "type": "string",
        "minLength": 1,
        "maxLength": 64
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {
    "force": true
  }
}
```

### media.streams.resolve

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "ids": {
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 80
        },
        "minItems": 1,
        "maxItems": 50,
        "uniqueItems": true
      },
      "resolve": {
        "type": "string",
        "enum": [
          "critical",
          "visible",
          "all"
        ]
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": null,
  "fixed": {
    "force": true
  }
}
```

### media.item.resolve

Retención: current snapshot; consult response coverage. Procedencia: OGID runtime; source metadata. Calidad: preserve mode, dates, stale/synthetic and missing values.

```json
{
  "parameters": {
    "type": "object",
    "properties": {
      "resolve": {
        "type": "string",
        "enum": [
          "visible",
          "all"
        ]
      }
    },
    "required": [],
    "additionalProperties": false
  },
  "body": null,
  "pathParameters": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 80
      }
    },
    "required": [
      "id"
    ],
    "additionalProperties": false
  },
  "fixed": {
    "force": true
  }
}
```


## Metadatos editoriales opcionales

capabilities.runtime.newsEditorial anuncia publisher-identity-v1, news-classification-v2, idiomas en/es/fr/de/pt y legacy-editorial-priority-v1. Los artículos pueden incorporar transportProvider, discoverySourceId, publisherId, originChainId, publisherResolution y classification (método, idioma, estado, alcance textual y modalidad). La ausencia histórica sigue siendo desconocida. Sólo publisherId con resolución resolved identifica al editor; publisher/sourceName heredados pueden ser nombres atribuidos o candidatos. Google News sigue siendo descubrimiento.

La clasificación describe relevancia informativa; reported no acredita ocurrencia ni corroboración. Negación, posibilidad futura, opinión e idioma sin soporte son explícitos. El idioma esperado del catálogo no demuestra el idioma del artículo. La prioridad heredada es una política editorial, no una probabilidad de verdad ni una evaluación política.

Los campos usan las proyecciones existentes, manteniendo envelopes, permisos, paginación estable y límites de bytes. Una revisión de metadatos conserva ID, publicación y contentRevision. El manifiesto de build añade hashes de lock e instalación, Node, contrato y esquema esperado; no es atestación criptográfica ni prueba de versión desplegada. effectiveSchemaVersion informa por separado del esquema aplicado en health.

## Evaluaciones y cobertura de medios

news.comparisons, news.comparison y news.claim exponen cobertura candidata y afirmaciones atribuidas a revisiones de publicaciones; no incidentes verificados. Los cursores fijan una secuencia durable. news.comparison.changes recorre todas las revisiones con nextCursor y nextSinceSequence; no es un ACK ni una emisión de alertas. news.comparison.review exige news:comparisons:write, motivo, revisor, referencias e idempotencia requestId; permite merge/split/origin/claim-link y conserva el historial. El agrupamiento automático es heurístico, limitado a lugar exacto, tipo, contexto temporal y seis horas; hasta 500 miembros por grupo. Orígenes y editores desconocidos no acreditan independencia.

news.source-assessments devuelve editores/ediciones, estado explícito y un resumen de hasta cinco evaluaciones. view=records pagina todas las evaluaciones efectivas con sus referencias, originales, permisos declarados y licencias; news.source-assessment consulta una revisión individual. asOf corta la vigencia y knownAt el conocimiento registrado (por defecto asOf). Los cursores fijan ambos tiempos y los watermarks de revisiones: continuar con los mismos filtros. No se promedian contextos políticos o evaluadores en desacuerdo.

news.source-assessments.import requiere operador news:assessments:write. dryRun es true por defecto; usar otro requestId al confirmar dryRun=false. Lotes de hasta 25 evaluaciones y 25 perfiles, máximo 64 KiB, revisiones consecutivas e inmutables y permiso de redistribución declarado. No descarga referencias ni valida externamente la licencia. No hay dataset político incorporado; sin datos se muestra sin evaluar. La escala ordinal political-five-v1 conserva la etiqueta original; external-unmapped no recibe posición. Una evaluación del medio no clasifica un artículo ni prueba hechos.

news.source-coverage usa recepción, ventana máxima 31 días y facetas acotadas del archivo anterior a la selección; informa artículos aún pendientes. Cuenta editores, grupos propietarios conocidos e identificadores de origen por separado. Desconocido sigue desconocido; varios países editoriales pueden atribuir el mismo artículo. No reconstruye metadatos históricos ni mide salud de adquisición. Catálogo, perfiles y evaluaciones se consultan por lectores readonly/query_only; importar utiliza el escritor único y recibo durable.
