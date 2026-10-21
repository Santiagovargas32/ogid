# Coordinación de procesamiento — implementación posterior a b8594d6

Punto de partida: rama feat/agentic-intelligence, HEAD b8594d64932fe05ef95af10df235a8c37f0c6419, árbol limpio. Se conserva la evidencia de auditorías anteriores; sus ensayos no validan este artefacto.

## Propietarios y criterios previos

| Operación | Disparador / propietario | Conexión / recuperación | Baseline y objetivo funcional |
| --- | --- | --- | --- |
| RSS | News collect + supplemental; BusinessRuntime/RssAggregator | Escritor único; artículos por lotes y estado por feed | Dos selectores de primarios; unificar elegibilidad y descargas en todos los modos, conservar catálogo |
| Noticias pagadas | News timer / SqlNewsPipeline | HTTP fuera de transacción; lotes de 10; cuotas persistidas | No confundir intento o corpus conservado con adquisición correcta |
| Awareness / SEC | Timers del backend, scheduler por fuente | Ingesta SQL, backoff y checkpoints existentes | Conservar procesamiento sin navegador ni modelo |
| Velas | Market timer / DailyCandleService | Proveedor y confirmación SQL por instrumento/cierre | Fallo transitorio no puede bloquear toda la sesión; éxito durable no se repite |
| Técnica / condiciones / Advanced | Mantenimiento + HTTP | Analysis readonly; persistencia por RPC al escritor; Advanced durable | Evitar recalcular/persistir por timestamp de consulta; preservar transiciones temporales |
| Outbox / agente | Worker de inteligencia | Checkpoint SQL, lease/fence, snapshots begin/page/seal | No escribir checkpoint sin avance; control admitido con margen frente a lease |
| Índice de eventos | Registro de instrumentos / páginas | Escritor, generación anterior visible | Conservar páginas y reanudación; no rebuild monolítico |
| HTTP / WS | Clientes | Proyecciones persistidas, epoch/revisión y buffers acotados | Paginación progresa bajo invalidaciones; bfcache y socket silencioso recuperan fallback |

La concurrencia de 8 corresponde a workflows que ceden durante HTTP/RPC, no a ocho transacciones SQL simultáneas. Cada conexión ejecuta SQL síncrono; lectores separados readonly/query_only, un escritor de negocio, WAL/FULL y claves foráneas conservados. No se retienen transacciones escritoras durante red.

Pruebas: fixtures aisladas para fallos y concurrencia; copia representativa exclusivamente con SQLite Backup API; arranque desde esta carpeta con npm start y base principal configurada en /srv/bitcoin. No reiniciar procesos ajenos ni alterar modelos. Fijar antes del ensayo integrado: cero duplicación de adquisiciones; cero frescura ficticia; cero outbox técnico sin cambio semántico; control < lease de 90 s; progreso HTTP bajo cambios; memoria de versiones acotada. Comparar latencias por operación y registrar cachés calientes/frías por separado. El resultado del ensayo final de 30 minutos se registra abajo; la observación de 24 h permanece pendiente.

## Cambios y ciclos

