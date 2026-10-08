# API/MCP 1.2.0 / adaptador 0.4.0

Inventario generado y exhaustivo: [API-MCP.md](../../integrations/ogid-mcp/API-MCP.md). La entrega anterior tenía 62 rutas/71 operaciones; esta añade seis rutas y operaciones: 68 rutas/77 operaciones, 45 research `read:stored` y 32 operator. Continúan diez herramientas research; `ogid_query` anuncia los nuevos operationId. Operator añade `ogid_operator` solo con credencial de alcance. El paquete npm backend conserva 1.0.0; la versión del contrato es 1.2.0 y ambas identidades se exponen por separado. Los cuerpos CSV aceptan URL como metadata saneada de procedencia, sin visitarla ni aceptar rutas locales.

## Histórico y eventos: incremento 1.2.0

| Operación / cambio | Perfil / alcance | Comportamiento |
| --- | --- | --- |
| market.history.datasets | research / read:stored | Metadata de series CSV disponibles; sin proveedores |
| market.technical-context: datasetId opcional | research / read:stored | Lee la serie CSV declarada, diaria/semanal sin benchmark externo; verifica instrumento y ajuste |
| market.history.create: startAt opcional | operator / candles:backfill | Rango explícito de hasta cinco años; conserva idempotencia y jobs anteriores |
| admin.history.status | operator / admin:read | Cobertura diaria, jobs, datasets, identidad pendiente y catálogo de fuentes |
| admin.history.create / run | operator / candles:backfill | Preparación local y ejecución explícita de hasta cuatro operaciones chart, sin reintentos internos de chart |
| admin.history.import | operator / candles:backfill | Vista previa por defecto; CSV canónico aislado, idempotente, procedencia declarada; hasta 500 kB/5000 filas |
| admin.events.replay | operator / sources:ingest | Vista previa y relectura de hasta 500 eventos del snapshot Awareness visible; snapshotId obligatorio al guardar |
| research.sources: catalog adicional | research / read:stored | Conserva sources específicos y expone Awareness con admisión/estado diferenciados |
| research.event-impact | research / read:stored | Identidad por fuente/publicación v2; legacy excluido de impactos y conservado para auditoría |

[Uso, límites, migración y datos pendientes](HISTORICO-E-IDENTIDADES.md). Las rutas admin conservan su autorización HTTP existente; MCP requiere además perfil/alcance. No se ha activado un descargador automático de otro proveedor sin clave.

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
