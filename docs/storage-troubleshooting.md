# Diagnóstico de la prueba SQL del 9 de octubre

La prueba usa `/srv/bitcoin/ogid/db/ogid.sqlite`, con siete migraciones y SQLite WAL. Esta revisión no modifica migraciones aplicadas ni repite la importación JSON. No se ha ejecutado start/stop/restart sobre el servicio. Systemd ya tenía `Restart=always` y realizó reinicios automáticos durante el incidente, por lo que un proceso puede haber cargado una parte de los cambios al arrancar.

## Qué provocaba el fallo

`STORAGE_OUTCOME_UNKNOWN` significa que un comando despachado superó su plazo y no se pudo determinar su resultado. El gestor termina el worker; el servidor sale y systemd lo recupera. Los `STORAGE_NOT_READY` posteriores son consecuencia de ese fallo, no otro error de proveedor. El log antiguo no identifica el comando que venció; la correlación con las filas SQL parcialmente actualizadas señala la persistencia de señales como causa principal.

El adaptador escribía el snapshot de señales y luego todas las filas históricas por país sin una transacción que las agrupase: cada UPSERT implicaba un commit `FULL`, incluso si no había cambiado. Sobre el volumen NTFS3 esto elevaba la latencia hasta superar el límite de 30 segundos. Ahora snapshot, checkpoint y buckets se confirman en una sola transacción; se escriben únicamente buckets modificados y se retiran los desaparecidos. Si falla, las tres representaciones SQL revierten juntas. El siguiente registro con cambios reconcilia también buckets que quedaron parcialmente escritos antes de esta corrección.

Había otros dos fallos independientes:

- `fetchRawNews` descartaba `rssWorkerFetch` y `awarenessMode` al reenviar parámetros. RSS primario descargaba/procesaba fuera del worker. Ahora conserva ambos parámetros hasta el proveedor.
- El peor presupuesto de cualquier proveedor asignaba una política de dos horas cuando NewsAPI/GNews estaban agotados, aunque RSS seguía disponible. Además, el límite de backoff reducía indebidamente ese intervalo: los logs confirman ciclos cada cinco minutos mientras Admin mostraba 120. Ahora el intervalo se calcula sobre los proveedores disponibles y el backoff nunca lo acorta; si todos están agotados se mantiene `CRITICAL`. Admin muestra la fecha realmente programada. No se fuerzan llamadas a proveedores sin presupuesto.

Consultar el snapshot RSS almacenado reescribía además el mismo contenido y adelantaba falsamente su checkpoint. Ahora sólo un snapshot nuevo provoca persistencia; las lecturas almacenadas de Admin no descargan feeds ni reescriben ese snapshot.

## Cómo se recoge RSS

El RSS primario pasa por la cola al worker, que rota hasta 18 feeds por ciclo, con cuatro llamadas concurrentes, timeout por feed de hasta nueve segundos y presupuesto de red de 60 segundos. Archiva los resultados admitidos en lotes de 100 y cede el turno entre lotes. Devuelve como máximo 900 artículos al coordinador; la selección del dashboard usa su política de diversidad y actualidad. Este límite de salida no es el límite del archivo SQL.

RSS Aggregate es otro corpus reciente, con su propia rotación/deduplicación y snapshot. Un contador de 288 en ese panel no demuestra que el archivo histórico tenga sólo 288 noticias. `sourceMode` del dashboard tampoco describe por sí solo la disponibilidad de cada proveedor.

La rotación es parcial: no se consulta todo el catálogo en cada ciclo. Cuotas, errores HTTP y estados de admisión de fuentes oficiales siguen aplicándose. `blocked`/`probing` no implica una descarga activa. IA desactivada no genera enriquecimientos. Los backfills históricos necesitan una petición explícita.

## Estado observado, sin forzar descargas

