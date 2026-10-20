# Progress: Agentic Intelligence

## Estado de la integración

La implementación pendiente de integración está distribuida en:

- `backend/services/agent/`: broker, worker, runtime gestionado, selección de modelos, cliente OpenCode, configuración y modo shadow.
- `backend/storage/agentRepository.js` y `backend/storage/migrations/010_agent_intelligence.sql`–`017_news_projection_window.sql`: persistencia, trabajos, sesiones, ejecuciones, snapshots e índices.
- `backend/routes/agentRoutes.js`, `backend/server.js` y `backend/scripts/agent-*.js`: exposición HTTP, arranque/control de componentes y operaciones de comprobación.
- `backend/deploy/agent/research-tools.json`: manifiesto de herramientas de investigación.
- `frontend/js/agent*.js`, `frontend/css/agentIntelligence.css`, `frontend/index.html` y `frontend/admin.html`: panel de inteligencia, modelos y operaciones.
- `integrations/ogid-mcp/`: contratos, operaciones, herramientas y pruebas del adaptador MCP.

## Pendiente

- Completar la validación operativa del flujo completo broker → OpenCode → worker con los componentes habilitados en `backend/.env`.
- Ejecutar las comprobaciones preparadas en `backend/scripts/agent-preflight.js`, `agent-migration-check.js`, `agent-snapshot-check.js`, los smoke tests y la observación shadow.
- Verificar el catálogo y la selección de modelos contra la instancia OpenCode disponible.
- Confirmar la aplicación ordenada de las migraciones `010`–`017` y la persistencia de trabajos, ejecuciones y snapshots.
- Validar la integración de las rutas de agente, el panel administrativo y las operaciones MCP en el entorno objetivo.
- Revisar los resultados de las pruebas nuevas de agente y de las regresiones de backend antes de promover el modo shadow o visible.

## Alcance subido

Este archivo acompaña todos los archivos modificados y nuevos que ya estaban presentes en la rama `feat/agentic-intelligence`. El archivo local `backend/.env` no forma parte del alcance.

## Auditoría local — 2026-10-20

Se han implementado correcciones de deadlines y cancelación del broker, propagación de AbortSignal, heartbeats seriales, fencing al confirmar mutaciones, lecturas readonly y SSE, disponibilidad/diagnóstico de hijos, aislamiento MCP, mantenimiento y reparación única de chat sin consulta de evidencia.

Baseline original: 867 tests pasan. Suite posterior: 889 backend y 29 MCP; el último ajuste de frecuencia de diagnóstico pasa además 33 pruebas focalizadas. Smoke real gestionado con OpenCode 2.0.31 y qwen3-coder residente: publicación shadow durable oculta al público, chat citado, dispositivo/CSRF/SSE y cierre de procesos comprobados. Backup consistente de la base representativa y fixture 009→017 verificados.

El estado sigue siendo **shadow, sin declaración de estabilidad de producción**. El inventario distingue revisión funcional focalizada de módulos sólo inventariados. La prueba sostenida sintética no sustituye una observación real de 24 horas ni el ensayo de disco frío con IA e ingesta simultáneas.

Informe, logs comparados, cobertura, comandos, resultados y runbook: [docs/audits/2026-10-20/audit.md](docs/audits/2026-10-20/audit.md).

## Seguimiento del shadow real — 2026-10-20, corte 11:34 UTC

Memoria operativa para retomar mejoras: [incidentes y causas](docs/audits/2026-10-20/live-shadow-review.md), [evidencia redactada y métricas del corte](docs/audits/2026-10-20/live-shadow-review.json). Revisados íntegramente los prefijos disponibles de `shadow-backend-20261020-132317.log` y los dos observadores nuevos. El vigente es `shadow-24h-20261020-132328`, PID backend 52470; el anterior quedó interrumpido y no cuenta como continuidad. Checkout base 5ac40d7 con cambios locales; artifactHash de arranque 266cac9ebe0f17d5bddec6e35d2b7254a016610280e03fd4e4aba2ab0beb0070.

