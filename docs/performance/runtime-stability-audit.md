# Auditoría de estabilidad y rendimiento de OGID

Fecha: 11 de octubre de 2026. HEAD inicial comprobado en `main`:
`8a657c6e80880cf6a5cba6f8ae05ba231a7b8226`; coincide con la referencia solicitada.
Intervención en `fix/runtime-stability-performance`, sin push ni merge.
Node 22.23.3, Linux; `npm start` conserva `node server.js`.

Se preservaron los cambios locales de `backend/.env.example`, `backend/data/`
y el cambio del operador en `.gitignore`. Copias de los diffs:
`/tmp/ogid-runtime-audit`. Estos archivos/datos no forman parte de los commits.
Git no tenía identidad de autor: los commits usan `Codex <codex@localhost>`
por comando, sin cambiar configuración global ni atribuirlos al operador.
`feat/sqlite-worker-news-pipeline` sólo se consultó; HEAD observado
`f74eb9cb465aaf42fba99a7471c8f49c227742e9`, sin modificarla ni fusionarla.

## Resultado y alcance

Se corrigieron defectos reproducidos de origen WS, backpressure, amplificación
Yahoo, concurrencia de refresh, cancelación y recuperación del dashboard.
La suite pasa de 592 a 616 pruebas, incluida la cadena periódica tras un fallo. Se verificó el comando real `npm start`,
SIGTERM, cierre WS 1001 y liberación del puerto. Hay handshake real por loopback
y la interfaz LAN del mismo host, rechazo 403, saturación TCP y diez clientes.
Chromium valida recuperación HTTP/WS, Admin, móvil y dos dashboards simultáneos.

La desconexión concreta observada por el operador **no se reprodujo en su LAN**:
no se dispone de otro dispositivo, su DNS mDNS, navegador ni proxy real.
Los defectos son causas posibles verificadas; no prueban que todas sus
reconexiones tengan una única causa. No se encontró P0 demostrado. Fallos de
proveedor se prueban con fixtures; Yahoo real se comprobó sólo con tres consultas
puntuales. No se declara validada toda la watchlist, Twelve Data real, IA remota
ni todos los embeds reales.

## Diagnóstico y causas raíz

El diagnóstico inicial y seis regresiones fallidas se registraron **antes** de
modificar componentes críticos. Suite base: 592/592, 28,815 s.
`runtimeStability.test.js` fallaba en las seis regresiones originales; después
incluye una séptima comprobación del ledger. Log original:
`/tmp/ogid-runtime-audit/reproductions.log`. Pruebas y artefactos resumidos
versionados permiten revisar el resultado sin depender de ese directorio.

| Nivel | Hallazgo y reproducción | Causa / corrección |
|---|---|---|
| P1 | X-Forwarded-Proto falsificado alteraba el origen esperado | Se confiaba en cualquier peer; ahora protocolo del socket y lista explícita de IPs de proxies |
| P1 | Buffer 999.999 + mensaje 4 bytes superaba 1 MB; peer perdía 1013 | Sólo se medía buffer anterior y se terminaba inmediatamente; sumar mensaje y conceder 1 s al close |
| P1 | Batch Yahoo 403/429/500 producía tres consultas para dos símbolos | Fallback indiscriminado por símbolo; sólo dividir validación de batch |
| P1 | Callers mercado ejecutaban dos wrappers; selección RSS se solapaba | rssOnly evitaba protección; promise compartida y una selección posterior coalescida |
| P1 | Awareness bloqueado leyendo body después de headers | Timeout/semaphore terminaban antes del body; lectura acotada y cancelación al apagar |
| P1 | WS aceptado sin snapshot impedía recuperación HTTP | open detenía polling antes del estado; syncing conserva respaldo hasta snapshot |
| P2 | connect repetido creaba sockets; opens cortos reiniciaban backoff | Guarda por instancia, jitter y reset tras 30 s estable |
| P2 | start repetido durante primer ciclo duplicaba inicialización | Guardas idempotentes y seguimiento/drain de tareas |
| P2 | Query ledger copiaba evidencia descartada de 10.000 eventos | Filtrar/ordenar/limitar antes de clonar; p95 154,546 → 78,938 ms |
| P2 | Updates mercado reenviaban noticias y actualizaban gráficos iguales | Payload parcial compatible y firmas por panel; 20 updates iguales: cero updates Chart |

