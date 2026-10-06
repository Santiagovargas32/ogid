# Inventario API → MCP

Contrato 1.0.0. Generado desde backend/contracts/ogidOperations.js; no editar a mano.

45 rutas JSON con método; 35 operaciones de investigación y 19 de operador. Las variantes almacenadas/proveedor comparten algunas rutas.

Las cuatro herramientas compatibles se conservan. ogid_get_awareness_sources compone el catálogo local versionado y la salud pública Awareness, sin una ruta adicional. El inventario cubre las rutas de backend/routes montadas bajo /api; WebSocket, archivos estáticos y transporte del túnel tienen contratos independientes.

| Operación | Método y ruta | Herramienta | Perfil / permiso | Proyección | Efectos / coste |
| --- | --- | --- | --- | --- | --- |
| health | GET /api/health | ogid_health | research / read:stored | health | stored/local-calculation; no-provider |
| capabilities | GET /api/capabilities | ogid_get_capabilities | research / read:stored | public | stored/local-calculation; no-provider |
| intel.snapshot | GET /api/intel/snapshot | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| intel.hotspots | GET /api/intel/hotspots | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| intel.risks | GET /api/intel/risks | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| intel.news | GET /api/intel/news | ogid_get_news | research / read:stored | news | stored/local-calculation; no-provider |
| intel.insights | GET /api/intel/insights | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| awareness | GET /api/intel/awareness-snapshot | ogid_get_awareness | research / read:stored | awareness | stored/local-calculation; no-provider |
| intel.advanced-snapshot | GET /api/intel/advanced-snapshot | ogid_query | research / read:stored | public | stored/local-calculation; normal API may fetch RSS; no-provider |
| intel.hotspots-v2 | GET /api/intel/hotspots-v2 | ogid_query | research / read:stored | public | stored/local-calculation; normal API may fetch RSS; no-provider |
| intel.anomalies | GET /api/intel/anomalies | ogid_query | research / read:stored | public | stored/local-calculation; normal API may fetch RSS; no-provider |
| intel.country-instability | GET /api/intel/country-instability | ogid_query | research / read:stored | public | stored/local-calculation; normal API may fetch RSS; no-provider |
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
| market.impact | GET /api/market/impact | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| market.analytics | GET /api/market/analytics | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| market.conditions | GET /api/market/conditions | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| map.config | GET /api/map/config | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| map.presets | GET /api/map/presets | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| map.themes | GET /api/map/themes | ogid_query | research / read:stored | public | stored/local-calculation; no-provider |
| map.layers | GET /api/map/layers | ogid_query | research / read:stored | public | stored/local-calculation; normal API may fetch RSS; no-provider |
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
          "5min",
          "1wk",
          "1mo"
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
          "5min",
          "1wk",
          "1mo"
        ]
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
      "instrumentId"
    ],
    "additionalProperties": false
  },
  "body": null,
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
          "5min",
          "1wk",
          "1mo"
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