| Ámbito | Antes | Después y motivo |
| --- | --- | --- |
| RSS primario / generado | Selección primaria y rotación suplementaria por caminos distintos; comparación shadow podía descargar dos veces | Una adquisición canónica y elegibilidad persistida para legacy, shadow y canonical. El modo elige la proyección. Timer propio que no espera a análisis; conserva 66 fuentes y 435 búsquedas generadas. |
| RSS financiero en shadow | El límite de respuesta podía dejar hechos adquiridos fuera del archivo al activar visible | Retención privada durable por feed/contenido, lotes de diez; drenaje confirmado al archivo cuando la política permite hacerlo. Shadow conserva el aislamiento de la vista pública. |
| Frescura | Corpus conservado y marcas de consulta podían aparentar adquisición correcta | Intento, comprobación correcta, cambio de contenido y commit separados. Publicación antigua sigue stale aunque llegue 304; el fallo posterior invalida live aun con caché de proyección. |
| Velas diarias | Un intento fallido podía suprimir reintentos durante la sesión | Backoff por instrumento/cierre/ajuste, 30 s hasta 15 min. Confirmación durable de éxitos antes de solicitar; correcciones y fallos de persistencia siguen reintentables. |
| Ciclo de noticias | Descontar toda la ejecución podía dejar sólo 1 s entre ciclos lentos | La próxima cadencia empieza después del ciclo; no recupera ticks con ráfagas. |
| Mantenimiento | Todos los dominios cada minuto | Revisión de dependencias de noticias, Awareness, señales, mercado, investigación y velas; repite sólo cambios, fallos o transiciones reales de calendario/edad. La edad de noticias recientes conserva transición de minuto. |
| Técnica | Nuevo asOf generaba identidad persistida distinta | Identidad semántica incluye serie, parámetros, benchmark y cierre esperado; queriedAt es entrega. Cache de 64 resultados y persistencia idempotente por identidad. |
| Consumo outbox | Checkpoint reescrito aun sin eventos; un lote por tick | Sin commit vacío; hasta ocho lotes y 500 ms por tick, cediendo entre lotes. Checkpoint durable conserva recuperación. |
| Cálculos | Disparadores podían acumular entradas equivalentes | Un activo por ámbito y un sucesor reemplazable, hasta 128 ámbitos y presupuesto de bytes de la cola. Los hechos y trabajos congelados quedan fuera del coalescing. |
| Corpus y archivo | Lectura mantenida durante clasificación, ranking, filtrado y yields | Captura consistente de payloads en scratch privado; fin de transacción antes de procesamiento. Mismas ventanas y parámetros analíticos. La regresión concurrente comprueba que TRUNCATE puede finalizar mientras se filtra la versión capturada. |
| Snapshot agente | Arrays extensos antes del envío al escritor | Captura consistente en scratch por tabla y presupuesto total compartido; páginas de hasta 100 filas con objetivo 128 KB. Una fila individual puede superar ese objetivo, hasta 4 MiB. begin/page/seal cercados y limpieza paginada de builds abandonados. |
| Sincronización | Invalidaciones podían romper reiteradamente la paginación | Versiones solicitadas retenidas 60 s, hasta 16 históricas; presupuesto conjunto 64 MiB y serialización reutilizada. Recursos completos recibidos se aplican antes de reiniciar un 409. |
| Navegador | pagehide cerraba permanentemente componentes; OPEN podía ocultar ausencia de progreso | pageshow restaura API, socket, sincronización y pollers; watchdog de 60 s y fallback según estado de sincronización. Conditions cancela peticiones abandonadas y agrupa la vigente. |

## Admisión, consistencia y presupuestos

`StorageManager` clasifica control, adquisición, commit, lectura, cálculo y mantenimiento. Reserva cuatro plazas y hasta 64 KiB para control cuando el tamaño de cola lo permite. Sólo una unidad SQL ordinaria permanece despachada al escritor; workflows que esperan red y cálculo cooperativo pueden coexistir para que sus RPC de persistencia progresen. Se conserva un cálculo CPU simultáneo. Renovaciones tienen prioridad; el resto del control cede por ráfagas para evitar starvation de negocio.

El lector analítico admite dos unidades: como máximo un snapshot en fase cooperativa y un cálculo CPU. La captura síncrona termina antes de enviar páginas al escritor; esperar esas páginas no monopoliza la admisión analítica. No se crea otro lector ni escritor. La atribución de CPU del hilo se omite si hay comandos solapados, evitando imputar el trabajo de otro comando.

Las adquisiciones cooperativas tienen cuatro plazas propias dentro del máximo de ocho unidades del escritor. Esperar el RSS compartido desde dos disparadores no ocupa todas las plazas para otras fuentes. Se mantienen límites separados para cálculo y SQL ordinario, y una plaza activa reservada para control. El límite de dos tareas lentas se conserva para trabajo no adquisitivo.