La regresión de dashboard se reprodujo en Chromium con un transporte aceptado
sin snapshot: antes, una petición inicial, ninguna noticia offline tras 25 s;
después, respaldo HTTP y resync WS sin otra consulta duplicada. Ver artefactos
`browser-pre-gate.json` y `browser-result.json`.

Hipótesis descartadas como explicación universal: toda desconexión WS no es
rate limiting; Yahoo no estaba indisponible en la comprobación puntual; SQLite
no resuelve validación de origen/retries/polling; no se demostró falta de supervisor.
No se demostró que los cierres observados originalmente fueran reinicios,
heartbeat, firewall, mDNS o HTTPS: requieren correlación en el host real.

## Implementación y archivos modificados

### WS, LAN y cliente

`backend/websocket/socketServer.js`, `frontend/js/websocket.js` conservan
snapshot/update/market:quotes-bootstrap:v1 y eventos existentes. Origen estricto contra
Host y protocolo real; IP/hostname LAN directo conserva same-origin. Un alias
no loopback atendido desde loopback exige autorización explícita o Host igual
a la IP local del socket. Origin ausente: sólo loopback directo sin forwarding.

`WS_TRUSTED_PROXY_IPS`: IPs exactas separadas por coma. Sólo esos peers pueden
usar X-Forwarded-Host/Proto o un único Forwarded. El proxy debe sobrescribir
headers, no concatenar cadenas. Se rechazan protocolos extraños, cadenas,
host con credenciales/ruta y Origin distinto. Esta opción no cambia admin HTTP.
`WS_ALLOWED_ORIGINS` declara aliases locales con protocolo/puerto exactos;
no autoriza cross-origin ni tiene comodines. No se desactiva autenticación.

Heartbeat 15 s por defecto: tolera dos pongs ausentes, cierra aproximadamente
a los 45 s; intervalo retrasado >1,5 veces no cuenta como pérdida del peer.
1001 heartbeat-timeout; 1013 resync-required; 1011 send-failed; parada
1001 server-shutdown. Si TCP impide entregar close aún puede aparecer 1006:
terminate tras 1 s. Entrada máxima 64 KiB; salida 1.000.000 bytes por cliente.
El lento se aísla; los demás reciben. Sin clientes se evita serializar.

Cliente: ws/wss desde location, un socket/timer, ignora callbacks obsoletos,
limpia pagehide. Jitter 0,5–1 del techo creciente hasta 15 s; tras 20 intentos,
30–60 s por intento. 1008 detiene reintentos WS y mantiene respaldo HTTP.
Snapshot de reconexión es el resync, sin petición HTTP extra si ya llegó.

### Scheduling, RSS y lifecycle

`refreshOrchestratorService.js`: single-flight noticias/mercado, una selección
RSS posterior al ciclo completo, intraday seguido en pendingCycles, timers
rescheduled en finally, start idempotente. Conserva cuotas, sesiones, TTL,
políticas off-hours y prioridades canónicas. Updates mercado envían meta,
market/insights/predictions/impact/history; no noticias/countries/map/AI sin cambios.

`rssCanonicalPipeline.js`, `rssAggregator.js`: esperan hook de archivo y miden
parse/classify/dedupe/archive. Hook en `server.js`: lotes 500, setImmediate entre
lotes. Ya había deadline, semáforos global/host, rotación y dedupe: se conservaron
identidad, criticidad, fuentes y diferencia búsqueda generada/feed físico.

