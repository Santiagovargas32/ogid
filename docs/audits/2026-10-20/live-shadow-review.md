# Incidentes del arranque shadow del 20 de octubre

Corte del log: 2026-10-20 11:34:28.278 UTC (13:34:28 Europe/Madrid). Informe parcial de una ejecución que continúa; no acredita 24 horas ni estabilidad. Petición: conservar evidencia y contexto para preparar posteriormente mejoras. En esta revisión sólo se hicieron consultas GET y lecturas SQLite readonly/query_only; no se cambiaron código funcional, configuración, trabajos ni servicios.

## Fuentes, identidad y cronología

- Backend: `.agent-validation/shadow-backend-20261020-132317.log`, primeras 2.197 líneas leídas completas, 2.193 registros JSON; 670,076 s entre primera y última marca. El archivo sigue creciendo. Hash del prefijo leído y análisis redactado en [live-shadow-review.json](live-shadow-review.json). Algunos avisos SQL se escriben fuera de orden temporal; conservar línea y timestamp, sin deducir una pausa de proceso de esa diferencia.
- Observación vigente: `.agent-validation/shadow-24h-20261020-132328/samples.jsonl`, 11 muestras hasta 11:33:30.678 UTC, 601.959 ms observados; summary.state=observing y completedObservation=false. Se conservan todas esas muestras en el JSON de este corte.
- Observación anterior: `.agent-validation/shadow-24h-operacion-20261020/`, un único sample de arranque a las 11:20:38.406, interrumpida a las 11:21:08.315. PID 52294 distinto del vigente. No sumar sus duraciones como ejecución continua. No se ha localizado un log de backend de ese primer intento entre los nuevos logs fechados 20261020.
- HTTP escucha a las 11:23:18.202 (log:5); writer listo con SQLite 3.53.4 y 17 migraciones a las 11:23:19.784 (:6); server_started 11:23:46.588 (:19); broker, OpenCode y worker confirmados a las 11:23:47.193, 11:23:49.227 y 11:23:57.747 (:21, :22, :340).
- Identidad GET `/api/health`: PID 52470, Node v22.23.3; checkout al arrancar `5ac40d7cd126320443b9ce41ac0855f979f1db7b`, dirty=true; artifactHash `266cac9ebe0f17d5bddec6e35d2b7254a016610280e03fd4e4aba2ab0beb0070`. Es el árbol local modificado, no sólo el commit de referencia. La identidad es observación local de arranque, no atestación criptográfica del código en ejecución.
- Configuración leída sin secretos: legacy none/off; agente shadow y overrides `{}`; fondo `llamacpp/qwen3-coder`; catálogo y binario de ensayo indicados en runbook. Los hijos permanecen running en las consultas realizadas; worker conectado. No se generaron prompts de prueba ni se cargaron modelos.

## Hallazgos y causas

### LIVE-01 — Publicación rechazada por evidencia técnica stale (bloqueante para aceptación del agente)

Evidencia log:1030–1033: un solo intento `POST /api/agent/v1/internal/publish` devuelve 400 `AGENT_SYNTHETIC_EVIDENCE`, requestId `193cc551-4a6d-46e6-a978-111264969fe3`. Los registros storage_command_failed y request_failed describen el mismo incidente, no dos publicaciones.

Correlación SQLite readonly: job `fc974307-44e9-4bc8-ab8c-b8905259aefa`, tarea instrument_outlook, ámbito `yahoo-sxr8-de-1ub6wdt`, fence=1, attempts=1, snapshot `e98e647f-9b2b-4a47-99b2-2d8023dfa572`, sesión OpenCode `ses_ogid_fc974307-44e9-4bc8-ab8c-b8905259aefa`. Run 11:23:56.788–11:28:13.638, duración 256,850 s; firstProgressMs=114889. Terminó failed, no hubo publicación durable.

La lectura GET del turno ya fallido confirma 16 IDs citados. Dos technical.get tienen synthetic=false y stale=true: `analysis-f0ef50318147162bc471bedd9b0ed04e30fbcfe0` y `analysis-de73a59c61692d46181bbc979ac436de41acc1a4`. Las marcas de calidad y referencias están conservadas; se omitieron los textos del modelo y las fuentes. No se trata de evidencia sintética confirmada: `assertPublication` en `backend/services/agent/contracts.js:227` agrupa synthetic, stale y fallback bajo ese código. `AgentRepository.publish` vuelve a validar en backend usando la evidencia congelada (`backend/storage/agentRepository.js:1306`). El rechazo protege los datos; el problema pendiente es que el analista selecciona evidencia no publicable y el diagnóstico confunde las causas.

Para la futura mejora: reproducir con ese snapshot en copia consistente; comprobar frescura por intervalo, cómo se expone la calidad al analista y cómo expresa indisponibilidad sin citar datos prohibidos. Separar códigos y visibilidad del rechazo. No desactivar validaciones ni convertir stale en fuente vigente; no ampliar automáticamente el presupuesto de reparación.

