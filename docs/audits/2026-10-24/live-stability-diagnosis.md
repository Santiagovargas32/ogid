# Diagnóstico de estabilidad del arranque 2026-10-24

> Actualización: el diagnóstico original se conserva como corte histórico. La implementación local posterior, el traslado y el runbook figuran al final; sus pruebas no equivalen a una nueva observación operativa.

## Alcance y resultado

Inspección del backend **en ejecución**, PID **220848**, Node **v22.23.3**.
No se ha detenido, reiniciado ni reconfigurado el backend, el observer, OpenCode,
el broker o llama.cpp. No se han enviado prompts, forzado ciclos, creado trabajos
Advanced mediante consultas de diagnóstico ni modificado la base operativa.
Las consultas directas SQLite han utilizado conexiones `readonly`,
`query_only=ON`, timeout de bloqueo de 250 ms y selecciones acotadas.

**Resultado:** el servidor está disponible, pero esta pasada todavía no demuestra
estabilidad ni funcionamiento correcto del agente. Hay cuatro problemas distintos:

1. Noticias realmente vencidas según el contrato de frescura, aunque la adquisición
   y la proyección siguen trabajando.
2. Salud agregada y badges que mezclan ejecución, calendario y calidad de datos.
3. Presión real de E/S, consultas lentas y timeouts de cola recuperados.
4. Fallos del agente por errores MCP y reutilización de una conversación anterior.

Este documento guarda el diagnóstico y la **solución propuesta**. No presenta
esas correcciones funcionales como implementadas. Durante la observación sólo se
han generado evidencias locales y este informe.

## Evidencia y corte temporal

Horas en UTC; el 24/10/2026 corresponden a dos horas más en Madrid.

- Log: `.agent-validation/shadow-backend-20261024-124100.log`.
- Prefijo analizado: **2.203.824 bytes**, desde `10:41:02.131Z` hasta
  `11:23:09.351Z`. El archivo original continúa creciendo.
- SHA-256 de ese prefijo:
  `e1c8f8b54bcabb685ccee66a34497b13f879c8992cf834c5b97fb87cb76a8c83`.
- Evidencias: `.agent-validation/live-stability-20261024/`.
  `log-analysis.json` conserva eventos, líneas y estadísticas; `health-*`,
  `runtime-*` y `pipeline-second.json` conservan las muestras HTTP;
  `database-*`, `agent-progress.json` y `opencode-tool-metadata.json`, las
  lecturas durables y metadata filtrada. No se han guardado credenciales,
  prompts ni contenidos de herramientas de OpenCode.
- SQLite operativo: `/srv/bitcoin/ogid/db/ogid.sqlite`, esquema **021**;
  `/dev/sdb1`, ext4 **rw**, disco rotacional.

## Cronología observada

| UTC | Hecho |
| --- | --- |
| 10:41:02.131 | `http_listening`: HTTP abierto, inicialización pendiente. |
| 10:41:04.289 | `storage_worker_started`. |
| 10:42:42.296 | `server_started`; inicialización de aproximadamente 100,1 s. |
| 10:42:43.040 / 10:42:47.614 / 10:43:07.171 | Broker, OpenCode y worker iniciados. |
| 10:44:32.607 | Un trabajo Advanced falla con `STORAGE_QUEUE_TIMEOUT`. |
| 10:44:35.865 | Snapshot del agente devuelve 503 `STORAGE_QUEUE_TIMEOUT`, tras 90 s en cola analítica. |
| 10:45:27.667 | Primer ciclo de mercado completado; 19 instrumentos, Yahoo. |
| 10:48:04.239 | Primer ciclo de noticias completado tras 321,9 s; `sourceMode: stale`. |
| 10:55:28.084 | Fallo aislado `gnews-network-error`; posteriormente vuelve a haber respuestas correctas. |
| 10:58:28.971 | 401 `AGENT_DEVICE_REQUIRED`: falta de autorización de dispositivo, no fallo del escritor. |
| 11:14:04 | Primera muestra: health `degraded`, readiness 200, todos los workers `ready`. |
| 11:16:33.802 | Segundo ciclo de mercado completado; duración 66,1 s. |
| 11:17:25 | Segunda muestra: health `ok`, noticias `running`, readiness 200. |
| 11:18:09.830 | `market_observations_persist_failed`, código `STORAGE_QUEUE_TIMEOUT`. |
| 11:19:45 | Advanced: 50 trabajos completados y uno fallido en este arranque; ninguno activo en ese instante. |
| 11:20:42 | Tercera muestra: mismo PID; health `ok`, readiness 200; escritor/lectores `ready`. |
| 11:21:56–11:27:49 | Lecturas adicionales de estados y sesiones existentes del agente, sin ejecutar herramientas ni inferencias. |

