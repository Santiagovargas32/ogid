# Validación y evidencias operativas

Fecha: 2026-10-20. Tiempos de artefactos en UTC; horario del usuario Europe/Madrid (UTC+2). HEAD original y remoto `5ac40d7cd126320443b9ce41ac0855f979f1db7b`; working tree con correcciones locales. `results.json` contiene identidad del artefacto y resúmenes redactados. Artefactos completos privados: `.agent-validation/audit-20261020/` y carpetas temporales indicadas por los scripts.

## Entorno y baseline

- Fedora/Linux x64, kernel 7.2.8-200.fc44.x86_64; Ryzen 5 4500, 12 CPU lógicas, 16.640.933.888 bytes RAM. La medición inicial tenía poco margen de memoria y swap ocupado; no se infiere capacidad de producción a partir de este hardware compartido.
- Node `v22.23.3`, npm `10.9.9`, better-sqlite3 `13.0.3`, SQLite `3.53.4`. CI configura Node 24: esta ejecución valida Node 22, **no reproduce esa versión exacta de CI**.
- llama.cpp `0.3.0-dev`, build 10741, commit `9d817213a`. El inventario autenticado descubre qwen3-coder cargado, contexto 65.536, un slot y n_predict=-1. No hubo carga, descarga ni cambio de modelo.
- OpenCode personal `2.0.32`; binario de pruebas `@opencode/cli-linux-x64@2.0.31`, SHA-256 coincidente con el fijado en managedRuntime. Se descarga/extrae bajo `.agent-validation`, sin actualizar dependencias del proyecto ni reemplazar OpenCode personal.
- La baseline original se ejecutó desde `git archive HEAD` en `/tmp/ogid-baseline-20261020`: **867/867**, 80,839 s. Una copia anterior bajo `.agent-validation` dio dos 404 de HTML porque Express ignora directorios con punto; no se atribuyen a defectos funcionales. La captura previa sin resumen no se usa como baseline completa.
- Las primeras ejecuciones sandbox fallaron por `listen EPERM`, spawnSync EPERM o DNS EAI_AGAIN. Se repitieron las comprobaciones necesarias con permisos. Estos fallos se separan de los resultados funcionales.

## Comprobaciones ejecutadas

Comandos desde `backend`, salvo indicación. Los ficheros `.log` privados preservan salida completa; los resúmenes no incluyen cuerpos ni secretos.

| Comando | Resultado |
|---|---|
| `npm ci` | 137 paquetes, 6 s; lockfiles sin cambios. |
| `npm ci` desde integrations/ogid-mcp | 14 paquetes, 1 s. |
| `npm run check` | Pasa. |
| `npm --prefix ../integrations/ogid-mcp run check` | Pasa. |
| `npm --prefix ../integrations/ogid-mcp run inventory:check` | 81 rutas, 90 operaciones válidas. |
| `npm test` | **889/889**, 85,506 s, después de la reparación de chat. `final-all-tests.log`. |
| `npm --prefix ../integrations/ogid-mcp test` | **29/29**, 3,182 s. `final-mcp-tests.log`. |
| `npm run build` | Pasa; este proyecto define build como source check. |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilidades de producción reportadas. Un primer intento falló por DNS; el resultado válido es `audit-backend.log`. |
| `node --require ./tests/testSetup.cjs --test tests/agentReliability.test.js tests/agentIntelligence.test.js tests/agentManagedRuntime.test.js tests/agentShadowOperations.test.js` | 84/84 en esa revisión intermedia, 11,868 s. Tras la última reparación: agentIntelligence + agentReliability 63/63, 11,355 s. La suite completa posterior incluye todos los cambios. |

Las regresiones copiadas sobre el código original produjeron 15 fallos entre 57 pruebas en la comparación intermedia (`all-regressions-before.log`). Además, la regresión MCP falla antes con `Missing expected rejection`, la de snapshot CLI reclama el job incorrecto antes del cambio y la de chat sin tool no efectúa reparación. Esas comparaciones y los casos negativos comprueban que no se aprobaron pruebas vacías ni validadores desactivados. Después de la suite completa, se acotó también a un aviso por 30 s la ráfaga de códigos diagnósticos de cada hijo: 33/33 tests de runtime/fiabilidad pasan con ese último ajuste (`runtime-diagnostic-final.log`); no se repitió toda la suite por este cambio localizado.