Presupuesto de heartbeat: renovación cada 20 s, cola SQL hasta 35 s, ejecución hasta 5 s; HTTP interno hasta 50 s **total**, incluyendo como máximo una repetición de la renovación cercada. Con margen de 10 s: 20 + 50 + 10 = 80 s < lease de 90 s. Los demás cambios de estado y publicaciones no se repiten automáticamente. La prioridad no puede interrumpir una sentencia SQLite síncrona: si ésta excede el presupuesto, la admisión/cancelación y el fence deben fallar sin publicar, no prometer renovación garantizada.

`FrozenRows` limita scratch a 512 MiB y cada fila a 8 MiB, lectura incremental de 64 KiB y eliminación normal en finally. La captura del corpus verifica 30 s por fila; preparación del snapshot verifica 15 s por evidencia. Exceder presupuesto produce error explícito, nunca un resultado analítico recortado. Estos límites cooperativos no interrumpen una única sentencia SQL larga ni una muerte abrupta del proceso; en ese caso puede quedar scratch privado huérfano. No hay una segunda base de negocio ni conexión escritora nueva.

No se añade migración: esquema 018, generaciones activas, leases y fences conservados. Los lectores siguen readonly/query_only; las mutaciones vuelven al único escritor. El índice de eventos conserva su generación anterior hasta completar la siguiente.

## Comparación medida

Equipo observado: Ryzen 5 4500, 12 CPU lógicas, 16,64 GB RAM, Node 22.23.3, SQLite 3.53.4, better-sqlite3 13.0.3. La base original tenía 4.534.497.280 bytes y esquema 18. Se creó `/srv/bitcoin/ogid/validation/20261020-processing/candidate.sqlite` con SQLite Backup API en 84.076 ms; no se copió el fichero activo ignorando WAL.

Baseline `b8594d6` extraída en `/tmp`; candidato ejecutado desde esta carpeta. Tres pasadas por versión sobre la misma copia antes del ensayo integrado, asOf fijo `2026-10-20T17:35:23.444Z`, ventana de 48 h y mismos límites. Cachés del host sin vaciar: primera pasada y dos pasadas calientes en proceso; no representan disco frío. Muestras y planes en [processing-measurements.json](processing-measurements.json).

| Medida | Baseline | Candidato |
| --- | ---: | ---: |
| Filas escaneadas / elegibles / mostradas | 3897 / 3825 / 100 | 3897 / 3825 / 100 |
| Transacción lectora, tres pasadas (ms) | 2384 / 1804 / 1965 | 114 / 58 / 54 |
| Duración total mediana (ms) | 1966 | 2023 |
| Análisis / outbox con dos consultas técnicas idénticas | 2 / 2 | 1 / 1 |
| Escrituras de checkpoint en diez consumos vacíos | 10 | 0 |

La mediana de retención de la transacción baja aproximadamente 97%; el coste total de proyección sigue alrededor de 2 s. Se capturan 9.574.765 bytes. El hash de selección y riesgo coincide en las seis pasadas: `07e85feb078b582237742e5729dfe2a7dd4d9cf483b071be1088c0ee9381181f`. Ambas consultas usan el covering index `articles_projection_window`; no se justifica otro índice. Tres muestras no permiten estimar p95/p99 ni concluir una mejora general de memoria.

## Configuración y operación

`backend/.env` local revisado, ignorado por Git y sin credenciales en este informe:

- Base principal: `/srv/bitcoin/ogid/db/ogid.sqlite`.
- OpenCode: `/home/fedora/ogid/backend/data/agent-runtime/bin/opencode`.
- Runtime y manifiesto: `/home/fedora/ogid/backend/data/agent-runtime` y `models.json` dentro de él.
- llama.cpp: `http://127.0.0.1:8080/v1`; se conserva el servidor existente y el modelo residente `gpt-oss-20b`. Consulta autenticada del inventario: HTTP 200, nueve alias.
- Broker / OpenCode / worker: `AGENT_BROKER_ENABLED=on`, `AGENT_OPENCODE_ENABLED=on`, `AGENT_WORKER_ENABLED=on`; `AGENT_MODE=shadow`, sin overrides de tareas visibles. URLs operativas `127.0.0.1:4097` y `127.0.0.1:4096`.