Lectura a las 21:05 CEST: PID 521485, 799 segundos de uptime, nueve reinicios acumulados del supervisor; localhost y `192.168.1.50` respondían en 12 y 3 ms. Worker `ready`, cola vacía, 347 comandos confirmados y cero fallos desde ese arranque. RSS completó el ciclo a las 21:04:40: 900 resultados brutos devueltos, 18 seleccionados RSS más 18 de Awareness; NewsAPI/GNews se omitieron por presupuesto agotado. Yahoo aportaba 18 cotizaciones demoradas, sin fallback sintético. Awareness tenía 15 fuentes healthy, cuatro blocked y tres probing; IA estaba off.

La base contenía 34.789 artículos, 34.849 revisiones, 6.785 eventos, 24.538 velas, 2.189 observaciones de cotización, 2.628 buckets de señales, 734 eventos Awareness y 9.199 sondeos. Frente a la lectura anterior habían aumentado artículos, eventos, velas, cotizaciones, señales y sondeos. Los checkpoints confirmaban actividad reciente. Son cifras de una lectura concreta, no valores esperados permanentes.

Ese proceso había cargado correcciones iniciales, pero todavía no la nueva telemetría ni la nueva política de intervalos: seguía mostrando `CRITICAL` y 120 minutos, aunque los logs revelaban intervalos reales de cinco minutos por el error de backoff. No se considera validada en producción la versión completa antes del reinicio manual. A las 21:10 completó otro ciclo RSS con 18 feeds correctos y 406 resultados brutos, manteniendo el mismo PID y número de reinicios.

## Consultar SQL y los paneles

Este comando abre la base en sólo lectura, sin worker adicional, migraciones ni descargas; funciona también antes de reiniciar:

```sh
cd /home/fedora/ogid/backend
npm run storage:inspect -- /srv/bitcoin/ogid/db/ogid.sqlite
npm run storage:inspect -- /srv/bitcoin/ogid/db/ogid.sqlite --watch
```

`--watch` muestra cada cinco segundos contadores, diferencias respecto a la muestra anterior, checkpoints, últimas ejecuciones y tamaño DB/WAL. Ctrl+C termina la inspección. Un contador estable puede significar deduplicación o actualización de filas existentes: revisar también revisiones, checkpoints y tiempos de ejecuciones. Algunas escrituras, como cotizaciones, registran checkpoint sin crear una fila de ejecución; `no recorded run` por sí solo no implica inactividad.

Después del reinicio, Admin incorpora **Server, SQLite & Worker**: PID/Node/uptime/memoria, versión/ruta/tamaño SQL, cola y límites, heartbeat, operaciones activas y sus plazos, último timeout, contadores y escrituras confirmadas. Las muestras SQL se calculan en el worker como máximo cada 30 segundos y se entregan por heartbeat cada cinco segundos. Consultar salud o pipeline-status sólo lee esa telemetría cacheada. Un heartbeat atrasado puede indicar un worker ocupado.

News muestra etapa actual, adquisición, próximo arranque programado, proveedores omitidos, feeds consultados y resultados archivados/devueltos. RSS Raw indica que los datos están almacenados y cuándo se obtuvieron. Tras el arranque, las ejecuciones que quedaron `running` en un proceso anterior se marcan interrumpidas; el ciclo nuevo tiene sus propias fechas.

## Activar esta revisión, manualmente

No es necesario reinstalar las unidades ni volver a importar JSON. Crear primero una copia consistente si se desea conservar el estado previo:

```sh
cd /home/fedora/ogid/backend
npm run storage:backup -- /srv/bitcoin/ogid/db/ogid.sqlite "/srv/bitcoin/ogid/backups/ogid-$(date +%Y%m%d-%H%M%S).sqlite"
systemctl --user restart ogid.service
systemctl --user status ogid.service --no-pager
curl --fail --max-time 10 http://192.168.1.50:3000/api/health
npm run storage:inspect -- /srv/bitcoin/ogid/db/ogid.sqlite --watch
```

