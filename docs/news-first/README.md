# OGID: noticias como superficie principal

Rama `fix/news-first-dashboard-rss-performance`, basada en `origin/main` revalidado el 10-10-2026: `5f141823c10eafdebb5529f119e5c86766fda5f0`. No se consultó ni integró la implementación de `feat/sqlite-worker-news-pipeline` / PR #11. El checkout original y `backend/data/` ajeno se conservan. Trabajo y pruebas en worktree aislado, Node v24.10.0. No merge ni despliegue.

## Incidencia: evidencia y límites

Confirmado en main y reproducido con upstreams falsos:

- Admin esperaba diez respuestas antes de mostrar una sección. Una respuesta RSS pendiente deja vacíos incluso los diagnósticos ya recibidos. El browser antes muestra **0** diagnósticos disponibles a los 800 ms; después muestra contenido útil sin esperar RSS.
- Sus consultas de agregado/raw podían iniciar recolección; `request` no limitaba conexión/cuerpo y `setInterval` permitía ciclos superpuestos. Ahora las lecturas rutinarias usan `stored=1`, hay timeout de 12 s, AbortSignal, estados loading/error/stale por sección y conservación de últimos valores válidos. Las etiquetas distinguen comprobación HTTP y antigüedad del dato.
- La selección RSS y el agregado seguían dos caminos: el fixture inicial hacía 36 consultas para 18 feeds. Scheduler, ingestión, agregado y selección ahora comparten `RssAggregatorService` y su pipeline canónica. La entrega se realiza antes del archivo/contexto, mapas o IA. Los proveedores con cuota conservan su ciclo y configuración.
- El runtime liberaba recursos al recibir headers; la vía canónica ahora mantiene límite hasta cuerpo y parseo. Colas cancelables y circuitos por host aíslan publishers.
- Histórico diario seguía presente; se retiraron sección, importación CSV, replay del formulario y módulo sin consumidores.

**No confirmado en despliegue:** todos los GET a `http://192.168.1.50:3000` agotaron 5 s sin respuesta HTTP desde este entorno ([detalle](lan-probe.json)). No hubo 401/403/404/5xx observable ni acceso al firewall/proceso del operador; no se puede distinguir ruta/firewall/listen/proceso detenido con ese resultado. No hubo acceso a un segundo equipo físico, Tailscale ni proxy real. La autenticación LAN/token y rechazo de spoofing se probaron con HTTP local y direcciones de transporte simuladas; dos contextos de browser y 1/10 clientes HTTP son clientes locales aislados, no prueba de conectividad física LAN.

No se halló localhost hardcoded en API/WS del frontend: usan mismo origen y ws/wss según la página. Las hipótesis pendientes de la LAN son red/listen/firewall y configuración efectiva del proceso desplegado. Su resolución remota requiere los pasos de operador de este documento; no se declara resuelta por las pruebas locales.

## Lecturas, refresco y corpus

- Dashboard consume estado seleccionado almacenado; Admin usa `stored=1` para agregado/raw y `resolve=none` para medios. Advanced Intelligence rutinario y capas de mapas se calculan sobre datos almacenados. Las lecturas de 1/10 clientes no aumentan consultas RSS en el test de adquisición.
- Se conserva el contrato de refresh externo de agregado sin `stored` y de operaciones explícitas `force`. El refresco manual comparte single-flight y cooldown mínimo del scheduler; no permite eludir cadencias/cooldown por feed. No se cambió la semántica de force de proveedores con cuota.
- **Raw RSS**: elementos normalizados del agregado almacenado y estado de adquisición. **Corpus de señales**: candidatos retenidos, deduplicados y relevantes para análisis, no todo Internet. **Selección visible**: relevancia/diversidad/deduplicación existentes, ventana y criticidad aplicadas antes del límite de selección; puede ser mucho menor que raw. **Anteriores**: metadatos permitidos del archivo, colección identificada separadamente de selección actual; la UI consulta hasta 500 y no usa el archivo como baseline de novedades. Investigación ofrece sus propios cursores para explorar más.
- `order=critical|recent`, `q`, `page`, `windowHours` y `includeOlder` están registrados, validados y documentados en el inventario API/MCP 1.3.0. Sin `order`, HTTP conserva el orden cronológico previo; dashboard pide criticidad explícitamente. No se retira ningún endpoint público.