## Preflight, copia, migración y snapshot

```bash
# Desde backend; XDG se aisló bajo /tmp en el preflight ejecutado.
node scripts/agent-preflight.js --output=../.agent-validation/audit-20261020/preflight.json
node scripts/agent-migration-check.js /srv/bitcoin/ogid/db/ogid.sqlite ../.agent-validation/audit-20261020/candidate.sqlite ../.agent-validation/audit-20261020/migration-copy.json
node scripts/agent-snapshot-check.js ../.agent-validation/audit-20261020/candidate.sqlite ../.agent-validation/audit-20261020/snapshot-copy-retry.json --as-of=2026-10-19T12:30:00.000Z
```

El preflight mantiene `ready:false`: no sustituye al smoke y la configuración original no está lista para el runtime gestionado. La base fuente se abre readonly; backup SQLite incluye WAL. Tamaño fuente observado 4.265.996.288 bytes y WAL 13.521.872 bytes. Antes/después: artículos 105.772; revisiones 221.740; eventos 109.599; velas 33.884; análisis 10.728. Integridad `ok`, cero fallos de FK. No se copia el archivo activo aislado.

Snapshot de la copia con backlog: 18 instrumentos, 1.667 evidencias; 416,268 ms; primera página 18 elementos, 24.314 bytes, hasMore=true. Sellado y SHA-256 iguales al reabrir. Corte simulado, caché de disco previamente calentada por integridad; no prueba latencia fría ni un snapshot de 100.000 noticias. La primera ejecución del comprobador falló con backlog; se conserva `snapshot-copy.json` y su reproducción motiva la corrección.

También se construyó una fixture 009 con artículo/revisión comprometidos en WAL y conexión escritora aún abierta, se ejecutó el backup/migración 009→017 y se reabrió la copia dos veces conservando la revisión (`migration-009-017.json`). Es una fixture sintética, separada de la copia real que ya estaba en 017. No se afirma haber recibido una base real antigua en 009.

## Modelo real y runtime gestionado

Se inspeccionaron antes de usarlos preflight, migration-check, snapshot-check, terminal-smoke, real-smoke, browser, shadow-observe y soak-runtime-stability: argumentos, escrituras, puertos y requisitos. No se arrancaron servicios existentes.

Preparación exacta del binario usada desde backend:

```bash
npm pack @opencode/cli-linux-x64@2.0.31 --pack-destination ../.agent-validation/audit-20261020
```

Se extrajo el tarball bajo `audit-20261020/opencode`; antes de ejecutar se verificó el hash fijado. Se creó `terminal-models.json` privado exclusivamente para la prueba, con el residente inventariado y las probes reales de streaming/cancelación/background. No se instala como catálogo de producción.

```bash
# Desde backend. Cada script crea base, workspace y puertos aislados.
OGID_OPENCODE_BINARY=../.agent-validation/audit-20261020/opencode/package/bin/opencode OGID_AGENT_SMOKE_OUTPUT=/home/fedora/ogid/.agent-validation/audit-20261020/real-smoke.json node scripts/agent-real-smoke.js --resident-model
AGENT_BACKGROUND_MODEL=llamacpp/qwen3-coder AGENT_MODEL_MANIFEST=/home/fedora/ogid/.agent-validation/audit-20261020/terminal-models.json AGENT_OPENCODE_BINARY=/home/fedora/ogid/.agent-validation/audit-20261020/opencode/package/bin/opencode node scripts/agent-terminal-smoke.js --resident-model
```

Antes: background real durable, chat bloqueado por no consultar herramientas; una primera ejecución gestionada con alias heredado distinto se degradó con AGENT_MODEL_UNVERIFIED. Tras corregir la reparación de chat, el smoke gestionado **pasa** entre 10:38:50.385Z y 10:39:29.673Z (39,288 s): OpenCode/MCP autenticados, tres hijos listos, publicación shadow durable y oculta al público, dispositivo/CSRF, SSE, chat completado con dos mensajes y citas válidas, cancelación autorizada y cierre. SSE transportó 815 bytes; no es una medida de throughput general.