El prefijo no contiene caída del worker, reconciliación de escritura pendiente,
`STORAGE_OUTCOME_UNKNOWN` ni `shutdown_failed`. Esto no elimina los timeouts
aislados ni acredita continuidad de 24 horas.

## Estado de las pipelines

| Componente | Evidencia observada | Interpretación |
| --- | --- | --- |
| HTTP / readiness | Tres muestras 200, PID constante. | Disponible durante las muestras. |
| Escritor | 2.583 → 3.048 comandos completados entre 11:14 y 11:20; sin fallo de worker ni incertidumbre. | Progresa, con presión de disco. Una orden larga RSS puede seguir confirmando páginas y permitir otras operaciones. |
| Consultas | 1.177 → 1.385 comandos completados; `ready`, cero fallos registrados. | Lector disponible; esto no garantiza latencia de todas las peticiones. |
| Análisis | 222 → 239 completados; fallidos 2 → 3, sin recuperación de worker. | Hay expiraciones de cola; se recupera sin derribar el escritor. |
| Checkpoint | `PASSIVE`, `queryOnly:true`, cero fallos; 765 → 943 completados. | Funciona, pero su frecuencia merece corrección. WAL físico de 260 MB no equivale a deuda. |
| Noticias | 16 ciclos completados en el prefijo; selección llega a 100 artículos. | Adquiere y calcula, pero los datos elegibles están vencidos. |
| Acquire / normalize / classify / risk / select / impact / predictions | Completan fases; luego vuelven a `running`. | Trabajo recurrente, no prueba de bloqueo por el mero estado `running`. |
| RSS | Catálogo 501, lotes de hasta 18; errores por fuente y servicio de caché. | Disponibilidad parcial. Los contadores canonical son acumulados, no errores de esta pasada. |
| Mercado | Dos ciclos completados; siguiente ejecución tras 30 min fuera de sesión. | El monitor aplica incorrectamente una caducidad genérica de 10 min. |
| Market analysis | Completado en ambos ciclos; consultas de eventos particularmente lentas. | Principal punto de coste observado en el lector analítico. |
| Awareness | 10 fuentes active/healthy, 4 shadow/healthy y 1 shadow/polling; 4 blocked, 3 probing. | Separar admisión configurada de fallo de ejecución. Hay 982 eventos sin localización sobre 989: limitación de cobertura, no caída del proceso. |
| SEC | 20 estados de fuente healthy con éxitos de esta pasada y próxima elegibilidad. | Adquisición funcional para identidades mapeadas. No implica cubrir los instrumentos no mapeados. |
| Research awarenessEvents / scenarios | Completan ejecuciones y vuelven a programarse. | Operativos durante las muestras; scenarios llegó a 23,8 s en la primera. |
| Advanced | Resultados nuevos para scopes distintos, sin cola perpetua en las lecturas durables. | El texto `queued` no describe necesariamente el estado actual del trabajo mostrado previamente. |
| Agente / OpenCode | Heartbeat conectado, 22 jobs queued y un run activo; cero publicaciones nuevas a las 11:19:45. | Control conectado; producción del analista defectuosa. Véase el diagnóstico específico. |
| AI legacy | `AI_MODE=off`, proveedor none. | Deshabilitado por configuración, separado del agente shadow. |
| Mantenimiento | Índice activo ready; validación de velas/proyección histórica siguen paginadas y pendientes. | Progreso incompleto y aplazado por actividad de negocio, sin prueba de corrupción. |

## Por qué aparecen los estados observados

### Noticias: stale tiene una causa identificada

En `pipeline-second.json`, la proyección tiene:

- `latestGeopoliticalPublishedAt: 2026-10-24T10:50:31.000Z`.
- `lastSuccessfulCheckAt: 2026-10-24T11:09:12.114Z`.
- `projectionGeneratedAt: 2026-10-24T11:12:48.027Z`.
- `staleReasons: ["content-publication-expired"]`.
- Umbral en `runtimePolicy.news.freshnessMs`: **600.000 ms**.

`SqlNewsPipeline.getProjection()` compara la publicación del contenido elegible
con ese umbral. La proyección y la comprobación de adquisición son recientes,
pero el contenido supera los diez minutos. Recalcular o ingerir duplicados no
debe convertirlo artificialmente en fresco. Las cuotas y fallos de fuentes
influyen en la cobertura: Mediastack está agotado y GNews tiene dos fallos de red
en el prefijo; esos mensajes genéricos no distinguen DNS, TLS o conectividad.