`awarenessService.js`: timeout/semaphore incluyen body ≤1 MB, stop aborta y
espera ciclo. `providerRuntime.js`: Retry-After mínimo, espera cancelable.
`aiEnrichmentCoordinator.js`, `aiProviders.js`, `llamaCppProvider.js`: signal
hasta proveedor y retry sleep; NVIDIA incluye body en presupuesto/semaphore.
`mediaStreamService.js`: stop espera refresh. Servidor deja de admitir HTTP/WS,
abort/drain proveedores y jobs, flush archivo y close recursos. SIGINT/SIGTERM
únicos, deadline 30 s. Excepciones/rechazos fatales: parada y exit 1; un error
ordinario de proveedor no se considera fatal ni liveness fallida.

### Yahoo, mercado y provenance

`marketData/rateLimit.js`, `yahooClient.js`, `marketDataService.js`,
`market/providers/yahooProvider.js`. Se conserva yahoo-finance2 4.0.2,
concurrencia 3, timeout 10 s, dos retries máximos sólo recuperables. Pendientes
máximo 200, dedupe por clave, cancelación, circuito tras cinco fallos recuperables,
cooldown 30 s. 429 activa cooldown global sin retry de esa operación;
Retry-After mínimo incluso >15 min. Bodies HTTP fallidos se cancelan.
401/403/4xx definitivos no se reintentan aunque mensaje contenga timeout.

Quote batch sólo se divide con FailedYahooValidationError e issues; grupos
de tres, no admite siguientes grupos tras fallo global. Test: batch inválido
seguido de 503 no consulta todos los símbolos. Registro verificado, search TTL
5 min, chart TTL por intervalo, cuotas y selección de proveedor se conservan.
Búsqueda de nombre usa search; resolución exacta local no provoca quote/chart.
No cambia IDs, tickers, moneda, bolsa, calendario, OHLCV o criterios financieros.

Router/merge conserva precio previo válido como stale con timestamp/fuente
originales; refresh no sustituye observación. Tests existentes cubren stale y
provenance. Los precios fixture se generan sólo dentro del entorno de prueba;
no se añadió generación de precios a producción.

Yahoo real: search General Dynamics 231,95 ms, 5 resultados; quote GD 491,98 ms,
precio positivo, **asOf 2026-10-09T20:00:03Z**; chart GD 7 días/1d 108,54 ms,
5 barras. Tres consultas secuenciales, cero retries/fallos. Era domingo: asOf
es último cierre observado, no precio actual del domingo. Artefacto
`yahoo-live-smoke.json`, registrado desde stdout sin guardar respuestas/credenciales.

### Paneles, salud y limpieza

`frontend/js/dashboard.js`, `api.js`, `smartPollLoop.js`: recuperación syncing,
polling noticias 15 s visible/90 s oculto, backoff acotado, una petición activa,
AbortSignal y descarte de resultados obsoletos. Firma de datos/contexto por panel;
provider polling usa SmartPollLoop. Solicitudes IA/condiciones según update.
Feed news-first, animaciones y paginación conservados; no vuelve mapa/hotspots,
no hay rediseño visual ni endpoints eliminados.

`research/eventLedger.js`: filtra y limita antes de clonar evidencia; conserva
total, orden, calidad, identidad, impactos y aislamiento de mutaciones.
Se quitan refresh helper muerto y timers redundantes; sin refactor cosmético.

`services/runtimeMetrics.js`, server, controllers/routes health/admin,
`middleware/sensitiveRouteAuth.js`, `contracts/ogidOperations.js`: CPU/memoria,
ELU/lag, HTTP, readiness y endpoints aditivos. Últimas 512 latencias HTTP,
histograma lag de un minuto, 20 eventos WS, detalle cinco peers (no límite clientes).
Muestras sin URLs/headers/bodies; handshake normaliza origen sin query/referer,
payload inválido no se imprime. Admin/runtime y pipeline-status mantienen auth;
health público oculta peers/rutas. Catálogo sigue versión 1.3.0, MCP compatible.