Prueba final: `.agent-validation/terminal-real-5kA24Q/result.json`. Señal 0 sobre PID y grupos propios confirma que broker, OpenCode y worker han desaparecido (`process-cleanup.json`). La cancelación real por HTTP puede ocurrir en cola; las confirmaciones remotas y fencing entre propietarios se prueban además con regresiones, no con una batería de fallos reales de GPU.

## Matriz mínima: alcance demostrado

| Caso | Evidencia actual | Pendiente real |
|---|---|---|
| A. Off sin navegador | Tests de inicio SQL con adquisición programada, ingestión y persistencia sin clientes; soak sin navegador y con diez clientes WS sintéticos. | Continuidad de proveedores reales durante un día. |
| B. Shadow real | Smoke gestionado completo con publicación y chat durables. | Volumen, calidad y duración de producción. |
| C. IA caída/lenta | Configuración inválida aislada; broker con upstream sin cabeceras, stream detenido, total infinito y desconexión. | Fallo real de llama.cpp/OpenCode durante carga sostenida. |
| D. Lectores | Tests de recuperación/readonly, writer conservado y pausa de claim si queries falla. | Corpus frío concurrente con ambas recuperaciones reales. |
| E. Reinicio por fase | Tests de snapshots parciales, reinicio de almacenamiento y leases. | Caídas de proceso reales durante cada fase. |
| F. Cancelación | Regresiones queued/running, ticket remoto y siguiente turno; smoke HTTP. | Serie repetida de cancelación en inferencia real con clientes lentos. |
| G. Respuesta perdida | IDs estables, turnos paginados, replay de publicación y restricciones de retry en tests. | Fault injection de red entre procesos reales. |
| H. Dos workers | Repository/tests de contención, fencing y renovación serial. | Dos workers reales sobre inferencia local durante una caída. |
| I. Corpus/disco | Copia de 4,26 GB y snapshot representativo; catálogo completo en soak. | Disco frío + mismo corpus + ingesta/cálculos/IA concurrentes. |
| J. WS/SSE | Diez WS en soak; cuatro SSE revocados sin timers posteriores; aborto/backpressure broker. | Navegador/cliente TCP muy lento durante horas. |
| K. Seguridad | Tests CSRF, dispositivos, revocación, rutas internas, MCP y texto no confiable. | Navegador real y topología LAN/proxy: Playwright no está instalado. |
| L. Migración | Backup consistente real 017 y fixture 009→017 con WAL abierto/reapertura. | Base real antigua de otra revisión, si difiere de la fixture. |

## Ensayo sostenido y umbrales previos

Se conserva el primer ensayo con guard anterior (`soak-30m.log`), pero **se excluye de aceptación de adquisición sana**: sólo sustituía 18 feeds primarios y bloqueaba búsquedas generadas. El harness corregido no reduce el catálogo: 66 RSS + 435 búsquedas, todos redirigidos a fixtures por el preload de workers; API/red externa deshabilitada, sin noticias reales.

```bash
OGID_SOAK_SQL=1 OGID_SOAK_DURATION_MS=30000 NODE_OPTIONS=--require=/home/fedora/ogid/backend/scripts/soak-network-guard.cjs node scripts/soak-runtime-stability.js
OGID_SOAK_SQL=1 NODE_OPTIONS=--require=/home/fedora/ogid/backend/scripts/soak-network-guard.cjs node scripts/soak-runtime-stability.js
```

La primera orden midió la baseline del harness corregido: 30 s, 100 peticiones, HTTP p50 36,347 ms/p95 62,902 ms/p99 100,850 ms; lag p95 11,166 ms; cero cierres WS. **Antes del ensayo de 30 minutos** se fijaron: HTTP p95 <188,71 ms y p99 <302,56 ms; lag p95 <33,50 ms; cero errores RSS, recuperaciones de almacenamiento y cierres WS inesperados. Son 3× baseline en este equipo, no SLO universales. Memoria/WAL se registran descriptivamente; no se inventa después un gate de aceptación para esas métricas.