- **Nuevo fallo confirmado:** job fc974307-44e9-4bc8-ab8c-b8905259aefa, instrument_outlook, fence 1, snapshot e98e647f-9b2b-4a47-99b2-2d8023dfa572. Publicación rechazada por dos citas técnicas stale (synthetic=false); código genérico AGENT_SYNTHETIC_EVIDENCE. No desactivar la validación. failed pasó de 60 a 61; no confundir dos registros del mismo rechazo con dos incidentes.
- El run antiguo se reconcilió como incomplete (59→60). El siguiente global_intelligence_brief sigue activo con lease renovado y 12 consultas de evidencia completadas observadas en OpenCode; contadores constantes no prueban bloqueo. Cero publicaciones en la base consultada; completed=5 es histórico y no demuestra publicaciones nuevas.
- **Adquisición con progreso:** RSS inicial raw=900/seleccionadas=554, 279.953 ms; ciclo news completo 366.313 ms, luego ingestas nuevas y corpus live. Fuentes del catálogo en la consulta: 48 ok/18 error sobre 66, sin eliminar cobertura. También hubo un ciclo vacío con fallback.
- **Desajuste de telemetría confirmado:** el panel espera coverage/metrics/availability y el writer reporta stage/catalogStatus/collectedCount; muestra 0/0 y unknown aunque adquiere. Revisar contrato sin arrancar otro scheduler. Circuito RSS compartido entre hosts confirmado por código; su relación con cada circuit-open aún requiere reproducción.
- **Rendimiento pendiente:** 16 slow_sql (14 reader, 2 writer), lectura events hasta 23.029 ms; snapshots 109.983 y 26.799 ms. Memoria backend 573,71→1.138,84 MiB en ~10 min, insuficiente para concluir fuga o acotación. Preservar corpus y ventanas al investigar.
- SEC degradado con fuentes healthy y SOURCE_CONTRACT_OR_TRANSPORT_ERROR; falta distinguir transporte/contrato. Tres cierres WS 1005, sin heartbeat timeouts confirmados; causalidad pendiente. Los 503 iniciales y mode=null son arranque, no prueba de modo visible.

En esta pasada sólo se consultaron instancias mediante GET y SQLite readonly/query_only y se escribió documentación: sin reinicios, cancelaciones, prompts nuevos ni cambios de configuración/datos. Ensayo vigente continúa; 11 muestras/~10 min no validan 24 h. Mantener shadow. Usar estas incidencias y el final del ensayo como insumo del próximo plan; no dar por implementadas sus mejoras.

## Mejoras implementadas y prueba real — 2026-10-20, cierre 13:08 UTC

Se implementaron las mejoras del corte LIVE: panel heredado sustituido por procesos/jobs/publicaciones del agente; progreso durable acotado y contadores por arranque; calidad stale/fallback explícita en evidencia congelada, prompt v1.5 y reparación única; circuitos RSS por host y telemetría real; consulta events con índice cubriente y vista transaccional consistente; diagnósticos SEC; estados diferidos durante configuración y cierre inmediato de admisión. Se corrigió la clasificación permanente de INVALIDATION_REQUIRED/INTRADAY_DATA_REQUIRED, comprobada también en un trabajo real posterior. No se eliminan fuentes ni históricos, no se añade escritor, ni se cambian migraciones 001–017.

`.env` local y artefactos operativos preparados bajo backend/data/agent-runtime, OpenCode 2.0.31 con hash pin y llama.cpp qwen3-coder residente sin cambios de modelo. Legacy none/off; todas las tareas shadow. El usuario autorizó expresamente el arranque temporal y cierre sobre `/srv/bitcoin/ogid/db/ogid.sqlite`; se ejecutó con npm start en el proyecto real. Backend PID 87148 cerrado con cleanupErrors=0; sus hijos desaparecieron, llama.cpp se conservó.