`PipelineMonitor.run()` borra reason/error al empezar y cambia `degraded` por
`running`. Al finalizar, el wrapper de noticias vuelve a aplicar `data-stale`.
`getHealth()` agrega los estados de las etapas, no una dimensión persistente e
independiente de calidad. Por eso health puede alternar **degraded → ok →
degraded** mientras la fuente continúa stale. El dashboard muestra una sola
etapa según prioridad y puede ocultar otros motivos simultáneos.

### Mercado: falso stale entre ejecuciones previstas

El último ciclo inicial termina a `10:45:27.668Z`; el siguiente empieza a
`11:15:27.669Z`, exactamente la cadencia de **30 minutos** fuera de sesión.
El monitor usa por defecto **10 minutos** para mercado y su análisis. A las
11:14 todavía no vencía la siguiente ejecución y ambos aparecían stale.

Además, Admin calcula `nextRecommendedRunAt` como «ahora + intervalo» para
mercado. Esa hora se desplaza en cada lectura y no representa el timer real.
No debe emplearse como prueba de retraso del scheduler.

### Advanced: renovación continua y scopes distintos

`AdvancedSnapshots.prepare()` devuelve el snapshot anterior y admite otro job
si envejece **30 segundos desde `as_of`** o cambian revisiones/contexto.
El GET puede devolver `queued` antes de que el claim asíncrono comience.
Cada nueva consulta de polling vuelve a pasar por prepare.

El scope de los 18 países del dashboard publicó el corte `11:13:11.148Z` a
`11:13:38.915Z`: tardó **27,8 s**. Otros trabajos globales tardaron 33,3 s y
127,4 s. El resultado puede estar prácticamente vencido o vencido al publicarse;
el siguiente poll puede admitir otra renovación. La pantalla debe distinguir
resultado utilizable de actualización pendiente y seguir un job concreto.

Maintenance calcula el scope global `countries:[]`; el dashboard usa 18 países.
Son scopes legítimamente diferentes. No se deben sustituir uno por otro para
ocultar la espera. A las 11:21:56 había un job global running y jobs anteriores
complete; no se observa un único job perpetuamente queued.

## E/S: problema real, distinto del badge de frescura

En una ventana de **174,69 s**, `/proc/diskstats` muestra para `sdb`:

- Ocupación **99,8 %**; unas 145 lecturas y 26 escrituras por segundo.
- Sólo 1,12 MiB/s leídos y 0,28 MiB/s escritos: carga compatible con acceso
  pequeño/aleatorio, no saturación de ancho de banda secuencial.
- Espera media de lectura 12,5 ms y de escritura 33,7 ms.
- Hilos de Node observados en `folio_wait_bit_common` y `blk_mq_get_tag`.

El event loop principal presenta utilización aproximada de 1,8 % y p99 de
muestreo próximo a 21 ms; los workers sí esperan al almacenamiento. La latencia
HTTP móvil p99 de browser/otros llegó a 35,25 s. Una consulta diagnóstica de
`/api/admin/agent` agotó su límite de cliente de 12 s, sin demostrar caída del
lector ni repetirse con límites mayores.

Los **avisos** del prefijo contienen 103 SQL lentos, máximo **26.073 ms**,
y 25 commits lentos, máximo **4.614 ms**. Son muestras condicionadas por el
umbral de logging, no percentiles de toda la actividad SQL. La consulta de
eventos fuerza `events_by_time` y aplica un EXISTS por generación/instrumento;
el LIMIT de salida no limita necesariamente los candidatos examinados. También
hay lecturas de snapshots de 10–12 s y operaciones pequeñas lentas del escritor.

Memoria disponible del host: 0,76–0,91 GiB; swap de 8 GiB prácticamente llena.
llama-server tiene aproximadamente 6,1 GiB en swap. En la ventana adicional de
un segundo no hubo swap-in/out: esto señala escaso margen, pero **no prueba**
que ese instante estuviera haciendo thrashing ni explica por sí solo el modelo.
No se ha modificado ni recargado llama.cpp.

El checkpoint tiene cero fallos y deuda cero en las muestras, pese al WAL físico
retenido. `observe()` dispara por tamaño físico por encima del umbral, incluso
después de confirmarlo copiado. Una reproducción aislada, sin SQLite operativo,
produce **5 checkpoints para 5 observaciones del mismo WAL sin nuevos commits**.
Esto acredita una condición mejorable; no cuantifica qué porcentaje del 99,8 %
de E/S provoca. Los avisos de checkpoints por sí solos tampoco son fallos.

## Agente: causa localizada más allá del estado conectado

Las fases durables distinguen dos incidentes:

1. **AMD, intento fence 2:** snapshot pasa 90 s en cola y termina incomplete
   con `AGENT_INTERNAL_HTTP_503`.
