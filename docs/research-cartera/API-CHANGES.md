# API/MCP 1.1.0 / adaptador 0.3.0

Inventario generado y exhaustivo: [API-MCP.md](../../integrations/ogid-mcp/API-MCP.md). Pasa de 45 rutas/54 operaciones a 62 rutas/71 operaciones: 44 research `read:stored`, 27 operator. Continúan diez herramientas research; `ogid_query` anuncia los nuevos operationId. Operator añade `ogid_operator` solo con credencial de alcance. Sin URLs ni rutas arbitrarias. El paquete npm backend conserva 1.0.0; la versión del contrato es 1.1.0 y ambas identidades se exponen por separado.

## Operaciones nuevas

| Operación | Perfil / alcance | Resultado funcional y límite |
| --- | --- | --- |
| market.technical-context | research / read:stored | standard-v1 local; diario/semanal derivado/intradía; 30–2500 barras; benchmark opcional verificado |
| research.event-impact | research / read:stored | Evidencias, revisiones y canales candidatos por evento/activo; hasta 100 resultados |
| research.companyfacts | research / read:stored | Hechos SEC persistidos por companyId; ausencia explícita si no hubo ingesta |
| research.sources | research / read:stored | Admisión y salud pública; excluye contacto SEC/configuración privada |
| etf.holdings | research / read:stored | Snapshot fechado ISIN/mercado; hasta 100 por página, offset y snapshotId obligatorio al continuar |
| market.history.job | research / read:stored | Estado persistente, intentos, cobertura/huecos y goalMet |
| research.scenarios | research / read:stored | Escenarios persistidos con estado/evidencia/revisión; no recalcula al leer |
| signals.delta | research / read:stored | Journal por consumidor; snapshot/cursor/bytes, lectura sin checkpoint ni entrega |
| research.forecast-evaluation | research / read:stored | Evaluación temporal de registros; insufficient-evaluation con menos de 30 observaciones por defecto |
| market.history.create | operator / candles:backfill | Job idempotente, 20 identidades máximo; objetivo 500, rango 30–2500 |
| market.history.run | operator / candles:backfill | 1–4 ventanas Yahoo por ejecución; persistencia, cooldown/reintento explícitos |
| research.sources.run | operator / sources:ingest | 1–4 solicitudes a fuentes admitidas/configuradas; no scraper libre |
| research.scenarios.refresh | operator / signals:generate | Cálculos locales e historial de cambios, sin proveedor |
| research.scenarios.delete | operator / signals:generate | Borrado con tombstone y motivo |
| signals.checkpoint | operator / signals:ack | Reconocimiento CAS de procesamiento; delta global del consumidor |
| signals.recover | operator / signals:ack | Recuperación explícita de hueco tras revisar snapshot; secuencia actual y motivo |
| research.forecast.register | operator / forecasts:write | Registro antes del resultado, modelo/objetivo/horizonte/disponibilidad y costes |

## Operaciones existentes modificadas

| Operación / consumidor | Compatibilidad |
| --- | --- |
| health / capabilities | Identidad capturada al cargar backend/adaptador, SHA256 local, dirty/unknown y contrato. runningCommitVerified=false; commit declarado no es atestación |
| market.quotes | MCP fija view=compact: solo tickers solicitados; series únicamente includeSeries=true, seriesLimit≤100. HTTP legacy mantiene su forma predeterminada |
| market.candles | Añade snapshot/revisión/cobertura/calidad; solo intervalos soportados 5min/15min/30min/1h/1day |
| market.indicators | Default legacy; package=standard-v1 opt-in. ATR simple explícito y Wilder separado, sin reescritura histórica |
| news.search | Hash de filtros semánticos; cursor solo, snapshots estables y presupuesto sin saltos |
| portfolio.context | Añade resumen de escenarios. Mantiene paquetes, calidad y persistencia legacy de candidatos observados; no acredita entrega |
| predictions / WebSocket legacy | confidence y predictedConfidence siguen como aliases de signalStrength; confidenceKind heurístico, probability=null y evaluación insuficiente. Dato ausente/sintético no se vuelve rendimiento cero |
| frontend | Sin rediseño: los campos legacy se conservan y el panel ya advierte que índices/presión no son probabilidades. Syntax check incluye frontend/js; no se realizó inspección visual de navegador |

Semanal solo está anunciado en technical-context, derivado de sesiones diarias completas (siete días para 24x7). Volatilidad diaria declara factor 252 cash o 365 para 24x7. Mensual no está anunciado. RAW Yahoo puede conservar intervalos antiguos internamente; eso no los convierte en contrato técnico soportado.

## Semántica y efectos

Research no solicita proveedores, no registra pronósticos y no modifica selección/configuración. portfolio.context conserva el efecto ya anunciado de persistir candidatos observados. Los ciclos normales existentes incorporan eventos públicos y refrescan escenarios de la watchlist; los adaptadores oficiales nuevos requieren run operador. confirmed significa que se cumplieron condiciones observables, no éxito futuro.

Signals separa observedAt/generatedAt de deliveredAt/acknowledgedAt. Estos últimos permanecen null en los cambios. Un checkpoint reconoce procesamiento, con deliveryVerified=false. La operación legacy portfolio.alerts.ack conserva la declaración de entrega por el operador; no incorpora verificación externa ni recibos ChatGPT.

Una muestra insuficiente puede incluir métricas descriptivas, pero no calibración acreditada. Brier solo usa probabilidades de modelos registradas explícitamente. Walk-forward purga horizontes y disponibilidad posteriores; describe particiones y no afirma entrenar un modelo. Entry es el último cierre diario disponible, no un precio ejecutable; netReturn es movimiento observado menos costes declarados, no P&L de una estrategia con posiciones.