## RSS acotado

| Parámetro | Valor nuevo por defecto | Ajuste / efecto |
|---|---:|---|
| `NEWS_RSS_PIPELINE_MODE` | `canonical` | `legacy` permite rollback; `shadow` existe por compatibilidad pero duplica tráfico y no se habilita |
| `NEWS_RSS_AGGREGATE_INTERVAL_MS` | 30000 | Pausa entre ciclos terminados; no crea trabajos superpuestos |
| `NEWS_RSS_AGGREGATE_FEEDS_PER_RUN` | 18 | 1–18; ahora permite lotes pequeños |
| `NEWS_RSS_GLOBAL_CONCURRENCY` | 4 | Máximo de feeds activos |
| `NEWS_RSS_HOST_CONCURRENCY` | 1 | Un host no ocupa slots globales mientras espera su turno |
| `NEWS_TIMEOUT_MS` | 9000 | Presupuesto completo por feed canónico; compartido con configuración previa de proveedores |
| `NEWS_RSS_CYCLE_DEADLINE_MS` | 25000 | Cola + conexión + headers + cuerpo + parseo; pendientes cancelados sin marcar intento ficticio |
| `NEWS_RSS_MAX_RESPONSE_BYTES` | 2000000 | Límite de cuerpo, incluido streaming y redirects de fetch dentro del presupuesto |
| `NEWS_RSS_MAX_ITEMS_PER_FEED` | 200 | Límite de elementos parseados por respuesta |
| `NEWS_RSS_AGGREGATE_MAX_ITEMS` | 900 | Corpus RSS en memoria y estado canónico |
| `NEWS_CANDIDATE_WINDOW_HOURS` | 36 | Ventana de selección; UI 36 h y acceso separado a anteriores |
| `NEWS_RSS_CANONICAL_STATE_FILE` | `data/rss-canonical-state.json` | JSON atómico, conserva estados/corpus al reiniciar |

Cadencias iniciales conservadas: primarios 15 min, búsquedas secundarias 60 min, jitter ±5 %. Objetos de feed admiten `priority` y `minPollIntervalMs` como overrides explícitos. RSS directo precede a búsquedas, con rotación justa por host y feeds nunca comprobados antes de repetir el catálogo. Búsqueda Google se etiqueta como búsqueda y conserva publisher/procedencia disponibles; no se presenta Google como editor del artículo.

Catálogo por defecto examinado sin secretos: 66 feeds primarios + 435 búsquedas = 501 identidades (puede variar con configuración). El fixture de 300 feeds, 240 del mismo host, completa cobertura en 20 ciclos sin superar 4 global / 1 host. Límite ideal de primera cobertura para 501 a 18/ciclo: 28 ciclos; con pausa de 30 s y hasta 25 s de trabajo son del orden de 14–26 min **si cada lote puede completarse**. Respuestas lentas, muchas búsquedas del mismo host, backoff y feeds diferidos pueden ampliarlo considerablemente. La cadencia de 15/60 min no asegura cobertura íntegra en ese plazo bajo saturación. «Continuo» significa servicio periódico activo, sin promesa de llegada inmediata desde publicación.

ETag/Last-Modified y 304 conservan artículos sin volver a ingerirlos. Envelope RSS/Atom vacío es válido; XML sin envelope/cierres de entrada válidos se rechaza. 429 usa Retry-After y cooldown del host; errores usan backoff por feed hasta 6 h. Redirects siguen la política finita de fetch bajo el mismo timeout/byte cap; no se hace otro barrido. Los feeds diferidos conservan elegibilidad anterior. Admin muestra salud acumulada del catálogo, comprobación/éxito/próximo intento/backoff, cobertura, cola/en vuelo, hosts limitados, 304, errores, nuevos en el conjunto retenido y duración. Parada del scheduler aparece como parada, aunque queden datos.