### LIVE-02 — Contadores históricos y progreso del trabajo activo (observabilidad importante)

La muestra enviada por el usuario mezcla acumulados históricos con este arranque. Antes: failed=60, incomplete=59. Tras reconciliación del job antiguo `b3b94bc0-ee04-46ba-83cc-0fbcf7d71bcc`, incomplete pasa a 60 (run antiguo finalizado 11:23:56.333). Tras LIVE-01, failed pasa a 61. Los completed=5 anteriores **no equivalen a cinco publicaciones**: agent_publications.count=0 en la consulta realizada.

El siguiente run, job `23d6fb32-6f2e-4851-b4ac-c0aa93359c01`, global_intelligence_brief, fence=1, empezó 11:28:17.003; snapshot `f6edd53e-1d05-4a22-a931-a32632de7d98`. Las consultas GET a OpenCode de las 11:34:28 muestran herramientas agent.evidence completadas y mensajes del turno posteriores a las 11:30. Lease renovado en SQLite en las lecturas sucesivas. La cola de 21 pendientes y un running constante no demuestra por sí sola ausencia de progreso; tampoco demuestra capacidad de drenaje sostenida. Su desenlace queda fuera del corte.

Pendiente: mostrar separadamente acumulados, delta del arranque, fase/progreso/edad de cada run, primera señal útil y causa terminal. Evaluar edad real de los pendientes y coalescing sin modificar entradas congeladas. No marcar healthy por conexión ni por heartbeat solamente.

### LIVE-03 — RSS funciona, con fuentes degradadas y diagnóstico incoherente (importante)

El ciclo inicial no quedó indefinidamente abierto: newsapi :23→359 (raw=100, seleccionadas=48, 23.876 ms), gnews :360→366 (10/10, 2.659 ms), rss :367→1099 (raw=900, seleccionadas=554, 279.953 ms). news_cycle_completed :1286 termina a las 11:29:52.911, 366.313 ms, sourceMode=live, 1.181 candidatos y 94 artículos de salida. Es una duración alta; incluye adquisición/suplementos/proyección y no equivale al deadline de una petición RSS.

A las 11:32:28, GET pipeline-status muestra última ingesta 11:32:05.949, corpus SQLite revision=233941 y sourceMode=live. Se conserva cobertura: 66/66 fuentes configuradas disponibles; estado más reciente 48 ok y 18 error (18/66=27,27%, **estados de fuentes**, no tasa de fallos de peticiones). Entre errores: 403, timeout, network-error y circuit-open. U.S. Defense Releases procede de la captura del usuario; su incidencia concreta no se reconfirmó en el listado de errores de esta consulta. No eliminar fuentes para mejorar esos números.

Mecanismo de los ceros del panel: `businessAdapters.js:33` retorna `worker.rss`, que `BusinessRuntime.fetchRss` rellena con catalogSize/queriedFeedCount/stage/catalogStatus/collectedCount. Sin embargo, `admin.js:848` espera availability/coverage/metrics del contrato del pipeline canónico y convierte campos ausentes en unknown o cero. Es un desajuste de contrato confirmado en código y en GET rssIngestion, no prueba de cobertura real 0/0. No hay que confundir esta telemetría con otro scheduler ni arrancarlo para rellenar el panel.

Además, :1707 registra news_fallback_engaged/all-providers-failed tras un ciclo RSS vacío (:1706 aproximadamente, 21.552 ms). Hubo adquisición correcta en ciclos anteriores; no significa que todo el arranque careciese de noticias. Revisar semántica de empty/failure/freshness y conservar historial.

Hipótesis causal prioritaria para los circuit-open: `rssProvider.js:136` usa providerRuntime.fetch("rss", ...) sin circuitKey específico; `providerRuntime.js:47` usa por defecto provider como clave. En esta ruta todos los hosts comparten circuito RSS. La inspección estática confirma ese alcance y ofrece un mecanismo para propagar fallos entre dominios; todavía no se ha reproducido en aislamiento ni identificado el host que abrió cada circuito de este ensayo. Separar esa hipótesis de fallos HTTP concretos del proveedor. El estado de la rotación no expone cooldown/nextEligibleAt de forma consistente.

### LIVE-04 — Lecturas y escrituras lentas bajo carga real (importante)

Log :341–1279 y análisis agrupado: 16 slow_sql, de los cuales 14 en reader thread=2, readonly=true, y dos en writer thread=1. Lecturas de candles por rowid: ocho avisos; events con filtro EXISTS/event_instruments: cinco, máximo **23.029 ms** (:421); revisión histórica de artículos: uno. Writer INSERT pipeline_runs 1.861 ms (:348) y UPDATE pipeline_runs 2.244 ms (:1185).