2. **AMD, intento fence 3:** snapshot tarda 38,65 s; inference 139,50 s;
   termina failed con `AGENT_NO_PROGRESS`. Hay llamadas repetidas a
   `agent.evidence.chunk` con `INVALID_ARGUMENTS`. La guardia se activa por
   repetir tres llamadas terminales con el mismo input; no es una medida de
   tokens por segundo.
3. **ORCL, intento fence 2:** termina a los 30 min con `ABORT_ERR`; el tiempo
   se consume en fase inference, con una herramienta completada y cero texto.
4. **ORCL, intento fence 3:** vuelve a inference y sigue leyendo una sesión
   antigua; a las 11:24:26 llevaba aproximadamente 388 s de ejecución.

Para ORCL, la página de mensajes existentes contiene un assistant creado el
**23/10 a 19:41:07.534Z**, con una única herramienta `agent.capabilities`
completada ese día. El worker reutiliza `job.opencodeId` y el messageId derivado
únicamente de jobId. Si ese mensaje ya existe, **no envía otro prompt**, aunque
esté en otro fence y haya capturado otro snapshot. Contar herramientas de esa
conversación como progreso del nuevo intento oculta que no se ha admitido una
generación nueva. Se ha observado mediante GET; no se ha interrumpido la sesión.

Para AMD hay una segunda incoherencia que exige instrumentación específica:
los argumentos registrados de chunk son válidos contra el contrato local
actual —tipos, tamaños y formato—, pero el MCP devuelve el genérico
`INVALID_ARGUMENTS`. Una reproducción local con transporte simulado acepta
chunk correctamente. Por tanto, **no está acreditado** si el rechazo procede
del schema efectivo de OpenCode/MCP, una transformación o un contrato distinto
en el proceso. Las llamadas alternativas `agent.evidence` incluyen evidenceId,
que su contrato de listado no admite. Algunas aparecen completed en OpenCode:
el estado de transporte por sí solo no acredita una lectura de evidencia válida.

Faltan los paths/códigos saneados de validación Zod y la identidad del contrato
efectivo para cerrar esta atribución. No corresponde solucionarlo debilitando
los validadores ni añadiendo reparaciones ilimitadas.

## Solución robusta propuesta

### 1. Corregir recuperación del agente y trazabilidad MCP

- Identificar la generación por job, fence, snapshot y hash del input inmutable;
  mantener messageId estable dentro de esa generación. Un ACK perdido del mismo
  intento debe reconciliarse sin duplicar; un intento nuevo no debe esperar
  sobre un prompt de otro snapshot ni cancelar conversaciones ajenas.
- Comprobar estado durable de sesión/mensaje y actividad real antes de decidir
  continuar una generación. Herramientas antiguas no cuentan como progreso
  nuevo. Una conversación terminal/inactiva sin resultado requiere transición
  explícita y acotada, conservando owner/fence y guardias existentes.
- Registrar en errores MCP un máximo de issues con path, código y tipo esperado,
  sin valores de argumentos, cuerpos ni secretos. Exponer versión/build/hash
  del contrato realmente cargado por cada hijo, no inferirlo del checkout.
- Unificar ejemplos y descubrimiento con los contratos de listado, lookup y
  chunks. Verificar lectura efectiva del contenido y `isError`/payload de
  aplicación; `tool.status=completed` no basta para acreditar evidencia.
- Exponer en Admin fase, edad del último progreso real, herramientas válidas y
  rechazadas, generación, fence, snapshot y causa terminal del intento.
  Reutilizar las métricas ya persistidas y no modificar publicaciones congeladas.

### 2. Reducir presión de almacenamiento dentro de la arquitectura existente

- Conservar un escritor de negocio, WAL/FULL, lectores query_only y checkpoint
  separado. Mantener guardias 5/30 s y límites actuales; no elevarlos para
  ocultar consultas de decenas de segundos.
- Revisar el plan de eventos por instrumento desde los links selectivos y los
  índices existentes; preservar orden, generación publicada y paginación. Medir
  distintas selectividades antes de decidir un índice nuevo. Cargar payloads
  sólo después de acotar referencias; evitar barrer el corpus por cada símbolo.
- Activar checkpoint por progreso de commits y deuda, con una generación
  monotónica observada tras ACK, no sólo por el tamaño retenido. No usar sólo
  crecimiento del fichero: WAL reutiliza frames. Atender deuda parcial y límites
  aunque no haya crecimiento físico; coalescer disparos y mantener recuperación.
- Conservar ingestión completa y páginas confirmadas. Medir/reducir reescrituras
  de contenido sin cambios, snapshots grandes y fan-out analítico; mantener
  cuotas justas para heartbeats, persistencia y mantenimiento. Evitar una caché
  mayor sin presupuesto global, dado el margen de memoria observado.