- `/api/health/live`: proceso atendiendo, independiente de upstream.
- `/api/health/ready`: listener iniciado y no apagándose (503 en parada).
- `/api/health`: estado funcional/calidad/proveedores, sin llamar muerto al proceso por upstream.
- `/api/admin/runtime`: métricas protegidas, ciclos, cola y WS.

Tests nuevos: `runtimeStability.test.js`, `wsRuntime.integration.test.js`,
`realtimeRecovery.test.js`, `lifecycleRuntime.test.js`. Ajustes tests existentes:
`newsFirst.test.js` close gradual y `yahooProvider.test.js` fallback acotado.
Scripts nuevos: benchmark-event-ledger, soak-runtime-stability,
smoke-npm-runtime y verify-runtime-dashboard. Inventario completo:
`git diff --name-only 8a657c6..HEAD`; cambios locales del usuario están fuera.

## Métricas y comparación

Artefactos: [runtime-stability-results](runtime-stability-results/).
Benchmarks: fixtures, almacenamiento temporal, ningún proveedor real. No hubo
soak de 30 minutos del commit main; primer soak fue versión intermedia y no se
usa como baseline original. Las muestras cortas de carga coincidieron con
soaks, por lo que no fundamentan una promesa de velocidad global.

Mismo benchmark existente news-first: 18 feeds, global 4, host 1, deadline 25 s,
corpus 17; 10 rondas por endpoint, concurrencia 1/10. Posterior coincidió con
otros procesos; pequeñas diferencias no demuestran mejora general.

| Métrica | Base | Posterior |
|---|---:|---:|
| Lag p95 | 17,826 ms | 18,252 ms |
| Health caliente, 1 caller p50/p95 | 1,558 / 1,715 ms | 1,767 / 2,558 ms |
| Snapshot caliente, 1 caller p50/p95 | 1,940 / 3,184 ms | 1,589 / 1,981 ms |
| Snapshot caliente, 10 callers p50/p95 | 12,508 / 14,961 ms | 12,103 / 18,318 ms |
| Último ciclo selección | 22 ms | 19 ms |
| Primera selección | 451,673 ms | 452,705 ms |
| Solicitudes RSS fixture | 18 | 18 |
| Heap / RSS al terminar | 45,76 / 179,63 MiB | 42,89 / 181,95 MiB |
| Payload completo | 25.011 bytes | 25.146 bytes |

CPU base 1.852.521 µs user +196.127 system; posterior 1.833.837 +211.584.
Son acumulados de proceso multihilo, no % CPU. Payload de tabla es **completo**;
reducción se aplica a updates mercado. En Chromium, mismo estado de 60 noticias:
32.510 bytes completos frente a 3.003 bytes de update mercado (−90,8%);
los 20 updates utilizan ese payload real y preservan DOM/gráficos.
No presentar esa reducción como reducción del snapshot.

Ledger, mismo fixture 10.000 eventos y 20 queries GD: p50 120,430 →64,175 ms;
p95 154,546 →78,938 ms (−48,9%), CPU user 2.758.812 →1.320.828 µs.
Heap final consultas 103,30 →35,74 MiB, allocations sin GC final: no prueba de fuga.
Persistencia 10.000 noticias: ingest 646,314 ms, serialize 87,708 ms, write
16,226 ms, flush 104,868 ms, 10.595.917 bytes y una escritura. Runtime cede
entre lotes; JSON.stringify sigue síncrono. Sólo se mide persist, no hydrate
real del operador ni latencia/IPC de SQLite.

Muestra corta exploratoria de 30 s (artefactos equivalent-*-clean.json),
10 clientes, 12 rondas; base main frente a correcciones iniciales, antes del
último ajuste de ledger. Se ejecutó mientras otro soak consumía recursos:

| Métrica | Base corta | Posterior inicial |
|---|---:|---:|
| Lag p50/p95/p99 | 10,101 /12,247 /30,360 ms | 10,142 /12,124 /26,526 ms |
| Lag máximo | 415,498 ms | 400,294 ms |
| HTTP p50/p95/p99 | 94,993 /427,348 /428,280 ms | 96,756 /161,091 /161,917 ms |
| ELU | 0,19343 | 0,19334 |
| CPU user/system | 7.080.229 /310.124 µs | 6.975.229 /396.961 µs |
| Heap / RSS | 134,07 /279,99 MiB | 201,34 /352,04 MiB |
| Calls mercado / RSS fixture | 18 /198 | 12 /216 |

Las distintas cantidades de trabajo y muestras pequeñas impiden atribuir
las diferencias de latencia/heap a una mejora general. Sí quedan registrados
p50/p95/p99 y desaparición de llamadas duplicadas de mercado en este escenario.
No declarar mejora sostenida de heap a partir de esta muestra.

### Soak controlado de treinta minutos

**Ejecutado: 1.800,532 s, exit 0 del harness**, diez clientes, 712 rondas,
7.120 respuestas HTTP, 712 operaciones de mercado fixture, 476 solicitudes RSS
fixture (el contador interno de último checkpoint era 472). Cero cierres
inesperados, heartbeatTimeouts, buffers saturados, rechazos upgrade o drops.
Treinta checkpoints con diez conexiones y pending=0 al terminar cada ronda.

| Métrica soak | Resultado |
|---|---:|
| Lag p50 /p95 /p99 /máximo | 10,150 /11,174 /44,204 /1.044,906 ms |
| HTTP combinado p50 /p95 /p99 | 447,451 /473,108 /545,029 ms |
| ELU | 0,21380 |
| CPU user /system | 440.921.121 /26.819.185 µs (25,98% de un núcleo, proceso completo) |
| RSS /heap usado final sin GC | 543,30 /287,61 MiB |
| Heap tras GC, minuto 5 /último checkpoint 29,26 | 86,41 /88,32 MiB |
| Mensajes WS /bytes entregados | 32.060 /991.182.520 |
| Frecuencia media global WS /bytes | 17,8 envelopes/s /550,5 kB/s entre diez clientes |
| RSS último checkpoint | 693 writes; snapshot último 16.686.047 bytes; serialize 56,416 ms; write 44,901 ms |

El heap tras calentamiento crece aproximadamente 1,91 MiB (2,2%) entre minuto 5
y 29; no se demuestra fuga lineal, pero no se certifica estabilidad indefinida.
RSS del proceso permanece elevado y el heap final contiene garbage todavía no
colectado. Los bytes de persist son del último snapshot, no total de escrituras.
En ese checkpoint parse/classify/archive=0 /0 /0,00014 ms (sin artículos nuevos),
dedupe=15,984 ms y ciclo RSS=79 ms: no extrapolar esas últimas etapas a un ciclo
frío. Las métricas detalladas de cada minuto están en el JSON.

El objetivo lag p95<100 ms se cumple; cero cierres/colas acumuladas en
checkpoints. **Latencia HTTP bajo esta carga y ráfagas de hasta 1,045 s siguen
siendo limitaciones P2 medidas**, aunque no rompen heartbeat. No se declara
resuelto todo bloqueo CPU. El primer soak intermedio (no main), mismo perfil,
registró p95 HTTP 885,237 ms y máximo lag 2.024,800 ms; la versión final registra
473,108 /1.044,906 ms. Es comparación observacional: coexistían procesos de
prueba y se completaron 617 frente a 712 rondas, por lo que no es una estimación
causal aislada. La mejora aislada del ledger sí tiene el mismo fixture/query.
WS total no baja respecto al intermedio (966.075.710 bytes), pues hay más ciclos
y dominan updates completos de noticias; no prometer reducción global de tráfico.