Dos HTTP snapshot terminan 200 en 109.983,13 ms y 26.798,74 ms. El aislamiento del escritor no elimina competencia en el lector analysis entre cálculos deterministas, mantenimiento y snapshots. La latencia no demuestra por sí sola transacciones abiertas de 23 s ni atribuye la causa a disco/IA: faltan planes de consulta y métricas de IO/CPU bajo comparación controlada. No ensayar EXPLAIN ANALYZE ni cargas nuevas sobre la instancia observada.

En la captura runtime de las 11:32:28: ventana HTTP de 512 completadas, p50=2,07 ms, p95=1.972,01 ms, p99=4.040,40 ms. Son endpoints mezclados, no SLO ni comparación válida con el soak sintético anterior. Event loop p95=20,43 ms, máximo=169,35 ms, con la resolución del monitor vigente. Próximo análisis: planes e índices en copia, cachés/revisiones/coordinación y reparto de carga preservando corpus y ventanas analíticas.

### LIVE-05 — Memoria creciente, sin prueba aún de fuga (importante)

Observador vigente: RSS del proceso backend 573,71 MiB en arranque y 1.138,84 MiB a los 10 minutos, con fluctuaciones intermedias. Incluye workers del proceso; no es sólo heap HTTP ni suma la memoria de los hijos. No hay evidencia suficiente para llamarlo fuga ni para declararlo acotado. Registrar evolución, caches/snapshots/GC, memoria de hijos y WAL durante la observación larga. No recortar evidencia silenciosamente.

### LIVE-06 — Degradación SEC independiente del resultado del analista (importante)

GET research/sources a las 11:34:28: SEC_SOURCE_UNAVAILABLE; hay fuentes healthy y otras SOURCE_CONTRACT_OR_TRANSPORT_ERROR, con próximos intentos registrados. El código mezcla errores de transporte y contrato; no permite atribuirlos a 403/429, proxy o incompatibilidad del parser sin más evidencia. `secSourceAgent.js` transforma resultados parciales no healthy/cooldown en degraded; `officialSources.js` conserva estado y backoff.

La degradación observada es real, pero no demuestra una caída del almacenamiento ni un fallo de IA. Identificar fuente/adaptador y causa concreta en un ensayo posterior; mantener el acceso a datos persistidos y la política de contacto SEC. No registrar el contacto privado configurado.

### LIVE-07 — Estados HTTP, WS y señales de arranque requieren interpretación (observabilidad)

- 2.119 HTTP completadas en el corte; dos 5xx (2/2119=0,0944%): un 503 de admin/agent y otro de health/ready durante inicialización. Las diez muestras posteriores a la primera tienen esos probes en 200 y worker connected. El primer notShadowSamples=1 corresponde a mode=null con HTTP 503, **no confirma un cambio a visible**. El observador actual no diferencia desconocido de modo incorrecto.
- Tres GET access devuelven 401 AGENT_DEVICE_REQUIRED (3/3 intentos de esa ruta), coherentes con navegador sin dispositivo autorizado; no confundirlos con indisponibilidad de OpenCode.
- GET intel/sync: 1.014 completadas, 13 con 409; investigar si son resync esperados o invalidaciones excesivas. Su volumen domina los percentiles globales; no usar el p50 global para describir las rutas de agente.
- Tres conexiones WS y tres cierres 1005 en el prefijo leído. El logger los marca anomalous=false; en la captura de salud heartbeatTimeouts=0 y no hay reader recovery. Esto **no acredita que los cierres sean inocuos ni atribuibles a IA**: falta correlación con navegación, cliente y mensajes finales. No culpar al proxy ni introducir reconexión agresiva.
- Cero recuperaciones de analysis/queries en las 11 muestras; sólo informa de ese intervalo. El run RSS STORAGE_RESTART_INTERRUPTED mostrado por el usuario corresponde al trabajo iniciado el día 19 e interrumpido en el intento anterior del día 20; no es un nuevo fallo de adquisición confirmado de PID 52470.

## Contexto conservado para la siguiente mejora

Bloqueante para aceptación: publicación con evidencia elegible y resultado durable con carga real (LIVE-01), seguido de progreso/drainage y ausencia de degradación acumulativa. Importantes: contrato RSS y aislamiento de circuitos; cálculos/snapshots lentos y memoria; diagnóstico SEC. Observabilidad: deltas del arranque, error stale específico, modo desconocido durante boot, fases/edad de trabajos y correlación WS.

Antes de implementar, usar este corte y el final del ensayo para reproducir los mecanismos en una copia consistente, fijar criterios y añadir regresiones. Se conserva como pendiente la observación real de 24 horas; estos ~11 minutos no la sustituyen. No se ha modificado el ensayo para mejorar sus resultados ni se han publicado respuestas rechazadas.