Arranque único: `cd backend && npm start`. El backend controla sus hijos; no se introducen servicios del sistema. Para detener, SIGTERM al backend y esperar su drenaje. No matar conexiones ni procesos ajenos.

Diagnóstico: `/api/health` muestra estado/colas/comandos y tiempos de escritor, analysis y queries; `/api/health/ready` expresa disponibilidad; `/api/admin/agent` requiere el token de administración. RSS expone elegibilidad y resultado por feed, comprobación/contenido/commit y motivos de aplazamiento. Comprobar revisiones/checkpoints y progreso, además de HTTP 200. Separar errores de proveedor de errores SQL; un worker recuperado no acredita ausencia de timeouts.

Recuperación: esperar al backend para reconciliar trabajos durables y reanudar índices/consumidor; un snapshot sin seal no se publica. Una respuesta de commit perdida se reconcilia por identidad durable, no por repetir a ciegas la mutación. En rollback de código, cerrar primero, conservar base/WAL y volver a la revisión anterior compatible con esquema 18. Los checkpoints y campos JSON adicionales no requieren downgrade SQL; no borrar tablas, generaciones ni la base para recuperar. Los archivos privados `rss-held:*` pertenecen al nuevo drenaje: volver a esta implementación antes de cambiar shadow a visible si quedan pendientes.

## Validación y límites

Las regresiones cubren adquisición única en los tres modos, fallo/frescura, 200 vacío y 304, retención financiera de 205 artículos con preview de uno y reinicio, backoff diario, sucesor más reciente, límite de bytes, técnica sin outbox duplicado y transición temporal, mantenimiento por dependencias, reserva de control, captura concurrente, snapshots cercados, paginación bajo cambios y restauración bfcache/watchdog. Se mantienen las pruebas existentes de idempotencia, generaciones, lectores, cancelación y drenaje.

Comandos ejecutados desde `backend`: `npm run check` (correcto) y `npm test` (**930/930**, cero fallos, 87,8 s en el artefacto final). La suite dirigida de coordinación/SQL/WS pasó 65/65 antes del último caso añadido. `git diff --check`: correcto. Desde `integrations/ogid-mcp`: `npm run check`, `npm test` (29/29) y `npm run inventory:check` (81 rutas / 90 operaciones). No se han modificado sus contratos ni su inventario.

El ensayo integrado usa `npm start` desde el backend real, copia SQLite en `/srv/bitcoin`, runtime/manifiesto/mercado propios, puertos 3330/14996/14997 y llama residente. Incluye adquisición, mantenimiento, agente shadow, HTTP y WS con `StateSynchronizer` de Node. No sustituye una prueba manual en un navegador real.

El intento `integrated-01` se interrumpió al preparar ajustes finales: 105.690 ms observados, no válido para 30 minutos, con cambio de artefacto detectado. Una llamada Conditions tardó 37,7 s; conserva el deadline analítico existente de 275 s, y la latencia interactiva sigue siendo una limitación por medir, no una mejora acreditada. Las ejecuciones interrumpidas no se suman.

`integrated-02` se cerró al corregir la transacción del archivo. En `integrated-03`, el snapshot retuvo la única plaza analítica durante sus esperas de RPC; forecasts y Advanced agotaron 90 s en cola, con lector aún vivo y renovaciones del lease progresando. Ese hallazgo motivó la admisión cooperativa descrita arriba y su regresión específica; este intento tampoco acredita 30 minutos ni ausencia de timeouts.