El `.env` local del operador no se modificó. Su proyección no secreta detectada ([configuración](local-config-nonsecret.json)) todavía especifica **legacy, 900000 ms y deadline 60000 ms**: esos valores explícitos prevalecen sobre los defaults. Adoptar canonical requiere ajustarlos al desplegar; cambiar `.env.example` no cambia un proceso ya existente. `DISABLE_BACKGROUND_REFRESH=1` detiene adquisición autónoma.

## Identidad, fechas y presentación

Identidad RSS `news-<sha256>` por URL canónica reutilizando el helper IA: elimina fragmento/tracking. Sin URL: publisher normalizado + título NFKC normalizado + día de fecha fuente válida, sin posición/fetchedAt. Ese fallback puede unir titulares iguales del mismo publisher/día y cambia al editar título sin URL; es una limitación documentada. IDs externos no RSS se conservan, junto a `identity` estable. RSS restaurado se normaliza conservando IDs anteriores como aliases. El archivo conserva IDs `article-*`, esquema y `originalIds`; IA conserva identidad canónica y aliases anteriores.

`publishedAt` sólo procede de fecha fuente válida. Ausente/ilegible/futura >5 min queda null con calidad missing/invalid/future; Atom con sólo updated conserva `updatedAt` y no inventa release date. `receivedAt/firstSeenAt` se mantienen por deduplicación para situar temporalmente entradas sin fecha. Se etiquetan fechas desconocidas y valoración unknown si falta clasificador. La valoración procede de reglas de cada artículo (RSS classifier / señales existentes), con origen visible; no se copia criticidad del país ni se muestran probabilidades inventadas.

Live News Feed ocupa col-12 y cada fila conserva imagen lazy, con placeholder OGID para ausencia/error. Orden criticidad → publicación → identidad estable, búsqueda, país, criticidad, recientes, ventana y páginas de 40. Se conservan drawer, brief, procedencia, fuente e IA. Baseline de selección completo precede a filtros/páginas; revisiones repetidas, 304, IA y mercados no generan novedades. Retención de seen IDs 48 h / 10000, guardada por sesión cuando cambia contenido; reconnect de la misma sesión reconoce artículos recibidos durante desconexión. Fuera de esa retención o sin baseline se establece un baseline nuevo.

Novedades agrupadas en header y marcador Nueva con borde/fondo de 2 s; actualizaciones editoriales conservan identidad y marcador Actualizada. Sin toast, modal o sonido. Al leer abajo/con foco/drawer abierto se conserva orden y fila (incluso si sale de la nueva selección) hasta pulsar el indicador o cambiar filtro/página. Sólo hay 40 filas y caché de filas visibles; seen/pending acotados. Lotes se anuncian con aria-live polite y animación respeta reduced-motion. Mercado no reconstruye DOM del feed. WS principal conserva envelopes existentes; fallback almacenado 15 s, 90 s oculto, backoff/jitter hasta 5 niveles. Respuestas HTTP anteriores a WS se descartan. Clientes con buffer >1 MB se cierran y recuperan snapshot al reconectar.

## Auditoría de retiradas

| Elemento | Decisión | Consumidor o motivo |
|---|---|---|
| Geopolitical Map, `panel-hotspots`, controles/capas/listeners de mapa UI | Eliminado | Dashboard pasa a feed col-12 |
| `frontend/js/map.js`, Leaflet CSS/JS | Eliminado | No quedan consumidores UI; `getLevelColor` pasa a `levelColors.js` |
| Escalation Hotspots y `escalationHotspots.js` | Eliminado | Registro/import/renderer retirados; CII/anomalías/World Brief permanecen |
| Hotspot Webcams, opción situationalWorkspace, `webcamStreams.js`, CSS exclusivo | Eliminado | Live Situational Awareness/TV permanece; Admin ya no lista webcams |
| Histórico diario/CSV/rango/replay en Admin, `adminHistory.js`, seis helpers exclusivos | Eliminado | No se borran datos ni servicios |
| APIs mapa, hotspots-v2, hotspots, riesgos, media webcams | Conservado | Inventario API/MCP y consumidores externos; transporte state compatible conserva campos |
| Enriquecimiento mapAssets de cada ciclo/mercado | Desactivado | Capas calculadas bajo demanda con RSS almacenado; método automático sin consumidores retirado |
| Riesgo por país y hotspots en envelopes backend | Conservado | APIs públicas y cálculo compartido de riesgo; no se presentan en UI retirada |
| Replay/agenda, research/archive, velas/backfill, análisis técnicos, histórico IA | Conservado | API/MCP, investigación y OHLCV/IA activos |
| Chart.js, assets OGID/news-placeholder, medios TV | Conservado | Gráficos y vistas activas |