En otra terminal:

```sh
tail -F /home/fedora/ogid/backend/data/logs/ogid.log
journalctl --user -u ogid.service -f
systemctl --user show ogid.service -p MainPID -p NRestarts
```

Confirmar `storage.state=ready`, presencia de `storage.worker.heartbeatAt`, ciclo de noticias completado, escrituras confirmadas y estabilidad del PID/reinicios. Recargar Admin para obtener también el JS nuevo. Si vuelve a vencer un comando, `storage_worker_failed` incluye la operación/servicio/método y el plazo, sin contenido de noticias ni credenciales.

## Ensayo de la corrección

Se crearon copias consistentes verificadas, sin escribir sobre la base de producción. En `/tmp`, el registro de señales tardó unos 32 ms; en una copia en el mismo volumen `/srv/bitcoin/ogid/diagnostics/worker-20261009.sqlite`, unos 922 ms. Sobre ese volumen, configurar tomó 6,26 s, ingerir 100 noticias 2,43 s y refrescar escenarios para los 18 instrumentos 4,12 s. Ninguna operación ensayada superó 30 segundos. No es una certificación de cualquier carga futura ni incluye tiempos de descarga externa.

Validación de la primera revisión: 601 pruebas backend y 21 MCP aprobadas; sintaxis e inventario MCP correctos. Se comprobó también el renderizado de los paneles mediante un DOM simulado, sin afirmar una prueba visual en navegador. Las regresiones comprueban el paso real de `fetchRawNews` al worker, política RSS con proveedores agotados, intervalos efectivos del scheduler, lecturas almacenadas sin escritura, persistencia de 12.000 buckets sin reescribir los intactos y rollback ante fallo SQL de snapshot/checkpoint/buckets. La continuación operativa y las futuras vistas históricas permanecen en el [roadmap](storage-implementation-roadmap.md).

## Segundo incidente: condiciones y Advanced, 21:15 CEST

La telemetría nueva identifica `domain.call / conditions / getSnapshot` como el comando que venció a los 30 segundos, en fase de ejecución. Los errores de Advanced y Awareness posteriores son consecuencias de terminar el worker compartido. Las pruebas anteriores no cubrían un panel de condiciones con 18 instrumentos y 500 velas intradía por instrumento.

Sobre una copia consistente de 512 MB, ese cálculo seguía ejecutándose después de más de 90 segundos y alcanzaba aproximadamente 1,9 GiB de RSS; se interrumpió únicamente el proceso de diagnóstico. No se detuvo el servicio real. El cálculo repetía resolución de sesiones, calendarios, formatos `Intl.DateTimeFormat` y detección de huecos para cada vela y cada rollup. Además, resolvía todas las series antes de comprobar su cache, por lo que repetir una petición tampoco ahorraba ese trabajo. El problema era CPU/memoria durante el análisis, no una descarga pendiente ni evidencia de corrupción SQL.

La corrección reutiliza formatos ICU (máximo 32), días de calendario (512) y resoluciones de sesiones (4.096). Las respuestas de calendario/sesión se clonan para impedir que un consumidor contamine el cache. Mantiene DST, festivos, medias sesiones y reglas de admisión. Las series derivadas también se cachean (128 entradas), por instrumento, ventana, minuto y hash del contenido de las velas; una corrección de una vela antigua invalida el resultado aunque no cambie la fecha de la última vela. Se evita resolver días adyacentes cuando no se necesitan.

El ensayo en la copia pasó a 2,9 segundos en frío y 83 ms al repetir la ventana de cuatro horas en el mismo minuto. En otra prueba HTTP, usando la cola y el worker reales sobre esa copia y un puerto temporal, se solicitaron simultáneamente las cuatro ventanas, Advanced y velas: las seis devolvieron 200, en hasta 8,7 segundos; `/api/health` respondió en 94 ms y el proceso rondó 389 MiB. El contexto de noticias era una proyección capturada de la API real (13 noticias, 18 cotizaciones), no una reproducción de toda combinación posible de carga. No hubo llamadas externas durante estos ensayos.

