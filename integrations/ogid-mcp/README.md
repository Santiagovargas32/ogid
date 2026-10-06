# OGID MCP 0.2.0

Adaptador Node/ESM por stdio, conectado al backend OGID por HTTP loopback. El perfil investigación ofrece diez herramientas y lecturas almacenadas para toda la API JSON clasificada. El perfil operador añade una herramienta con operaciones enumeradas y permisos de servidor. No inicia recolectores ni recibe claves de proveedores.

## Instalar y verificar

Desde la raíz del checkout completo, con Node 22–26:

```sh
npm --prefix integrations/ogid-mcp ci --ignore-scripts
npm --prefix integrations/ogid-mcp run check
npm --prefix integrations/ogid-mcp run inventory:check
npm --prefix integrations/ogid-mcp test
npm --prefix backend run check
npm --prefix backend test
```

Las pruebas deterministas usan fixtures y protocolo MCP real; no consumen cuotas de Internet. Con el backend nuevo en ejecución, `npm --prefix integrations/ogid-mcp run smoke` comprueba las diez herramientas y cuatro paquetes sin refresh ni mutaciones. Si el archivo está vacío, declara el caso de lectura de artículo sin probar. Consultar un paquete material conserva candidatos observados; nunca reconoce entregas.

## Herramientas de investigación

| Herramienta | Datos / uso |
| --- | --- |
| ogid_health | Conectividad, versión del adaptador, fechas, calidad y disponibilidad |
| ogid_get_news | Lote editorial actual; contrato compatible con 0.1.1 |
| ogid_get_awareness | Agenda/comunicados públicos, upcoming/recent, fechas y calidad |
| ogid_get_awareness_sources | Catálogo versionado y salud pública por fuente |
| ogid_get_capabilities | Contratos, permisos, versión, cobertura y límites |
| ogid_search_news | Archivo preeditorial por países, identidades, texto, temas, fuentes y fechas |
| ogid_get_news_item | Metadata y extracto autorizado de un artículo archivado |
| ogid_resolve_instruments | Identidades verificadas del runtime, alternativas y cobertura |
| ogid_get_portfolio_context | Paquetes agenda/daily/material/weekly |
| ogid_query | Operación enumerada para mercado, inteligencia, mapas, medios y diagnóstico |

[API-MCP.md](API-MCP.md) enumera las 45 rutas JSON y 54 operaciones: 35 de investigación y 19 de operador. Sus esquemas se generan desde [el registro compartido](../../backend/contracts/ogidOperations.js). Cambiarlo exige regenerar el inventario; una prueba detecta rutas sin clasificación.

Ejemplos de argumentos MCP:

```json
{"references":["NVDA","NVIDIA","ASML","Alphabet"]}
{"symbols":["NVDA"],"from":"2026-10-04T12:00:00Z","to":"2026-10-06T12:00:00Z","limit":100}
{"operationId":"market.quotes","parameters":{"tickers":["NVDA"]}}
{"mode":"weekly","symbols":["NVDA"],"limit":30}
```

ASML/Alphabet/ETF requieren elegir un instrumentId verificado si la referencia resulta ambigua. Un nombre general de ETF requiere confirmar mercado/clase incluso si el registro conoce una sola cotización. El resolver no consulta proveedores ni registra candidaturas. Funciona sin watchlist; identidad disponible no implica precio disponible. Si una clase ETF no está verificada, devuelve unavailable y requiere intervención explícita del operador, sin sustituirla por otro producto.

## Archivo y paginación

El backend ingiere noticias intel y RSS antes del recorte editorial. Conserva metadata/extractos autorizados durante 30 días desde su recopilación, con poda por última observación y límites de 100 000 artículos / 64 MiB de metadata. JSON atómico reutiliza la persistencia existente; el índice en memoria es suficiente para este volumen local. El historial de riesgos/impactos ocupa como máximo un registro por hora durante esos 30 días. Los archivos se crean con permiso 600 y el directorio nuevo con 700.

No rellena semanas anteriores ni descarga retrospectivamente. Cobertura declara activación, oldest/newest, recepción, fechas desconocidas, poda por capacidad y continuidad de adquisición desconocida. Los snapshots actuales no demuestran continuidad histórica. El historial se registra en los ciclos intel/mercado y permanece tras reinicio; no es una serie de rentabilidades.

Filtros antes de paginar, país opcional y coincidencia por entidad con método/evidencia. Un resultado sin país incluye noticias corporativas sin etiqueta. País y empresa juntos restringen ambos. Componentes y pesos de ETF no están disponibles: no se infiere exposición cuantitativa.

`timeField` es publishedAt por defecto; admite updatedAt, receivedAt y archiveChangedAt. Publicación desconocida queda fuera de ventanas publishedAt. archiveChangedAt y contentRevision registran cambios del contenido y permiten encontrar correcciones de publicaciones antiguas; otro sondeo o feed no los convierte en noticia nueva. No verifican actualidad del hecho. Los tres tiempos de fuente/recepción se conservan por separado.