No había otros assets de mapa exclusivos en `frontend/assets`. No se borraron archivos del operador ni se migró almacenamiento. Los servicios de webcam conservados construyen metadatos; su renderer y vista UI se retiraron.

## Verificación reproducible

```sh
npm ci --ignore-scripts --prefix backend
npm ci --ignore-scripts --prefix integrations/ogid-mcp
cd backend
npm run check
npm test
node scripts/benchmark-news-first.js
node scripts/benchmark-news-persistence.js
node --expose-gc scripts/soak-news-first.js
cd ../integrations/ogid-mcp
npm run inventory:check
npm run check
npm test
```

Browser opcional: instalar Playwright en un entorno de pruebas y apuntar `OGID_PLAYWRIGHT_MODULE` a su módulo; `PLAYWRIGHT_BROWSERS_PATH` a Chromium. `OGID_BEFORE_UI` señala frontend extraído de la base, `OGID_UI_CDN` copias exactas de Bootstrap/Chart/Leaflet originales (con SRI); `backend/scripts/verify-news-first-ui.js` sirve fixture local y bloquea imágenes/vídeos/tiles externos. No hace stress sobre publishers.

Con las dependencias MCP instaladas, base **578/578**; resultado de esta rama: backend **592/592**, syntax check correcto; MCP **21/21**, inventory check correcto. Fixtures cubren Admin parcial/timeout/abort/auth/Retry-After, single-flight y teardown; lecturas almacenadas/cold-start sin upstream; catálogo 300/host fairness, deadlines cola/cuerpo, 304, 429, vacío, malformed/bytes/items, shutdown; persistencia atómica y recuperación/corrupción; identidad/aliases/fechas/orden antes de limit; baseline/filtros/mercados/reconnect; backpressure. Suite existente conserva agenda/research/archivo/OHLCV/IA y seguridad LAN/token/spoofing/origin.

Browser Chromium 156: sin errores JS ni overflow a 1920×1080, 1366×768, 390×844; imagen por fila con fallback ante error, DOM estable ante mercados, scroll/foco y fila retenidos al actualizar selección, drawer abierto tras edición, fallback real durante socket cortado y reconexión sin duplicados, reduced-motion y Admin parcial con RSS pendiente. [Resultados](ui-verification.json), [antes](screenshots/before-1366.png), [después escritorio](screenshots/after-1366.png), [1920](screenshots/after-1920.png), [móvil](screenshots/after-390.png), [Admin antes](screenshots/admin-before.png), [Admin después](screenshots/admin-after.png). No equivalen a validar CDN/HTTPS/proxy/red real del operador.

## Mediciones

Ver [comparación y desviaciones](MEASUREMENTS.md), [base](baseline.json), [rama](after.json), [persistencia antes](persistence-before.json), [después](persistence-after.json) y [prueba de estabilidad](soak.json).

## Operación LAN y despliegue autorizado por el operador

Esta rama no se desplegó. Antes de hacerlo, conservar `.env` y respaldar `backend/data/` con el proceso detenido o un snapshot coherente. Revisar commits/PR y dependencias; no fusionar PR #11 para probar esta rama.

Para LAN directa: backend debe escuchar la interfaz del servidor (`HOST=0.0.0.0`, `PORT=3000`, o IP LAN específica). Mantener `ALLOW_LAN_ADMIN=1` sólo en LAN de confianza y `ALLOW_LOCAL_ADMIN=1` si se usa localhost/túnel. Firewall debe permitir TCP 3000 desde la subred autorizada, no publicar Admin a Internet. No ampliar CORS ni confiar en X-Forwarded-For para autenticar. Reiniciar según el gestor existente, con shutdown ordenado.