- La persistencia de observaciones que agote cola debe dejar deuda/reintento
  durable e idempotente y estado visible. El log aislado no acredita que cada
  observación haya quedado recuperada: debe verificarse antes de darlo por resuelto.

### 3. Separar salud operativa, ejecución y calidad

- Mantener estados de ejecución, frescura y cobertura independientes, con
  causas tipadas, observadoEn y última finalización aunque haya una fase running.
  No borrar una carencia de datos al iniciar el siguiente ciclo.
- Basar puntualidad del scheduler en el timer realmente programado, calendario,
  política de proveedor y próxima elegibilidad. Mostrar mercado cerrado/espera
  prevista sin convertirlo en fallo de adquisición, preservando calidad vencida
  de las cotizaciones cuando corresponda.
- Mantener `content-publication-expired` hasta disponer de contenido nuevo
  elegible. Una comprobación 304 es adquisición correcta, no rejuvenece noticias.
- Mostrar en Admin todos los motivos actuales con origen: contenido, proveedor,
  cola, ejecución SQL, publicación, lease o configuración. Reutilizar corpus,
  activeCommands, sqlActivity y métricas existentes, mediante proyecciones
  acotadas; no recalcular historia al abrir la administración.
- Emitir logs de transiciones significativas y spans acotados con runId,
  commandId, worker, fase y espera; coalescer repeticiones. Un final de ciclo debe
  incluir estado operativo y razones de calidad por separado.

### 4. Hacer verificable el ciclo de Advanced

- Usar el coordinador y tablas actuales. Consultar estado de un job/scope como
  lectura pura; el polling de un job debe observar su publicación antes de
  admitir otro. Reutilizar `peek` para metadata, ampliándolo con resultado
  inmutable y error pertinente sin crear otra fuente de verdad.
- Separar corte de datos, validez de inputs y fecha de publicación; no cambiar
  asOf para fingir frescura. Priorizar/coalescer invalidaciones mientras calcula
  y servir el resultado anterior con su calidad y edad explícitas.
- Mostrar scope, jobId, queued/running, fase, edad de cola, ejecución, resultado
  anterior y revisiones solicitada/disponible. Mantener distintos scopes y
  recuperación durable por owner/fence; no sustituir resultados filtrados por
  resultados globales para despejar el badge.

## Verificación necesaria antes de aplicar y declarar resuelto

Ya ejecutado: reproducciones aisladas de caducidad de mercado, activación de
checkpoint por WAL retenido y validación MCP local con lectura simulada.
Están en `isolated-reproductions.json` y `mcp-isolated-validation.json`.
No se ha ejecutado carga, suites completas o escaneos de integridad contra la
base activa durante esta observación.

Para la implementación posterior:

1. Reproducir reintento ORCL, ACK perdido y cambio de snapshot; demostrar una
   generación efectiva, sin prompt duplicado ni reutilización indebida.
2. Reproducir las llamadas AMD en un proceso OpenCode 2.0.31/MCP aislado con
   contratos efectivos; verificar las causas saneadas y cero publicaciones
   cuando no se acredita lectura o falla la validación semántica.
3. Probar noticias stale durante running, 304, cuota agotada y contenido nuevo;
   mercado cerrado, timer de 30 min y retraso real; no falsear calidad.
4. Probar checkpoint sin commits, reutilización de WAL, deuda parcial,
   backpressure y recuperación, preservando disponibilidad del escritor.
5. Medir planes y latencias con un corpus representativo de al menos 140.000
   eventos, concurrencia y 50 muestras por cohorte, en copia consistente;
   mantener objetivos p95 ≤2 s y máximo ≤5 s donde correspondan al contrato.
6. Probar Advanced con cálculo más largo que TTL, polls concurrentes, scopes
   simultáneos y recuperación. Ver siempre el ACK de publicación del job seguido.
7. Ejecutar regresiones, checks e inventario apropiados tras cambiar código;
   después, nueva observación continua y revisión del modelo real.

La disponibilidad observada no permite dar por superada la siguiente shadow
24 h. Primero deben resolverse o quedar expresamente aceptados los timeouts,
la recuperación del agente y la diferencia entre frescura y salud operativa.

## Comprobación al cerrar la inspección

A las **11:33:47Z** —13:33:47 en Madrid— el PID sigue siendo **220848**.
Health responde 200 con estado **degraded** por noticias `data-stale` y mercado/
market.analysis `stale`; SEC está running. Readiness sigue respondiendo **200**.
Escritor, análisis y consultas permanecen **ready**, sin failure ni reconciliación
pendiente. El checkpoint lleva 1.268 ejecuciones, cero fallos, cero deuda en su
último resultado y backpressure false. El log sigue sin registrar una caída.
Las muestras finales están en `health-final.json`, `ready-final.json` y
`runtime-final.json`; son posteriores al prefijo fijado para las estadísticas.