`integrated-04` sí completó 1.808.136 ms del mismo artefacto y cerró todos sus procesos, con 384 actualizaciones del cliente sin errores, cero recuperaciones y una publicación shadow nueva. El análisis final de ventanas de comandos encontró **un** `sources.run` expirado en la cola del padre a los 90 s, aunque no había error correspondiente del worker. La causa era compartir las dos plazas lentas con RSS/news; se corrigió con la admisión separada y su regresión. Este ensayo no valida el artefacto posterior. Evidencia conservada en [processing-integrated-04-result.json](processing-integrated-04-result.json).

`integrated-05` encontró otra regresión introducida por el spool: al capturar clusters y miembros alternados en un único archivo, cambiar de tabla vaciaba el lote y generaba miles de commits de una o dos filas. Un snapshot global expiró tras 300 s con 378 páginas, pese a tener sólo 2220 evidencias previstas; el lector se recuperó y el parcial siguió sin ser publicable. Se interrumpió el ensayo y se separaron los archivos por tabla, manteniendo un presupuesto **total** de 512 MiB. La regresión de 1000 clusters exige que se conserven los lotes, además de consistencia y cancelación. Evidencia en [processing-integrated-05-result.json](processing-integrated-05-result.json).

Comprobación del arreglo con los workers reales y sin inferencia: un snapshot global de 2309 evidencias, 2145 noticias y 2108 clusters quedó sellado en **27,87 s**, con **81 páginas** (37 evidence / 22 clusters / 22 members) y captura consistente de **2,12 s**. Máximo 100 filas por página; la fila individual mayor generó una página de 272.334 bytes, dentro del límite individual. No es una comparación estadística entre el mismo corte temporal; sí reproduce la ruta global y demuestra que dejó de producir un commit por fila. El trabajo de validación propio quedó cancelado; no se reclamó ni modificó trabajo ajeno. [processing-snapshot-batching.json](processing-snapshot-batching.json).

## Resultado del artefacto final

`integrated-06`, iniciado desde esta carpeta con `cd backend && npm start`, completó **1.800.114 ms continuos** después de readiness. Inicio UTC: `2026-10-20T23:27:47.818Z`; readiness `23:28:16.159Z`; último muestreo `23:58:16.277Z`; cierre y drenaje terminados `2026-10-21T00:01:18.627Z`. SHA-256 de los archivos JS de backend/frontend (excluidas pruebas) antes y después: `3ad853a74c44c738537575edb48dcd6e67f82c935784604ecd6072692482b5ec`. No hubo cambios de código durante esta ventana. Las ejecuciones anteriores no se suman a su duración.

El ensayo reutilizó la copia consistente de SQLite con el progreso durable de pruebas anteriores; los contadores iniciales y finales están registrados. No representa una copia recién restaurada ni un arranque con cachés del host vacías. Fuente de métricas sanitizadas: [processing-integrated-result.json](processing-integrated-result.json); evidencia privada completa en `/srv/bitcoin/ogid/validation/20261020-processing/integrated-06/`.

| Resultado observado | Valor |
| --- | ---: |
| Muestras de disponibilidad / muestras con endpoints no disponibles | 27 / 0 |
| Cliente Node: actualizaciones / páginas / heartbeats / errores | 277 / 3298 / 127 / 0 |
| Recuperaciones analysis / queries | 0 / 0 |
| Expiraciones del padre observadas | 0 |
| `sources.run`: completadas / fallidas, espera máxima | 15 / 0; 1,583 s |
| Renovaciones: completadas / fallidas, espera máxima | 88 / 0; 4,067 s |
| Renovaciones: ejecución p50 / p95 / máxima | 84 / 573 / 932 ms |
| Snapshots: completados / fallidos | 5 / 0 |
| Snapshot: ejecución mediana / máxima bajo carga | 38,55 / 132,19 s |
| Captura consistente máxima de snapshot / máximo de evidencias | 7,52 s / 2307 |
| Propietarios escritores al operar / después del cierre | 1 / 0 |
| Snapshots parciales vinculados / publicados al cierre | 0 / 0 |
| RSS del proceso backend: mínimo / máximo muestreados | 794 / 2025 MB |
| WAL máximo observado cada cinco segundos | 12,82 MB |