Validación: 898/898 backend, 29/29 MCP, 81 rutas/90 operaciones, check/build correctos, audit prod sin vulnerabilidades. Smoke con inferencia real, panel real en Chromium y fixture completo del dashboard pasan. Observador de 30 minutos completado con reinicio deliberado del worker y corrección tardía: **no demuestra 30 minutos ininterrumpidos del mismo artefacto ni 24 horas**. Repetición HTTP correcta: 81/81 respuestas 200; diez WS sin cierres inesperados durante 301,504 s. La sonda inicial errónea generó 110 respuestas 404 en una ruta inexistente, conservadas y excluidas como fallo funcional del backend.

Publicaciones de este arranque: 2→5, todas shadow, cero duplicadas por job y cero ligadas a snapshots parciales en el corte. Adquisición/cálculos avanzan: artículos 107318→108000, revisiones 223787→224873, eventos 111318→112124, velas 34415→34482, analysis_runs 11735→12988 (conteos sucesivos, no snapshot atómico). Persisten rechazos de calidad, 21 trabajos pendientes y fuentes degradadas; no declarar promoción ni cola drenada. Memoria/disco frío y calidad semántica requieren seguimiento.

Detalles y pendientes: [improvements.md](docs/audits/2026-10-20/improvements.md), comandos/resultados en [validation.md](docs/audits/2026-10-20/validation.md), arranque y vigilancia de 24 h en [runbook.md](docs/audits/2026-10-20/runbook.md). Informes anteriores son cortes históricos, no estado vigente. La base de validación del disco de datos se mantiene separada y nunca sustituye automáticamente la original.

Nueva copia del disco de datos conservada, pero su integrity_check/FK quedó **sin completar** y ambos verificadores propios se cerraron; no usar como rollback certificado. Esquema/checksums revisados, sin migración nueva. Resultados estructurados y límites en [improvements-results.json](docs/audits/2026-10-20/improvements-results.json).

## Incidente posterior — ejecución 15:22–15:31 CEST, 20/10/2026

Revisión solicitada sólo para diagnóstico: [last-run-review.md](docs/audits/2026-10-20/last-run-review.md) y [resumen estructurado](docs/audits/2026-10-20/last-run-review.json). No se ha modificado código/.env/base ni arrancado o reiniciado servicios. Leídas 1627 líneas del log shadow-backend-20261020-152234.log y diez muestras del observador, que quedó interrupted (~9 min), sin validar 24 h.

**Nuevo bloqueante confirmado:** domain.registry writer supera 30 s ejecutando; reconstruye event_instruments desde todo events en una transacción immediate al cambiar fingerprint. DELETE observado :1584; storage_worker_failed :1606, cierre automático :1607; STORAGE_NOT_READY de shutdown_failed :1627 es derivado, cleanupErrors=2. Ruta posterior al arranque: updateWatchlist, sin entrada PUT completada para atribuir acción exacta del navegador. No ocultar aumentando deadlines ni ignorando el fallo del writer.

Awareness: total compacto y listas tienen hidratación separada; fixture con función real reproduce compacto8970/945 sin tarjetas y rechazo de completo8969; completo8970 sí hidrata. Falta captura del navegador para atribuir la carrera exacta. OHLCV timeout es deadline frontend12 s; sólo dos GET terminados 200 (169/255 ms), no prueba de que todos los intentos fueran sanos, pues el logger usa finish. SEC: cuatro submissions SOURCE_TRANSPORT_ERROR/20 fuentes; otras16 healthy.

Cambio del operador a GPT ocurre después del cierre: llama.cpp iniciado15:38, GPT resident131072/un slot y load-on-startup=true. .env ahoraGPT, pero manifest sóloQwen y controlSQLite conservaQwen; cuatro runs del ensayo fueronQwen, tresfailed/últimorunning persistido, cinco publicaciones shadow sin nuevas. No declarar GPT integrado hasta validarlo y alinear selección durable/catálogo. A la inspección no había backend OGID activo. Mantener shadow; bloqueada aceptación prolongada hasta corregir y validar estos puntos.