`git diff --check` no comunica errores. No se han modificado fuentes ejecutables
ni configuración durante este diagnóstico.


## Implementación local posterior: corrección integral y almacenamiento

Trabajo autorizado el 24/10/2026 con backend y observer detenidos. No se han
iniciado los servicios operativos, enviado prompts al modelo real, promovido
publicaciones, realizado push/merge ni cambiado llama.cpp, CUDA o los GGUF.
Las instancias utilizadas por las pruebas tienen base, puertos y proveedores
propios. El estado Git previo y sus cambios locales se conservan.

### Relación entre requisito, cambio y evidencia

| Requisito | Implementación | Evidencia |
|---|---|---|
| Archivo verificable | Copia `rsync -aH`, inventario SHA256 antes/después, permisos y enlaces; retirada sólo tras coincidencia | `reorganization-20261024/manifest.json` y `*-files.json` en HDD |
| ComfyUI/Heroic/pip | ComfyUI completo y datos Heroic archivados; app Heroic desinstalada, referencia/commit conservados; retirada únicamente de la caché pip prevista | Manifiesto e `heroic-installation.txt`; runtimes compartidos conservados |
| Modelos y evidencias | Hugging Face completo, `.agent-validation` y mantenimiento trasladados; enlaces desde las ubicaciones anteriores | Comparación de archivos, bytes, enlaces y modos; GGUF continúan en `/opt/ai/models` |
| SQLite SSD | API backup, imagen 021 verificada, archivo consistente HDD, checksums 001–021 y recuentos de 74 tablas; 022 aditiva | `database-migration.json`, logs de staging/cutover y prueba WAL SSD |
| Lecturas de eventos | Enlaces selectivos → índice cubriente `events_identity_time` → referencias limitadas → payloads; impactos en una consulta conjunta | Planes SQL, regresiones de generación/lectura coherente y corpus de 140.000 eventos |
| Clasificación y vínculos | Caché de características hasta 2.048 entradas/4 MiB de payload; omite fechas de sondeo; conserva vínculos semánticamente iguales y actualiza procedencia/última comprobación | Prueba que prohíbe borrar vínculos durante sondeos y cambios de procedencia |
| Checkpoint | Contadores compartidos de commits y bytes estimados, incluidos autocommits; rollback excluido; primer commit pendiente conservado; coalescencia a 4 MiB/5 s; deuda parcial/reintentos | Pruebas de WAL retenido, reutilización, goteo continuo, concurrencia, presión y recuperación |
| Velas diferidas | Tipo `market-persistence` en `acquisition_jobs`; admisión durable, payload limitado, páginas de 10, cursor/commit atómicos e ID estable; recuperación paginada y reconciliación de ACK | Reinicio de workers reales, ACK perdido, 130 jobs y fallo transaccional |
| Generaciones del agente | Identidad por job/fence/snapshot/modelo/prompt/input completo; IDs y hashes de mensaje inicial/reparación persistidos antes del envío; conversación propia por generación de fondo, chat conservado | Regresiones de snapshot/fence, mensajes anteriores, ACK y única reparación |
| Acreditación MCP | Resultado de aplicación y `isError`, snapshot recibido, contenido efectivamente leído y hash de contrato; soporte real de `state.content` en OpenCode | Pruebas stdio y `opencode-mcp-regression.js` con binario 2.0.31 y modelo simulado |
| Contratos y errores | Parámetros/cuerpo elegidos por `operationId` antes de validación estricta; hasta 16 problemas saneados sin valores; hashes efectivos y prompt v1.8 | MCP, inventario 83 rutas/92 operaciones, compatibilidad de publicaciones históricas |
| Salud y calendario | Diagnóstico común `operational/quality/causes`; calidad vencida persiste durante `running`; readiness operativa; próxima ejecución del timer real | Pruebas de stale durante ejecución y cadencia de 30 min; contratos RSS 304 existentes |
| Observabilidad | Admin: SQL, cola/ejecución/progreso, checkpoint y deuda durable muestreada; logs de generación/fence/snapshot y fallos MCP/proveedor; observer acotado ampliado | Pruebas de privacidad/diagnóstico y revisión del frontend |
| Advanced | Status puro por job y scope; frontend sigue ese job sin readmitirlo durante cálculo; resultado anterior visible; owner/fence/lease y recuperación periódica de vencidos | Lectura sin escrituras, cálculo lento, scopes, polling, recuperación y rechazo de publicación tardía |
| Base esperada ausente | Guardia de volumen HDD y existencia de las rutas operativas HDD/SSD; no sustitución por base vacía | Pruebas inyectadas de volumen/base ausente |