Awareness tenía otra excepción: el callback async de su timer reprogramaba el ciclo en `finally` sin capturar el rechazo. Ahora registra `awareness_cycle_failed`, espera la terminación de todos los sondeos del ciclo y evita un rechazo sin manejar. Un fallo `STORAGE_*`/`SQLITE_*` se propaga como fallo de almacenamiento, sin declararlo un nuevo fallo HTTP del proveedor ni intentar persistir otro sondeo en un worker caído.

### Las 66 fuentes RSS

En la lectura del proceso a las 21:23, el catálogo primario tenía 66 fuentes; el lote contenía 18: 17 respondieron correctamente y CFTC devolvió HTTP 403. El panel antiguo sólo renderizaba `rssFeedStatus`, que contiene el lote. No significaba que las otras fuentes hubiesen desaparecido.

Admin ahora renderiza las 66 entradas configuradas: separa disponible/habilitada de salud observada y señala las pendientes de rotación, fuera del último lote y deshabilitadas. No se declara saludable una fuente que todavía no se ha sondeado. Conserva el último intento/éxito/resultado por URL en SQL. El cursor rotatorio se confirma junto con esos diagnósticos y se restaura tras un reinicio; antes, cada reinicio volvía al primer lote, lo que podía impedir llegar al resto. Se mantienen hasta 18 descargas por ciclo, no 66 descargas simultáneas.

RSS registra ahora su ejecución SQL. Los pipelines con escrituras mediante checkpoint pero sin fila de ejecución, como cotizaciones, muestran `persisted (checkpoint)` y su último commit; la ausencia de fila ya no se presenta sola como señal de inactividad.

### Estado real y activación

A las 21:33 el servicio seguía activo con PID 531852, `ready`, cola vacía y alrededor de 2,1 GiB de RSS. Ese proceso todavía no había cargado esta revisión de calendarios/caches/catálogo; su aparente salud entre peticiones no demuestra que los paneles costosos estén corregidos. El supervisor llevaba cinco reinicios en esa sesión, el último a las 21:24:21. El agente no ha iniciado, detenido ni reiniciado `ogid.service`.

Aplicar manualmente la revisión con `systemctl --user restart ogid.service` y recargar el navegador. No hay migraciones SQL nuevas ni que repetir el importador. Comprobar luego las dos peticiones que antes fallaban:

```sh
curl --fail --max-time 30 'http://192.168.1.50:3000/api/market/conditions?windowMin=240&countries=US,IL,IR'
curl --fail --max-time 30 'http://192.168.1.50:3000/api/intel/advanced-snapshot?countries=US,IL,IR'
```

En Admin verificar 66 filas del catálogo, memoria, tiempos de operaciones y estabilidad del PID/contador de reinicios. Las respuestas pueden indicar calidad `partial` o `insufficient_data` por cobertura real de velas; eso es diferente de un timeout o un panel que nunca termina de cargar.

Validación de esta segunda revisión: 606 pruebas backend y 21 MCP aprobadas, inventario y sintaxis correctos. Las nuevas regresiones cubren aislamiento del cache con DST/cambio de perfil, corrección de velas anteriores, rechazo del timer de Awareness, distinción entre fallo de almacenamiento y proveedor, las 66 entradas en Admin sin descargas y continuidad de rotación al reabrir SQL. El renderizado de los 66 feeds se comprobó con un DOM simulado. Los scripts `deploy/storage/verify-panels.mjs` y `verify-panels-http.mjs` reproducen los cálculos y HTTP respectivamente, exigiendo una copia en `diagnostics` y un contexto capturado; no aceptan la ruta de producción.