El resultado final del ensayo corregido se incorpora abajo y en results.json. No equivale a shadow real durante 30 minutos ni a una observación de 24 horas. El harness impulsa ciclos deterministas desde el proceso de prueba; no reproduce por sí solo todos los timers de producción.

## Resultado del ensayo corregido de 30 minutos

Duración medida: 30.057 min; 397 ciclos y 3970 peticiones HTTP. HTTP p50/p95/p99: 27.783 / 88.918 / 262.643 ms. Lag p95/p99: 10.740 / 11.575 ms. Cierres WS inesperados: 0; errores RSS muestreados: 0; recuperaciones de lectores: 0.

Gates declarados antes: **pasan todos los medidos**. Detalle: `{"httpP95Ms":true,"httpP99Ms":true,"eventLoopP95Ms":true,"unexpectedWebsocketCloses":true,"rssErrors":true,"storageRecoveries":true}`. Memoria RSS muestreada inicial/final/máxima: 375.5 / 808.9 / 818.6 MiB. WAL máximo muestreado: 7.33 MiB. La carga inicial de corpus y cachés explica parte de la subida; no se acredita ausencia de fuga nativa ni estabilidad de un día.

Resultado bruto privado: `/tmp/ogid-runtime-soak-GRYpPA/result.json`; salida `full-catalog-soak-30m.log`. El ensayo anterior con red mal aislada se conserva separado y no se usa para aprobar RSS. Las latencias del soak son agregadas de health/snapshot; results.json incluye además latencia por endpoint con denominadores del smoke real corto.

## Implementación y validación posterior sobre el entorno real

Este apartado actualiza el corte anterior; no convierte sus pruebas pendientes en aprobadas. Rama feat/agentic-intelligence, HEAD 5ac40d7cd126320443b9ce41ac0855f979f1db7b más cambios locales sin publicar. Node 22.23.3, SQLite 3.53.4, better-sqlite3 13.0.3, OpenCode gestionado 2.0.31, llama.cpp build 10741 (9d817213a), qwen3-coder residente/65536/un slot. Sin cambio de modelo. Código en `/home/fedora/ogid`; base real `/srv/bitcoin/ogid/db/ogid.sqlite`, esquema 17 sin migraciones nuevas.

Comandos ejecutados desde backend, con salidas conservadas bajo ../.agent-validation:

```bash
npm test
node --require ./tests/testSetup.cjs --test tests/agentOperations.test.js
npm run check
npm run build
npm audit --omit=dev --audit-level=high
node scripts/agent-terminal-smoke.js --resident-model
node scripts/agent-read-benchmark.js /srv/bitcoin/ogid/validation/20261020-agent-improvements/candidate.sqlite ../.agent-validation/improvement-read-benchmark-20261020.json
```

Backend final: **898/898**, 85,606 s (`improvement-backend-final5-20261020.log`), operaciones 8/8 (`operations-final-20261020.log`); check/build repetidos después del último cambio correctos; audit prod cero vulnerabilidades. El smoke usa la configuración local operativa, pero una base separada del proyecto: `terminal-real-a6qtsS/result.json`, passed. No confundirlo con adquisición sobre la base principal.

Desde integrations/ogid-mcp: `npm run check`, `npm run inventory:check`, `npm test`: **29/29**, inventario 81 rutas/90 operaciones. npm ci y los checks CI de base ya fueron ejecutados en la auditoría anterior; no cambian dependencias ni lockfiles en esta mejora.

Navegador: Playwright 1.56.1 y Chromium 141 instalados como herramientas de ensayo. `OGID_PLAYWRIGHT_MODULE=/home/fedora/.npm/_npx/d537ee5ee2a13f03/node_modules/playwright/index.mjs node scripts/agent-admin-browser.js http://127.0.0.1:3000 ../.agent-validation/improvement-browser-validated-20261020`: passed sobre el backend real; sin pageerrors, consultas heredadas o ejecución de texto malicioso. El dashboard completo también pasa (`agent-browser.js`, fixture propio para modelos, tres viewports; `improvement-browser-dashboard-final-20261020.log`). Esto actualiza la limitación previa de navegador no instalado; LAN/proxy siguen sin certificación.