La metadata de auditoría se fusiona durante transiciones de estado: el filtro de
salida pública no elimina la identidad canónica persistida. Se guardan IDs y
hashes de mensajes; los prompts y argumentos no se vuelcan a los logs. La
identidad MCP desconocida permanece desconocida hasta disponer de un recibo.

No se alteran 001–021 ni se ejecuta un relleno histórico completo al arrancar.
La recuperación se apoya en las tablas existentes. Los lectores continúan con
`readonly/query_only`; WAL/FULL, escritor único y guardias siguen vigentes.
El HTTP 304 actualiza comprobaciones, no la fecha de publicación del contenido.
Los datos stale pueden coexistir con un backend operativamente disponible.

### Evidencias de validación

Las evidencias completas están en HDD bajo
`/srv/bitcoin/ogid/reorganization-20261024/validation/`, accesibles también desde
`.agent-validation`. Se conservan resultados fallidos y repeticiones.

- Backend y frontend: `npm run check`; suite backend completa y regresiones
  finales dirigidas. Los resultados definitivos se registran en el cierre de este apartado.
- MCP: check, tests e inventario; transporte stdio con SDK real y OpenCode 2.0.31
  con proveedor de inferencia simulado, sin llama.cpp ni base operativa.
- Corpus SSD: 140.000 eventos, payloads de 1/4/16 KiB, 50 lecturas por cada cohorte
  y commits/heartbeats concurrentes. «Frío» significa worker nuevo y caché de
  aplicación nueva; no se vacía la caché global del sistema operativo.
- Primera pasada: p95 de 17–32 ms, máximo 519 ms; 598 commits y 649 heartbeats.
- Pasada concurrente con suite y verificación de base: p95 18–34 ms pero máximo
  5.830 ms en Admin; **no cumple** el máximo de 5 s. No se cambia el umbral ni se
  elimina esta evidencia. Se repite tras terminar esas tareas para aislar la carga.
- Prueba SSD: WAL, lector concurrente, exclusión de segundo escritor, recuperación
  de commit tras SIGKILL, rollback de transacción sin commit, integridad/FK y modos
  0600/0700. No simula pérdida eléctrica.

### Runbook de arranque y observación

Antes de iniciar, comprobar que `/srv/bitcoin` está montado y que el espacio SSD
sigue cumpliendo el margen de capacidad. Los enlaces a evidencias y Hugging Face
requieren el HDD. La base activa, WAL y SHM se mantienen juntos en SSD. No hay
sincronización bidireccional con la copia histórica HDD.

Backup consistente con OGID detenido (también incluye commits presentes en WAL):

```bash
cd /home/fedora/ogid/backend
umask 077
mountpoint -q /srv/bitcoin
npm run storage:backup -- \
  /home/fedora/.local/share/ogid/db/ogid.sqlite \
  "/srv/bitcoin/ogid/backups/pre-shadow-$(date +%Y%m%d-%H%M%S).sqlite"
```

Arranque operativo, exclusivamente mediante npm:

```bash
cd /home/fedora/ogid/backend
umask 077
mkdir -p /srv/bitcoin/ogid/logs
set -o pipefail
npm start 2>&1 | tee "/srv/bitcoin/ogid/logs/shadow-backend-$(date +%Y%m%d-%H%M%S).log"
```

Esperar `server_started` y `/api/health/ready` HTTP 200 antes de usar el navegador.
`http_listening` sólo acredita que el puerto escucha. Revisar además en Admin los
componentes gestionados, workers, errores activos y causas de calidad: los hijos
Broker/OpenCode/worker tienen su propia disponibilidad. Un estado stale no se
corrige cambiando fechas ni aumentando timeouts. Mantener el modo shadow actual.

En otra terminal, después de comprobar readiness y componentes:

```bash
cd /home/fedora/ogid/backend
umask 077
mkdir -p /srv/bitcoin/ogid/observations
npm run agent:observe -- \
  "/srv/bitcoin/ogid/observations/shadow-24h-$(date +%Y%m%d-%H%M%S)" 24
```

Usar siempre una ruta nueva. Ni backend ni observer se han dejado iniciados.
Una observación completada no acredita por sí sola continuidad: revisar PID,
reinicios, readiness, intervalos sin muestras, workers, deuda, checkpoints y
publicaciones. Las 24 horas y la revisión semántica del modelo real siguen siendo
la validación operativa posterior.

### Rollback lógico conservando las escrituras nuevas