Aplicar explícitamente mode canonical, intervalo 30000, deadline 25000, concurrencias 4/1, lote18 y timeout9000; empezar con lote menor si el host tiene pocos recursos. No tocar cuotas ni claves NewsAPI/GNews. Revisar cobertura/último éxito/backoff antes de calificar ingestión saludable.

Desde servidor y segundo equipo, registrar tiempos/status (sin tokens en URL):

```sh
ss -ltnp 'sport = :3000'
curl --max-time 5 -sS -o /dev/null -w 'status=%{http_code} connect=%{time_connect} first=%{time_starttransfer} total=%{time_total}\n' http://127.0.0.1:3000/api/health
curl --max-time 5 -sS -o /dev/null -w 'status=%{http_code} connect=%{time_connect} first=%{time_starttransfer} total=%{time_total}\n' http://192.168.1.50:3000/api/health
```

Repetir `/`, `/admin`, `/api/intel/snapshot?countries=ALL&order=critical&limit=40`, `/api/news/aggregate?stored=1`, `/api/admin/news-raw?dataset=rss-aggregate&stored=1`. DevTools Network/Console debe mostrar `/ws` 101, mismo host, ws en HTTP o wss en HTTPS, sin CSP/CDN/JS errors. Clasificar connection refused vs timeout, 401/403 auth, 404 ruta, 5xx servicio, headers recibidos/cuerpo detenido y upgrade rechazado. Revisar servicio y firewall sólo con acceso autorizado; no desactivar auth para diagnosticar.

Tailscale (100.64/10) no es LAN RFC1918 para esta política: usar acceso API con token por cabecera o túnel SSH autenticado para navegador (`ssh -L 3001:127.0.0.1:3000 usuario@servidor`, abrir `http://127.0.0.1:3001`). No incrustar `ADMIN_API_TOKEN` en JS/sessionStorage ni URL. No hay login/token de navegador nuevo en esta rama porque la topología indicada es LAN directa.

Para reverse proxy público, configurar `ALLOW_LOCAL_ADMIN=0` y `ALLOW_LAN_ADMIN=0`: un proxy loopback/LAN es de transporte y no debe conferir acceso anónimo. Usar gateway autenticado que inyecte token servidor **sólo a operadores autorizados** o túnel SSH de operador con política local correspondiente. El backend fuera de esas redes acepta token en Authorization Bearer o x-admin-token; proxy debe impedir acceso directo al puerto. Preservar Host y `Upgrade`/`Connection`, HTTP/1.1, y fijar `X-Forwarded-Proto` en el proxy al esquema real, sin reenviar valores del cliente. Verificar `/ws` con Origin idéntico a la página sobre la ruta real. No se ensayó esa topología aquí.

Rollback del operador: detener con SIGTERM y esperar flush, restaurar revisión/config previa (base de main) conservando respaldos JSON. Si sólo se revierte mode a legacy, conservar `rss-canonical-state.json` para volver a canonical; legacy no ofrece los presupuestos completos de body/cola de canonical y mantiene sus límites anteriores. No eliminar velas/research/agenda/IA. La UI y APIs pueden volver con código previo sin migración de esquema del archivo.

## Riesgos y futura conciliación SQLite

La escritura de archivos es asíncrona/atómica/coalescida, pero clasificación, ingestión de archivo, poda y JSON.stringify siguen consumiendo CPU síncrona. El fixture de 10k demuestra pausa de ingestión y serialización; no se promete p95 <500 ms bajo cualquier tamaño del archivo hasta 100k. No se reescribió toda persistencia sin pruebas ni se movió a SQLite. Errores de flush quedan registrados y el flush explícito rechaza; archivo corrupto no se reemplaza silenciosamente.

PR #11 tendrá que conciliar autoridad/cadencias/cancelación de RSS, identidad `identity` y aliases `originalIds`/IA, revisión semántica de selección y envelopes compatibles, fechas fuente/firstSeen, lectura stored/refresh explícito, salud acumulada, shutdown/flush y proyecciones archive/selection. Los nuevos tests no deben convertirse en test de una segunda ingesta. La retirada de UI no implica retirar sus APIs MCP. Preservar datos JSON y contratos de investigación al adaptar almacenamiento.