Arranque principal autorizado expresamente: `cd /home/fedora/ogid/backend && npm start`, sin overrides de DB o adquisición. `improvement-validated-runtime-20261020.log`: primer registro 12:28:45, server_started 12:30:14, cierre 13:08:33 UTC (2387,593 s entre registros). Muestreo `node scripts/agent-shadow-observe.js ../.agent-validation/improvement-validated-observe-30m-20261020 0.5`: completed, 31 muestras. Criterios fijados antes en `improvement-final-acceptance-20261020.json`; no se cambian tras el ensayo. Corrección tardía del worker y reinicio deliberado 12:58: el requisito de artefacto idéntico durante 30 minutos **no queda acreditado**. Recuperaciones analysis/queries=0; sin SQLITE_BUSY ni timeout de persistencia en el log final. No es un ensayo de 24 h.

Repetición HTTP/WS: `node scripts/agent-live-probe.js http://127.0.0.1:3000 ../.agent-validation/improvement-live-http-ws-corrected-20261020.json 300`. Duración 301,504 s; 27 muestras por endpoint; 81/81 respuestas 200; 10 WS, 0 cierres inesperados/errores, incluye reinicio del worker y pausa TCP de 5 s. p50/p95/p99 y límites en improvements.md. La primera sonda consultó erróneamente /api/news: **110 respuestas 404** en el log del backend. Se conserva su resultado interrupted y no se acredita como prueba funcional aprobada. El log completo también conserva los 503 de inicialización: admin 2/173 y readiness 2/169; todos antes de server_started. La repetición no elimina esos datos.

Corte readonly antes de cerrar: cinco publicaciones, todas shadow, sin duplicados por job ni referencias a snapshots sin sellar. Conteos después del cierre: artículos 108000; revisiones 224873; eventos 112124; velas 34482; analysis_runs 12988. Frente a baseline 107318/223787/111318/34415/11735 avanzan todas las categorías; son consultas sucesivas, no una fotografía transaccional única. Al cierre quedan queued=21, incomplete=62, failed=71 y completed=10 acumulados: **no se afirma drenaje completo ni éxito de todas las propuestas**. SIGTERM al PID propio 87148, server_stopped cleanupErrors=0; desaparecen todos sus hijos y quedan únicamente los llama-server originales en 8080.

La copia consistente de esta pasada se creó con `node scripts/agent-migration-check.js /srv/bitcoin/ogid/db/ogid.sqlite /srv/bitcoin/ogid/validation/20261020-agent-improvements/candidate.sqlite ../.agent-validation/improvement-migration-20261020.json`. La fase inicial de copia terminó y se abrió en un runtime separado; el CLI se interrumpió en verificación tras más de una hora y **no hay reporte aprobado de ese comando**. Reanudación readonly de la copia: `ionice -c3 node scripts/agent-verify-copy.js /srv/bitcoin/ogid/validation/20261020-agent-improvements/candidate.sqlite ../.agent-validation/improvement-copy-verification-final-20261020.json 256`. Resultado final consignado a continuación; nunca interpretar que la existencia de la copia prueba integridad. La auditoría anterior sí conserva una copia verificada y migración fixture 009→017; no sustituye el resultado nuevo.

Informe de mejoras: [improvements.md](improvements.md); lectura integral redactada del log final: [improvements-log-analysis.json](improvements-log-analysis.json). Conservar shadow; falta vigilancia prolongada, disco frío controlado, memoria, revisión semántica y fallos externos de proveedores.

Resultado definitivo de la nueva copia: **integridad/FK no completados**. El verificador readonly de 256 MiB se cerró con SIGINT (salida 130) tras leer 1.003.409.408 bytes del disco; la fase había llegado a integrity-check después de comprobar esquema/checksums. Su log no contiene un resultado passed y no se crea uno artificial. Evidencia privada: `improvement-copy-verification-interrupted-20261020.json`. La copia y la original se conservan. Puede repetirse el comando readonly con un nombre nuevo de reporte en una ventana sin carga; no usar esta copia como rollback certificado hasta completar integridad/FK y compatibilidad. No quedan verificadores huérfanos.