Cada búsqueda fija una revisión; continuar con `{"cursor":"nextCursor","limit":100}`. Llegadas/correcciones nuevas no alteran páginas ya abiertas. Filtros no pueden cambiar. Una página limitada por bytes avanza solo por artículos entregados. Un artículo que no cabe genera error explícito, sin saltarlo. Cursores firmados caducan a los 15 minutos, al reiniciar o por expulsión de revisiones (32 revisiones / 200 000 referencias): CURSOR_EXPIRED requiere empezar una búsqueda nueva. Artículos e historial permanecen en disco; cursores no. La retención del backend no borra respuestas ya enviadas al contexto o historial del producto cliente.

## Configuración y permisos

El adaptador no carga .env ni backend/.env automáticamente. La [plantilla de túnel](deploy/tunnel-client.profile.example.yaml) usa env -i con investigación y autorización runtime explícitas. Para --env-file usar un archivo exclusivo del adaptador, protegido, con ruta absoluta.

| Variable | Valor / función |
| --- | --- |
| OGID_BASE_URL | http://127.0.0.1:3000; solo origen loopback literal |
| OGID_PROFILE | research por defecto; operator requiere credencial privada |
| OGID_INSTRUMENT_AUTH | allowlist por compatibilidad; runtime recomendado en plantilla |
| OGID_INSTRUMENT_IDS | IDs autorizados separados por comas para allowlist |
| OGID_TIMEOUT_MS | 5000; 100–30000, incluye cuerpo HTTP |
| OGID_MAX_RESPONSE_BYTES | 2097152; máximo 4194304 |
| OGID_MAX_OUTPUT_BYTES | 262144; 4096–524288, incluye envoltura MCP |
| OGID_MAX_CONCURRENT | 4; 1–8, cola máxima 32 |
| OGID_OPERATOR_CREDENTIAL_FILE | JSON privado 600, solo perfil operador |

Variables backend: RESEARCH_NEWS_ARCHIVE_FILE y RESEARCH_ALERT_STATE_FILE, relativas al backend; valores en .env.example. MCP_OPERATOR_CREDENTIALS_FILE deshabilitado por defecto. La autenticación sensible existente permanece.

La conexión investigación no anuncia ogid_operator. El operador verifica token, alcance, método, ruta y argumentos también en servidor; registra operación y hora sin secretos. Las respuestas admin solo incluyen métricas. [OPERADOR.md](OPERADOR.md) contiene ejemplos de permisos y configuración para una conexión separada.

## Calidad y errores

Cada respuesta incluye ok, queriedAt, origin, data, warnings y truncated. Se mantienen las garantías de 0.1.1: fechas de respaldo sin publicación ficticia, stale/synthetic/mixed/fallback, Awareness off/shadow oculto y lastSuccessAt separado de agenda futura. Un precio ausente/sintético no muestra changePct=0 como rendimiento real. El commit del checkout nunca acredita el proceso cargado.

Las lecturas stored evitan consultas de RSS y resolución de medios; precios/series se leen de stores existentes. Los ciclos normales del backend pueden seguir recopilando según su configuración: una consulta no los dispara. No hay force en investigación. Solo investigación reintenta una vez 502/503/504 o ciertos fallos de conexión; no 401/429/timeout, operador ni escrituras. Redirecciones bloqueadas, TLS normal, entrada estricta y rutas enumeradas.

Salida sin texto completo, prompts internos, secretos ni rutas privadas. Artículos headline-only-link-out devuelven título/enlace y excerpt=null. Errores upstream no reflejan sus cuerpos. Archivo corrupto impide recuperación con error explícito y se conserva para revisión; no se sobrescribe vacío.

Materialidad configurable medium/high; reportes sin corroboración excluidos por defecto. includeUncorroborated habilita candidatos a confirmar, nunca hechos confirmados. Candidatos y reconocimientos se persisten 30 días / 10 000 entradas por conjunto. Correcciones semánticas reaparecen; repetir un feed no acredita corroboración independiente. Solo alerts:ack puede reconocer una entrega realmente realizada; investigación no puede garantizar ausencia de repeticiones entre ejecuciones si nadie reconoce las entregas.

Scores son heurísticos, no probabilidades. La asociación noticia/precio no demuestra causalidad. OGID complementa la investigación externa y no inventa posiciones, pesos ni holdings.

## Activación y documentación

```text
ChatGPT → túnel OpenAI ← conexión HTTPS saliente ← tunnel-client
                                                     ↕ stdio
                                                   OGID MCP
                                                     ↓ HTTP loopback
                                                  backend OGID
```

Reiniciar backend y túnel carga el código; cambios de catálogo requieren Refresh del plugin y conversación nueva. readyz no demuestra una llamada desde ChatGPT ni una tarea programada.

- [Configuración del túnel](CONFIGURAR-TUNEL.md), [runbook Fedora](RUNBOOK-FEDORA.md) y [migración/rollback](MIGRACION-0.2.md).
- [Cuatro instrucciones de tareas](TAREAS-CARTERA.md) y [evaluación desde ChatGPT](EVALUACION-CHATGPT.md).
- [Resultados y límites de esta implementación](RESULTADOS.md).

Perfiles, claves y notas de máquina quedan fuera de Git; *.local y DIAGNOSTICO-LOCAL.md están ignorados. Dependencias existentes fijadas: SDK MCP 2.3.1 y Zod 4.6.5.