El código de runtime del soak incluye scheduling, ledger, partial updates,
shutdown y métricas; la última protección adicional del fallback Yahoo y el gate
del navegador se validan en suite/browser, no con esos peers WS sin navegador.


Diez clientes WS, diez HTTP por ronda, RSS 20 artículos/feed, dos instrumentos
verificados y 503 cada quinta consulta mercado; pausa 2 s tras cada ronda.
IA/Awareness off, background timers desactivados; ciclos disparados por el harness.
La prueba determinista de scheduler comprueba duplicados, fallo y reprogramación.
Treinta minutos reales, sin reloj simulado. Memoria cada minuto
con GC; heap final sin GC no es criterio de fuga. No hay llamadas externas.
HTTP agrega health/snapshot durante refresh, no SLA de cada endpoint.
Etapas RSS en samples son últimas duraciones, no percentiles acumulados.

## Pruebas ejecutadas y pendientes

| Prueba | Resultado / límite |
|---|---|
| Suite base / final | 592/592, 28,815 s / 616/616, 29,503 s, ningún skipped |
| Sintaxis backend/frontend | PASS, npm run check |
| MCP | 21/21, 2,709 s; inventario regenerado y validado, 71 rutas / 80 operaciones |
| npm start y SIGTERM | PASS; 0.0.0.0, ready, snapshot, close 1001, puerto libre; arranque 680,900 ms |
| WS loopback/LAN mismo host | PASS, HTTP/upgrade reales |
| .local / proxy | Política y handshake con headers simulados PASS; mDNS/proxy/TLS reales pendientes |
| Origin inválido | PASS, HTTP 403 |
| Heartbeat sin pong / saturación TCP | PASS, 1001 /1013, peer sano sigue recibiendo |
| Diez clientes/cinco reconexiones | PASS, un upgrade listener, cleanup al apagar |
| Yahoo 403/429/500/timeout/batch/cuota | PASS determinista, cooldown/circuito/cancelación/no fanout |
| RSS/mercado concurrentes | PASS, join/coalescing sin ciclo noticia/selección simultáneo |
| Stale/provenance/upstream ausente | PASS con fixtures, no certifica proveedores reales |
| Chromium 156.0.8078.4 | PASS, HTTP sin snapshot, resync, DOM/charts, Admin/móvil/dos tabs |

No ejecutados: otro ordenador físico, mDNS/proxy/TLS reales, soak con upstream
real, IA/media de producción, render de todos los paneles con datos reales.
No sustituir esas pruebas por headers/fixtures. Pasos reproducibles abajo.

## Operación local y diagnóstico LAN/WS

Node >=22 <27, dependencias existentes o npm ci. Configuración en backend/.env,
sin imprimirlo ni reemplazarlo:

```dotenv
HOST=0.0.0.0
PORT=3000
WS_HEARTBEAT_MS=15000
# Acceso directo: vacías.
WS_TRUSTED_PROXY_IPS=
WS_ALLOWED_ORIGINS=
```

```sh
cd backend
npm start
```

0.0.0.0 es binding. URL: `http://IP_DEL_HOST:3000` o `http://ogid.local:3000`;
frontend genera ws://HOST:PUERTO/ws, HTTPS genera wss. Conservar tokens y
allowLocalAdmin/allowLanAdmin del operador; LAN no es autorización para alterarlos.
No depende de PM2/systemd/Docker; se conservan despliegues de otros entornos.
En el sandbox se usó `PATH=/run/host/usr/bin:$PATH`, particularidad del entorno,
no requisito añadido al producto.

Detectar duplicados antes de iniciar:

```sh
ss -ltnp 'sport = :3000'
pgrep -af 'node.*server.js'
ps -p PID -o pid,ppid,lstart,args
```