Las ventanas de comandos recientes se muestrearon cada cinco segundos: estos percentiles no son una traza exhaustiva. Los 27 muestreos de heartbeats mostraron edad máxima de 5,42 s para el escritor, 20,28 s para analysis y 5,90 s para queries. El cálculo síncrono todavía retrasa el heartbeat analítico; no se interpreta ausencia de recuperación como prueba de ausencia de bloqueo breve. El primer muestreo del worker de inteligencia fue stale durante el arranque; las muestras siguientes registraron conexión.

| HTTP (14 consultas por endpoint, todas 200) | p50 | p95 / máximo |
| --- | ---: | ---: |
| Noticias | 2,95 s | 5,32 s |
| Awareness | 0,24 s | 21,68 s |
| Conditions, 240 min | 6,42 s | 63,20 s |
| Advanced | 0,53 s | 8,42 s |

Con sólo 14 consultas, p95 y p99 coinciden con el máximo empírico; no son una estimación robusta de las colas de la distribución. **La latencia interactiva de Conditions y los picos de Awareness siguen siendo una limitación real**. Se han conservado los deadlines existentes, sin alargarlos para ocultar fallos. Esta entrega no acredita una mejora general de latencia ni estabilidad de memoria de 24 h.

Durante la ventana, los artículos pasaron de 111293 a 111905; analysis_runs de 14168 a 14301; el outbox avanzó de 13368038 a 13369268 y el checkpoint terminó en 13369268. Son contadores hasta el fin del muestreo; el drenaje posterior se verificó aparte. El índice reconstruyó y activó la generación `dde273c5-86b2-44e0-8b1b-743e2703afe0`, manteniendo la anterior hasta el cambio y terminando sin limpieza pendiente.

El agente produjo **una publicación nueva en shadow** (7 → 8). Hubo un run completado, tres fallidos por contratos/calidad de salida (`AGENT_INTRADAY_DATA_REQUIRED`, `AGENT_INVALID_PUBLICATION`, `AGENT_UNKNOWN_EVIDENCE`) y uno interrumpido con `ABORT_ERR` al cerrar. Hubo además rechazos intermedios de publicación; no se aceptaron evidencias desconocidas ni invalidaciones omitidas. Esto comprueba el recorrido completo y sus barreras, no la calidad predictiva general del modelo ni una activación visible.

Cierre: `npm` terminó con código 0; backend y componentes registrados dejaron de existir. La inspección de procesos por el runtime único del ensayo no encontró descendientes; puertos 3330, 14996 y 14997 cerrados. La base original conservó revisión de noticias **237180** y último ingest `2026-10-20T17:35:23.444Z`, iguales al preflight. llama respondió HTTP 200 y conservó `gpt-oss-20b` residente. No se publicó ni desplegó la rama.

La entrega no incluye integrity_check/foreign_key_check completos de la copia representativa ni una prueba manual de bfcache en navegador real. La copia se obtuvo con Backup API; las invariantes y claves de los casos de concurrencia/cancelación se verificaron con fixtures y consultas específicas.

Observación de 24 h en shadow: **pendiente**. Con OGID ya iniciado, el observador existente se ejecuta desde la raíz con `node backend/scripts/agent-shadow-observe.js /srv/bitcoin/ogid/validation/observacion-nueva 24`; crea un directorio privado nuevo, no arranca otro backend ni cambia el modelo. Revisar disponibilidad, modo de todas las tareas, heartbeats, recuperaciones, edad de trabajos, avance del checkpoint/publicaciones, RSS y WAL, errores de proveedores y divergencia de hashes. Una ejecución completa requiere revisión de estos criterios; no equivale automáticamente a aceptación.