## Corpus acumulado y STORAGE_COMMAND_TOO_LARGE (22:08 CEST)

En la revisión siguiente, el servicio activo (PID 539679, inicio 22:07:16) tenía el worker preparado, pero el ciclo de noticias falló a las 22:08 con `STORAGE_COMMAND_TOO_LARGE`. La traza terminaba en `news.recordContext`: enviaba el snapshot completo, incluido el mapa, antes de que el worker extrajese sus campos. Este rechazo no termina el worker; el proceso seguía activo y esperaba su siguiente intervalo.

Los mensajes de contexto, mapa, señales y archivo ahora seleccionan sólo sus entradas antes de serializarlas. Los endpoints ligeros de noticias/riesgos/cuotas/Admin tampoco clonan los mapas para leer unas pocas filas. Se ha probado un mensaje con un mapa de más de 8 MiB.

La adquisición se mueve al worker y guarda antes de analizar. RSS primario rota con su propio ritmo, las búsquedas generadas se conservan y el dashboard se actualiza desde SQL cada minuto. El riesgo usa todas las candidatas geopolíticas del día; la selección visible y la de análisis tienen límites separados. Consultar [news-sql-pipeline.md](news-sql-pipeline.md) para criterios, rasgos derivados, configuración y activación manual.

Una prueba concurrente encontró prepared statements reutilizados mientras su iterador seguía abierto durante un yield. El cache prepara una instancia independiente si el statement está ocupado. Cada escaneo del corpus usa además su propia transacción de lectura: una ingesta concurrente no puede hacer que un resultado anterior quede cacheado bajo una revisión nueva. Se verifican ventanas simultáneas y una ingesta intercalada.

## Fallo de arranque: límite antiguo del mensaje, 23:01 CEST

La traza de `startup_failed` termina en `domain.configure`, antes de abrir HTTP. El servicio quedó `failed`, con PID 0 y nueve reintentos. No es un timeout ni un fallo SQL: el gestor rechaza el mensaje antes de enviarlo al worker. Systemd agota después su límite de arranques.

El `.env` conservaba `STORAGE_MAX_COMMAND_BYTES=262144` (256 KiB), aunque el modo de negocio admite proyecciones mayores. La configuración medida ocupaba 435.918 bytes incluso sin instrumentos: 373.657 correspondían a `news.sourceCatalog`, duplicado innecesariamente. El servidor ahora conserva ese catálogo localmente y envía las opciones de proveedores y feeds, incluidas sus personalizaciones. Los proveedores del worker importan el catálogo versionado por su cuenta.

Se alinearon `.env`, `.env.example` y la plantilla del servicio con los límites acotados del modo de negocio:

```dotenv
STORAGE_QUEUE_MAX_BYTES=33554432
STORAGE_MAX_COMMAND_BYTES=8388608
STORAGE_TIMEOUT_MS=30000
STORAGE_SHUTDOWN_TIMEOUT_MS=180000
STORAGE_DB_PATH=/srv/bitcoin/ogid/db/ogid.sqlite
```

Los límites corresponden a 32 MiB acumulados en cola y 8 MiB por comando. No reservan esa memoria por adelantado. Los rechazos incluyen operación, tamaño y límite en `startup_failed.command`, sin contenido ni credenciales; el estado de la cola expone también `maxCommandBytes`.

Prueba real en puerto temporal, usando el `.env` actual, una copia consistente de la base de 34.922 artículos y sus 18 instrumentos: mensaje de configuración de 78.295 bytes, arranque en unos 4,8 segundos, worker `ready`, cero rechazos y cero solicitudes externas. Salud, noticias y pipeline-status devolvieron HTTP 200; se recuperaron 40 noticias y 666 candidatas diarias. La regresión arranca además con el catálogo completo y el límite antiguo de 256 KiB. Las 617 pruebas backend pasan.