Identificar instancia propia, Ctrl+C o `kill -TERM PID`, esperar server_stopped
y verificar ss. No pkill global ni matar PID sin verificar propietario/comando.
EADDRINUSE indica puerto ocupado; no se desplaza otro proceso.

Desde servidor y luego **desde otro dispositivo autorizado**:

```sh
curl -fsS http://127.0.0.1:3000/api/health/live
curl -fsS http://IP_DEL_HOST:3000/api/health/ready
curl -fsS http://ogid.local:3000/api/health
```

Abrir dashboard en las tres URLs, connected, cortar red 20 s, reconectar y
verificar noticias/mercado sin duplicados. DevTools Network→WS: handshake 101,
Origin mismo protocolo/host/puerto, snapshot/updates. Comparar cierres con
admin/runtime autenticado, lag/buffer, PID/uptime y señales. 403: upgrade
rechazado; 1006: TCP/navegador/proceso; 1001 reason: heartbeat/shutdown;
1013: resync. No inferir rate limiting de 1006. Si IP funciona y .local no,
comprobar firewall/ruta/mDNS. No se dispone aquí del otro dispositivo para ello.

Proxy: IP real del peer TCP, no del navegador. Ejemplo TLS proxy local:
`WS_TRUSTED_PROXY_IPS=127.0.0.1,::1`, sólo si el listener pertenece al proxy
confiable. Pasar Upgrade/Connection, sobrescribir X-Forwarded-Host/Proto;
no basta trust proxy global. Alias resuelto a loopback:
`WS_ALLOWED_ORIGINS=http://ogid.local:3000`. No autorizar Origin distinto a Host.

### Errores Yahoo

Consultar provider-status/pipeline-status con permisos existentes: errorName,
httpStatus, validationIssues, operación quote/chart/search, cola/cooldown/asOf.
No registrar cookies/crumbs ni respuestas completas.

| Error | Interpretación / acción |
|---|---|
| 429/YAHOO_RATE_LIMITED | Respetar Retry-After/cooldown, no forzar refresh; comprobar stale/asOf |
| 401/403 | Autorización/upstream/config; no asumir cuota, no retry/fanout |
| 5xx | Upstream recuperable, retry acotado/circuito, stale válido |
| TIMEOUT/código red | DNS/TLS/conexión/abort; no alterar validez del precio |
| FailedYahooValidationError+issues | Esquema/librería/respuesta, batch fallback acotado |
| QUEUE_FULL/CIRCUIT_OPEN | Presión local/circuito; esperar y revisar dedupe; no subir concurrencia a ciegas |
| Vacío/no resuelto | Registro/cobertura/validación; no inventar ticker/precio |

## Reproducción sin bombardear proveedores

Desde backend:

```sh
npm test
npm run check
node scripts/smoke-npm-runtime.js
node --require ./tests/testSetup.cjs scripts/benchmark-news-first.js
node --expose-gc scripts/benchmark-event-ledger.js
node --require ./tests/testSetup.cjs scripts/benchmark-news-persistence.js
node --expose-gc scripts/soak-runtime-stability.js > /tmp/ogid-soak.json
```

Soak escribe también JSON temporal, tarda ≥30 min, exit 1 si cierres inesperados,
lag p95 ≥100 ms o pending/clients incorrectos en checkpoints. Ese exit no
certifica ausencia de fuga/latencia HTTP: revisar distribución/serie de memoria.
Smoke harness: `OGID_SOAK_DURATION_MS=30000 node --expose-gc scripts/soak-runtime-stability.js`;
no sustituye aceptación de 30 minutos. MCP desde raíz:
`cd integrations/ogid-mcp && npm test`.

Playwright opcional fuera de dependencias de producto, desde raíz:

```sh
mkdir -p /tmp/ogid-browser/cdn
npm install --prefix /tmp/ogid-browser playwright
PLAYWRIGHT_BROWSERS_PATH=/tmp/ogid-browser/browsers /tmp/ogid-browser/node_modules/.bin/playwright install chromium
curl -fsSL https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css -o /tmp/ogid-browser/cdn/bootstrap.css
curl -fsSL https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js -o /tmp/ogid-browser/cdn/bootstrap.js
curl -fsSL https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js -o /tmp/ogid-browser/cdn/chart.js
PLAYWRIGHT_BROWSERS_PATH=/tmp/ogid-browser/browsers OGID_PLAYWRIGHT_MODULE=/tmp/ogid-browser/node_modules/playwright/index.mjs OGID_UI_CDN=/tmp/ogid-browser/cdn node backend/scripts/verify-runtime-dashboard.js
```

Descargas necesitan red (paquetes/CDN), no proveedores. Navegador usa assets
locales y bloquea demás tráfico externo. No añade Playwright al package.json.
Harnesses no leen/escriben datos del operador.

## SQLite: decisión basada en evidencia

JSON tiene coste demostrado: 10,6 MB, 87,7 ms de stringify síncrono, además
de ingest/clasificación. Ledger aún recorre eventos para impactos. SQLite puede
reducir reescrituras completas, hidratar ventanas/índices, limitar allocations
y acelerar queries repetidas. No corrige WS, retries, polling o clasificación CPU.
Worker JSON también paga serialización/IPC; no se migra globalmente por intuición.

Condiciones propuestas: snapshot ≥10 MB frecuente; serialize p95 >50 ms o
persist >100 ms en tres mediciones reales; queries selectivas p95 >100 ms;
lag p95 >100 ms correlacionado con persist; heap tras GC creciendo >10% por
hora con dataset/retención estables. Son umbrales de decisión, no resultados
ya comprobados en producción.

Plan posterior: congelar contratos/identidades; backup JSON verificado;
medir hydrate/persist/query/RSS/heap con 1k/10k/50k; revisar migraciones/native
dependency/worker/colas; shadow write y comparación IDs/provenance/orden;
lectura opt-in por flag; soak ≥1 h, crash-recovery/cancelación y rollback JSON.
Adoptar si persist ≤20 ms/lote y queries p95 ≤25 ms en carga equivalente,
sin regresión de contratos ni coste IPC relevante. No se ejecutó este plan ni
se fusionó la rama SQLite. No se midió su hydrate/latencia real.

## Riesgos residuales y rollback

Persisten trabajo síncrono de clasificación/escenarios/JSON y ráfagas de lag:
no ocultar máximos detrás de p95. Fixtures/GC no certifican estabilidad indefinida
ni heap del host real. Validar LAN/proxy reales, Yahoo sostenido y medios/IA
sin desactivar seguridad. Sin migración de datos/dependencias de producto.

Commits separados; rollback con git revert, orden inverso en cambios acoplados.
Proteger cambios locales y detener instancia antes de revertir:

| Commit | Cambio / rollback |
|---|---|
| a77dc5f | Yahoo: revert recupera política anterior; no borra watchlist/OHLCV |
| 61f5286 | WS: revert backend/cliente juntos; retirar sólo nuevas variables si se añadieron |
| a3782a3 | Scheduling/RSS/IA/Awareness: revert después del wiring server; datos no migrados |
| c49c296 | Runtime/health/admin: revert elimina endpoints añadidos/shutdown nuevo |
| e64874e | Ledger: revert sólo cambia coste de consultas, sin persistencia |
| 30001cc | Frontend: revert dashboard/api/test, mantiene news-first |
| Commit final de validación/documentación | Revert sólo harnesses/artefactos/informe |

Revertir del más reciente al más antiguo en rama de rollback y ejecutar
suite/npm smoke. No reset --hard, no tocar SQLite ni sobrescribir .env,
.env.example, .gitignore o backend/data. Revisar cambios operativos aparte.
No hay push/merge/supervisor/despliegue que deshacer.