Comprobación final 13:13:23 UTC: cero PIDs propios presentes; puertos 3000/8096/8097 y 43000/43096/43097 cerrados; llama.cpp original PIDs 1638/1896 presentes, 8080 abierto. Resumen redactado y denominadores: [improvements-results.json](improvements-results.json). No quedan ensayos iniciados por esta revisión esperando que el operador los cierre.


## Continuación sobre 55cd35f: modelos y reconstrucción del registro

Resultados/entorno/comandos completos y fallos intermedios conservados en [model-registry.md](model-registry.md). No sustituir su ensayo corto por el soak anterior de otro artefacto. Base principal 018; se preservaron 001–017, fuentes y datos. OpenCode 2.0.31 fijado, Node 22.23.3, SQLite 3.53.4; llama build 10741 (9d817213a).

- `npm test`: **910/910**, cero skips, 85.105 ms; `model-registry-backend-final4-20261020.log`.
- `npm run build` (incluye check): correcto; `model-registry-build-final-20261020.log`.
- `npm audit --omit=dev --audit-level=high`: **0 vulnerabilidades**; `model-registry-audit-final-20261020.log`.
- MCP `npm run check`, `npm run inventory:check` (81 rutas/90 operaciones), `npm test`: **29/29**, 4.971 ms; `model-registry-mcp-host-20261020.log`. Dependencias/lockfiles conservados; npm ci de baseline consta arriba.
- `node scripts/agent-terminal-smoke.js --resident-model`: inferencia GPT/OpenCode real, brief/publicación shadow, chat/SSE/citas/CSRF y cancelación, cierre limpio; `terminal-real-R62eao/result.json`. Corpus aislado y puertos efímeros, no base principal. Intento anterior sólo falló prerrequisito de residente, registrado por separado.
- Router: all-model + segunda pasada de pendientes tras OOM: **7/9 contratos pasaron**, Mistral y Qwen q4 fallaron recursos. No declarar todos los modelos funcionales por aparecer en lista. Catálogo visible mediante OpenCode: nueve habilitados, GPT seleccionado, confirmado en navegador real.
- Backend normal `npm start` sobre base real: 17:28:31.848–17:35:29.541 UTC, all switches on; observador 0,1 h, siete muestras; inicio 503/worker no conectado explícitos, luego progreso con cero recuperaciones. No publicación nueva en ese corte, turno GPT activo al cerrar. Sonda HTTP 17/17 respuestas 200, diez WS sin cierres inesperados/errores en 31,242 s. Lecturas news p95 1976 ms y admin 83 ms: muestra pequeña, sin afirmar SLO.
- SIGTERM sólo al backend propio; `server_stopped cleanupErrors=0`, seis procesos propios ausentes, puertos 3000/4096/4097 cerrados y llama.cpp 8080 conservado con GPT residente. Artefactos `model-registry-primary-final-cleanup-20261020.json` y `model-registry-final-resident-20261020.json`.
- Backup consistente nuevo en disco de datos: quick_check=ok y FK vacío sobre copia 017; no integrity_check completo. El ensayo de reanudación usa otra copia candidate-018; sus resultados finales están en model-registry.md y model-registry-results.json.

Fallos previos preservados: arranque frío getFeed 30 s con otra copia compitiendo HDD; timeout admin/Chromium anteriores al slot de lectura; iterate()+escritura rechazada por better-sqlite3, corregido a get() por fila. No se alteraron pruebas para aprobar. Memoria/heartbeat muestreados requieren seguimiento y todavía falta vigilancia 24 h y validación semántica de tareas/modelos.

Cierre del ensayo de copia: **passed**, 112.291 eventos recorridos/sellado completo, misma generación reanudada desde 24.080; 1.383 páginas, p95 425 ms y máximo 975 ms, FK de event_index_links vacío y manager closed. La última pasada duró 403.546 ms; no fue soak continuo de 30 min. Corte final readonly de la base principal: ownership vacío, GPT incomplete con interrupción reconocida, cero publicaciones duplicadas por job y cero basadas en snapshots sin sellar. Comprobación final 17:44:30 UTC: cero procesos Node restantes, GPT residente y nueve modelos en catálogo (siete verificados); 17 documentos revisados sin credenciales locales.