## Continuación: modelos y registro durable — 2026-10-20

Se continuó sobre el commit del operador **55cd35f9f4ec32a8f5c61d28fd2a99fe16dc116a**, sin retroceder la rama ni publicar. La migración nueva 018 mantiene el índice anterior y reconstruye una generación por páginas con presupuesto orientativo de 250 ms, cursor transaccional/reanudable y doble escritura de revisiones; no hay otro escritor ni borrado de históricos. Inicio aplaza rebuild hasta hidratar y cierre detiene su admisión. El lector queries reserva admisión para lecturas cortas mientras cede un cálculo, con un solo trabajo CPU. Deadlines por operación y HTTP interno/frontend alineados; no ampliación global de TTL o retención. Awareness recupera las primeras tarjetas sin confundir revisión de metadatos con revisión hidratada.

Catálogo de los nueve modelos de llama.cpp vía OpenCode 2.0.31, todos seleccionables; activación/carga asíncrona serial, estado residente/verificado separado y selección durable sólo tras validación. Siete contratos reales pasaron. Mistral Small falló al reservar KV CUDA y Qwen q4 fue terminado por OOM; no se recortó contexto/salida para aprobar y siguen no verificados. GPT OSS 20B validado y seleccionado tanto en .env/catálogo como control durable; 22 pendientes reencolados, runs congelados intactos. Smoke completo real GPT pasó; no acredita todas las tareas con todos los modelos.

Última suite: **910/910 backend**, **29/29 MCP**, check/build e inventario correctos y cero vulnerabilidades de producción. Panel real Chromium: 9/9 opciones habilitadas, GPT seleccionado, sin UI/consultas heredadas ni XSS. Sonda repetida: 17/17 HTTP 200, diez WS sin cierres inesperados en 31,242 s. El primer timeout de administración se conserva como fallo previo a la corrección del lector.

Arranque normal sobre `/srv/bitcoin/ogid/db/ogid.sqlite` esquema 018, con todos los componentes on: 6 min 57,693 s; observador de seis minutos con siete muestras, arranque degradado inicial, cero recuperaciones. Adquisición real y rebuild progresan; fuente principal aún building al cierre, sin publicación nueva durante este corte. Un run Qwen anterior falló por interrupción remota; GPT estaba en curso. Memoria hasta ~1,11 GiB y heartbeat muestreado 22,194 s requieren seguimiento. Mantener **shadow**, no certificar 24 h.

El backend temporal propio cerró 17:35:29 UTC con cleanupErrors=0 y sin hijos; puertos propios cerrados. Llama.cpp conservado con GPT residente. Copia consistente previa 017 en `/srv/bitcoin/ogid/validation/20261020-model-registry/before-018.sqlite`: quick_check=ok y FK vacío; integrity_check completo no ejecutado. La copia candidate-018 se usa para completar/verificar reanudación del histórico sin modificar la base principal. Resultados de ese ensayo y cierre en [model-registry.md](docs/audits/2026-10-20/model-registry.md). Operación actualizada en [runbook.md](docs/audits/2026-10-20/runbook.md). Los bloqueantes/configuración descritos en la nota de diagnóstico anterior son históricos; las limitaciones reales de recursos/modelos y vigilancia permanecen.

Ensayo histórico aislado completado: 112.291/112.291 eventos recorridos, misma generación reanudada desde cursor 24.080; 88.211 adicionales en la última pasada. 1.383 páginas p95 425 ms/máximo 975 ms, comandos concurrentes, cero fallos muestreados, FK de event_index_links vacío y cierre closed. Duración última pasada 6 min 43,546 s, con interrupciones anteriores conservadas; **no es soak continuo de 30 min**. Base principal queda sin ownership; turno GPT incomplete con interrupción remota reconocida; cero duplicados por job y cero publicaciones de snapshots parciales en el corte de cinco publicaciones históricas. Resumen final: [model-registry-results.json](docs/audits/2026-10-20/model-registry-results.json).