1. Detener OGID y observer con sus terminales; conservar llama.cpp.
2. Exportar **la base SSD actual** con `npm run storage:backup` a una nueva ruta
   HDD, por ejemplo `db/ogid-rollback-<fecha>.sqlite`. Verificar el resultado.
3. Cambiar sólo `STORAGE_DB_PATH` a esa exportación consistente y utilizar código
   compatible con esquema 022. No borrar columnas ni editar checksums/migraciones.
4. Arrancar mediante `cd backend && npm start`, comprobar readiness y revisión de
   las publicaciones. No apuntar al origen anterior al traslado si hubo nuevas
   escrituras en SSD ni restaurar publicaciones antiguas sobre las nuevas.

La copia histórica original y el backup previo a 022 se mantienen. La copia
privada de `.env` anterior al traslado está en el archivo protegido del HDD;
no debe copiarse al repositorio ni imprimirse en logs.


### Cierre físico y resultados de entrega

- Base activa: `/home/fedora/.local/share/ogid/db/ogid.sqlite`, **022**,
  `integrity_check=ok`, FK=0, modo 0600 y directorio 0700. Los checksums 001–021
  coinciden con el origen; se conservan los recuentos de las 74 tablas (salvo la
  fila añadida a `schema_migrations`), incluidas **99 publicaciones históricas**.
- `.env` conserva exactamente el contenido anterior salvo `STORAGE_DB_PATH`.
  Original HDD intacto: `/srv/bitcoin/ogid/db/ogid.sqlite`. Backup consistente 021:
  `/srv/bitcoin/ogid/reorganization-20261024/pre-022-consistent.sqlite`.
- SHA256 del backup previo a 022:
  `08851d91da05f1d811eee7b7e969890223f82b3bd0ad796b066bfc1de89f34e3`.
  El hash de la imagen 022 y los recuentos completos figuran en el manifiesto privado.
- SSD: **45,88 GiB disponibles (20,76 %)** después del traslado y de retirar los
  fixtures de volumen. Se cumple el mínimo del 20 %. La recuperación física
  observada es menor que la estimación lógica de 45–50 GiB; las cifras de `du`
  no se han sumado como espacio liberado de Btrfs. No se han borrado snapshots,
  modelos activos ni backups anteriores para alcanzar el margen.
- Enlaces de Hugging Face, evidencias, mantenimiento y logs históricos comprobados;
  cero enlaces rotos en Hugging Face. GGUF permanecen en SSD (142 GiB lógicos).
  ComfyUI y datos Heroic están archivados; Heroic retirado, sin limpieza de runtimes.
- Volumen final **aceptado**: 140.000 eventos, 50 muestras en cada cohorte; p95
  Admin frío/caliente **67,12/17,61 ms**, eventos frío/caliente **36,32/31,12 ms**;
  máximo conjunto **692,13 ms**. Heartbeats p95 **15,00 ms**, máximo **117,40 ms**.
  **565 commits**, **615 heartbeats**, 50 recuperaciones de lector; cero RPC a
  proveedores por lecturas administrativas. RSS máximo muestreado del proceso
  de prueba 351,5 MiB; event loop p95 10,67 ms/máximo 24,20 ms.
- La prueba final usa generación de commits, deuda y telemetría de esta versión.
  `samples.json` conserva los tiempos individuales. Las pasadas anteriores,
  incluida la que falló bajo carga de verificación, permanecen archivadas.
- Evidencia de cierre:
  `.agent-validation/integral-correction-20261024/physical-delivery.json`,
  `ogid-ssd-finalize.log`, `ogid-opencode-generation-final.log`, suites y checks.
  Métricas completas: `.agent-validation/integral-volume-20261024-delivery/`.

La verificación completa de una imagen de 6,9 GB es trabajo de mantenimiento
intensivo y tardó varios minutos en este Btrfs con compresión. El helper de
backup limita ahora su caché de verificación a 128 MiB. El resultado de 5,83 s
bajo verificación/suite concurrentes sigue siendo una limitación observada; el
benchmark controlado no acredita un SLO bajo cualquier carga del equipo.

La continuidad de 24 h, la disponibilidad de proveedores reales y la revisión
semántica del modelo real están pendientes de la ejecución operativa del usuario.


Validación final terminada: **backend 1.023/1.023**, **MCP 30/30**, check de
backend/frontend y MCP correctos, `inventory:check` **83 rutas/92 operaciones**,
y `git diff --check` sin errores. La regresión con binario OpenCode 2.0.31 acepta
los IDs reales de generación, acredita el chunk válido y rechaza el inválido.
Comprobación final de procesos: backend, observer, OpenCode y broker operativos
detenidos; únicamente llama.cpp conserva su puerto habitual entre esos servicios.