No se modificó la base original ni se instaló/reinició el servicio. La unidad instalada actual ya lee el `.env` corregido; para recuperar este incidente no es necesario copiar la nueva plantilla ni ejecutar `daemon-reload`:

```sh
systemctl --user reset-failed ogid.service
systemctl --user start ogid.service
systemctl --user status ogid.service --no-pager
curl --fail --max-time 10 http://127.0.0.1:3000/api/health
tail -F /home/fedora/ogid/backend/data/logs/ogid.log
```

`reset-failed` libera el límite de arranques que agotaron los reintentos. No hace falta repetir importaciones ni migraciones.

## Noticias, cola y velas Yahoo: 23:18 CEST

Los logs del servicio identifican dos vencimientos: `news.collect` a las 23:16, tras 180 segundos, y `news.getProjection` a las 23:18, tras 30 segundos. La petición de NVDA devolvió 503 cuando este segundo fallo terminó el worker compartido. El endpoint entonces sólo consultaba velas SQL; no hubo una descarga Yahoo fallida en esa petición. Dos comprobaciones directas con `yahoo-finance2` devolvieron 252 barras de NVDA y MSFT en 140 y 149 ms.

La reproducción en una copia descubrió además un error de plazos: se contaba la espera en cola dentro del tiempo de ejecución. Una consulta que comenzó tras unos 25 segundos de espera terminaba el worker a los 30 segundos totales, aunque sólo llevaba unos cinco segundos ejecutándose. Se separaron ambos relojes: cola de 90 segundos, ejecución general de 30 segundos desde `command-started`. La proyección amplia dispone de 90 segundos de ejecución. Se mantiene el cierre del worker cuando realmente vence una operación ya ejecutándose cuyo resultado no se conoce; no se oculta ese fallo.

La cola limita a uno los cálculos simultáneos. Las velas se archivan en lotes de hasta 500 y 2 MiB, ajustados al límite del mensaje; cada lote y cada conjunto de resultados/indicadores se confirma en una transacción. El RSS complementario tiene su propia operación `news.supplemental`, separada de la descarga primaria. Su archivo cede el turno entre lotes de 100 y se espera antes de publicar el snapshot. La telemetría registra las etapas de adquisición, proyección y complemento RSS.

Market Quotes ahora consulta Yahoo directamente y devuelve su OHLCV sin esperar a SQL. El backend conserva cache acotado, fecha de adquisición y carácter observado; archiva los datos y sus indicadores después. Búsqueda de símbolos y cotizaciones siguen usando la misma librería. Los historiales y análisis SQL permanecen disponibles; `source=stored` mantiene el contrato local anterior. Ver [flujo Yahoo y archivo](news-sql-pipeline.md#yahoo-y-velas-adquisición-directa-archivo-posterior).

Prueba conjunta, sobre una copia de 35.322 artículos en el volumen real: salud, las dos gráficas Yahoo, las cuatro ventanas de condiciones y Advanced respondieron 200; noticias mostró 80 entradas de 795 candidatas diarias. NVDA/MSFT tardaron 350–391 ms, condiciones hasta 24 segundos y Advanced 29 segundos, incluyendo espera bajo esa carga. Worker `ready`, cero fallos y archivo de observaciones/indicadores confirmado. Estos resultados corresponden al proceso temporal; no certifican que el proceso activo haya cargado todos los cambios.

No se inició, detuvo ni reinició el servicio real. Para activar la revisión completa manualmente:

```sh
systemctl --user reset-failed ogid.service
systemctl --user restart ogid.service
systemctl --user status ogid.service --no-pager
tail -F /home/fedora/ogid/backend/data/logs/ogid.log
```

Recargar el navegador para cargar la petición `source=yahoo` del frontend. La unidad instalada ya utiliza el `.env` corregido; no necesita nuevas migraciones, importación o `daemon-reload` para este cambio. El supervisor puede haber reiniciado por su cuenta durante el incidente.
