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

## Seguimiento de la nueva prueba shadow: corte del 24/10 a las 19:19

Este apartado corresponde al arranque posterior a la entrega anterior. **Backend
y observer están ejecutándose y no se han detenido, reiniciado ni reconfigurado
durante esta inspección.** Es un diagnóstico y un plan pendiente de implementación.
Las horas de las tablas son de Madrid (UTC+2); los artefactos usan UTC.

### Identidad, alcance y evidencia

- Rama `feat/agentic-intelligence`, commit local
  `3ac9a1abf7b0bccd731d6c9b96776fc4aae07eea`. No se ha creado otro commit ni
  publicado nada durante este seguimiento.
- Backend PID **271599**, iniciado el **24/10 a las 15:48:56**.
  Log examinado: `.agent-validation/shadow-backend-20261024-154856.log`.
- Observer existente: `.agent-validation/shadow-24h-20261024-155002/`, iniciado
  a las **15:50:03**. Sus archivos originales sólo se han leído.
- El proceso arrancó sobre un checkout sucio que aún declaraba `fcd1ca5`.
  El hash de archivos capturado al iniciar coincide con el calculado ahora sobre
  los archivos incluidos por `buildIdentity.js` del commit `3ac9a1a`:
  `bebaf9fa5dc1ecafd450ab79b2ecd033242e25082eb014da92894ee7aae9bd87`.
  Esto acredita coincidencia de esos archivos; no constituye una atestación de
  todo el entorno ni de las variables del proceso.
- SQLite consultado: `/home/fedora/.local/share/ogid/db/ogid.sqlite`, abierto con
  `readonly`, `fileMustExist` y `query_only=1`. Consultas limitadas a registros del
  agente y cuatro proyecciones de noticias mediante índice por tipo y fecha.
  No se ha consultado `admin/history`, ejecutado verificaciones integrales de la
  base ni provocado adquisiciones, cálculos, trabajos o inferencias.
- Se consultaron readiness/runtime y cuatro conversaciones **ya terminadas** de
  OpenCode mediante GET acotados. No se exportaron prompts, razonamientos,
  respuestas, argumentos completos, cuerpos de noticias ni credenciales.
- Evidencia saneada con cortes explícitos:
  `.agent-validation/live-followup-20261024-191921/evidence.json`.
  El prefijo fijo del log analizado contiene **15.781.594 bytes**, SHA256
  `6c26b3f70264a17b6a027a5234b55deaf88f89ac3ee777722c5fa99889569b49`.
  El log continúa creciendo; el hash identifica sólo ese prefijo.

### Noticias: causa exacta del registro de Admin

La alerta es reproducible en los registros persistidos. La política efectiva
`news.freshnessMs` es **600.000 ms (10 minutos)**, en
`backend/config/runtimePolicy.js`. `SqlNewsPipeline.getProjection` compara ese
umbral con **la publicación geopolítica elegible más reciente**, y comprueba por
separado la antigüedad del último chequeo satisfactorio al proveedor. No usa la
fecha de proyección ni la última ingesta como sustituto de la publicación.

| Proyección persistida | Último contenido geopolítico | Comprobación | Revisión | Calidad |
|---|---|---|---:|---|
| 19:03:51.283 | 18:43:13 | 19:03:33.071 | 282522 | stale |
| **19:04:07.099** | **18:43:13** | **19:03:33.071** | **282522** | **stale** |
| 19:05:12.403 | 18:43:13 | 19:05:11.937 | 282631 | stale |
| 19:06:33.863 | **18:58:40** | 19:06:15.133 | 282675 | **live** |

El segundo registro reproduce exactamente las fechas aportadas por el usuario.
El contenido tenía **20 min 54 s** y el chequeo sólo **34 s**. La causa era
`content-publication-expired`, sin `acquisition-check-expired`. Hubo ingestas y
nuevas revisiones sin una publicación geopolítica suficientemente reciente.
`SqlNewsCorpus.scan` calcula ese reloj antes de la selección editorial, sobre la
rama geopolítica con países reconocidos; no representa toda noticia financiera
ni la novedad de los artículos que finalmente aparecen en pantalla.

El log termina correctamente ciclos a las **19:04:03**, **19:04:15** y
**19:05:35**, conservando `stale`. A las **19:06:41.387** termina el primer ciclo
`live` de esta recuperación: ya se había incorporado contenido de las 18:58:40,
con menos de ocho minutos de antigüedad al calcularlo. La desaparición de la
alerta corresponde a ese cambio de contenido; la evidencia no permite
atribuirla al WebSocket. Una comprobación HTTP o un 304 satisfactorios no cambian
por sí solos la fecha de publicación.

`DATA_STALE`, `content-publication-expired` y `provider-data-stale` describen aquí
la misma condición desde el monitor de pipeline, el corpus y `dataQuality`.
No son tres averías distintas. **Operación `ok` y calidad `degraded` son
compatibles**: la pipeline acaba su trabajo y devuelve datos cuya publicación
supera el umbral. Las muestras de las 19:05 y 19:06 conservan la causa incluso
con la etapa `running`; el nuevo ciclo no rejuvenece automáticamente los datos.

En el prefijo examinado hay **318 ciclos terminados: 163 stale y 155 live**.
Son conteos de ciclos, no porcentajes de tiempo ni una prueba de errores de
adquisición. La inspección de las 19:15:10 muestra operación/calidad `ok`, y la
última proyección leída a las 19:16:41 usa contenido de las 19:10:49 y es `live`.

### Agente: resultados de esta ejecución, separados del histórico

El corte SQL es **24/10/2026 19:19:21.519**, desde el arranque del backend.
Los estados se leyeron en una transacción de lectura corta. Se cuentan
ejecuciones por `(job_id, fence)` y publicaciones durables por fecha; no líneas
de log ni herramientas simplemente marcadas como terminadas.

| Medida | Resultado al corte |
|---|---:|
| Ejecuciones iniciadas | **111** |
| Ejecuciones completadas válidas | **0** |
| Publicaciones nuevas aceptadas | **0** |
| Ejecuciones fallidas | **110** |
| Ejecución activa (`waiting-model`, fase `inference`) | **1** |
| Trabajos nuevos todavía en cola | **22** |
| Respuestas de chat completadas en este arranque | **0** |
| Publicaciones históricas conservadas | **99** |

La última publicación histórica es del **23/10 a las 18:28:30.656**. Ninguna de
esas 99 corresponde a esta prueba. Los 110 fallos se distribuyen en **95**
`instrument_outlook`, **5** `global_intelligence_brief`, **5**
`geopolitical_alert_assessment` y **5** `market_outlook_global`.
No hay ejecuciones nuevas de trabajos creados antes del arranque. El observer
comenzó unos tres segundos después del primer run, por lo que su `sinceCounts`
puede omitir ese primer intento; aquí el límite es el arranque del backend.

| Código final | Ejecuciones | Interpretación |
|---|---:|---|
| `AGENT_NO_PROGRESS` | **106** | Repetición de llamadas con los mismos argumentos hasta la guardia de tres repeticiones. No significa timeout de SQLite. |
| `AGENT_TOOL_EVIDENCE_REQUIRED` | **3** | La propuesta inicial y la única reparación no acreditaron una lectura válida de evidencia; publicación rechazada. |
| `AGENT_OPENCODE_TURN_FAILED` | **1** | Turno terminal fallido de OpenCode; error `provider.internal`, con estado HTTP registrado 200. El detalle saneado no permite identificar una causa de red o del modelo más precisa. |

Las **110 ejecuciones fallidas tienen cero herramientas acreditadas como
satisfactorias**. En todas consta un último fallo MCP `INVALID_ARGUMENTS`, en
validación de parámetros de `agent.evidence` o `agent.evidence.chunk`.
Dieciocho ejecuciones alcanzaron la reparación; se registran 21 candidatos
presentados a validación en total. Estos candidatos no son respuestas válidas.

La inspección de cuatro conversaciones terminadas confirma el defecto de forma:
`snapshotId` llega como objeto con claves `$type/value`, `$ref`, `$oid`, un
objeto vacío o un objeto anidado; `domain` y `limit` también aparecen como objetos.
Sus contratos requieren una cadena para los dos primeros y un número para el
último. Se observó además `evidenceId` en `agent.evidence`, donde no se admite;
su lectura individual pertenece a `agent.evidence.chunk`.
Se registraron sólo nombres de campos y tipos, sin sus valores.

El esquema expuesto por `ogid_query` usa
`parameters: z.record(z.string(), z.unknown())`: su JSON Schema termina en
`additionalProperties: {}`. El ejecutor sí selecciona el contrato de la
operación antes de validar; esa corrección previa funciona y rechaza los datos
mal formados. **Falta expresar los tipos concretos de cada operación al modelo**.
El registro prueba dónde falla la llamada; atribuir el origen exacto de cada
objeto al modelo, la conversión de herramientas o el transporte requiere una
reproducción aislada que capture esos límites.

Todas las ejecuciones fallidas declaran prompt **v1.8**, contrato **1.8.0** y
hash `15793c865cd56650021fc745df7a32d7b9ae3b7e08369205fbd0b2d77d779bd9`.
El worker aún no acredita un hash MCP a partir de una lectura válida. El conector
externo de esta sesión anuncia contrato 1.6.0 y otro arranque; es un proceso
distinto del MCP gestionado por OpenCode y no prueba que éste esté desactualizado.
No se ha reiniciado ninguno.

La ausencia de publicaciones demuestra que las guardias están impidiendo
publicar sin evidencia. **No demuestra que el agente funcione correctamente**:
en esta pasada todavía no ha conseguido emitir una respuesta válida.

### Estabilidad operativa observada y límites

- En el corte del observer de las **19:16:34**: **207 muestras**, aproximadamente
  **3 h 26 min**, cero muestras indisponibles, cero cambios de backend, cero
  desconexiones del worker y cero recuperaciones de lectores. Sigue `observing`;
  `completedObservation=false`.
- Las 207 muestras mantienen operación `ok`; 115 indican calidad `degraded` y
  92 calidad `ok`. No equivalen a una prueba continua de todos los endpoints.
- Readiness y runtime respondieron 200 a las 19:15:10; escritor, análisis y
  consultas estaban `ready`, con **cero operaciones fallidas** de almacenamiento.
  WAL retenido: 90.046.752 bytes; última deuda pendiente cero, sin backpressure
  y sin fallos de checkpoint. Su tamaño físico no es deuda por sí solo.
- Hay una muestra con heartbeat de **consultas** demorado **16.383 ms**, a las
  19:11:32, con `awareness.getSnapshot` ejecutando y un `agent.read/run` esperando.
  No produjo recuperación ni caída observada. El contador agregado del observer
  incluye los tres workers, aunque se llame `storageHeartbeatDelayedSamples`.
- El log contiene 21 avisos de SQL lento (máximo **5.202 ms**) y siete commits
  lentos (máximo **6.840 ms**). No se ha medido aquí un p95 ni reproducido carga:
  estos avisos impiden declarar satisfecho un SLO de latencia sólo por readiness.
- RSS máximo muestreado del backend: **1,72 GiB**; de hijos gestionados, **535 MiB**.
  Son máximos observados, no una prueba de fuga ni una garantía para 24 horas.
- Hay un fallo de fuente `awareness-fed-releases` con HTTP 404 y tres rechazos
  de acceso `AGENT_DEVICE_REQUIRED`, independientes de la caducidad de noticias.
- El diagnóstico común actual informa disponibilidad y calidad de sus dominios,
  pero no convierte la falta de publicaciones del agente en una causa explícita.
  Un worker conectado y un health global `ok` no acreditan su productividad.

### Plan de corrección posterior, sin aplicarlo durante esta observación

1. **Reproducir el fallo MCP con el transporte completo.** Usar fixtures saneados
   de las formas detectadas y OpenCode 2.0.31 en una instancia aislada. Capturar
   esquema ofrecido al modelo, forma/tipos de argumentos al entrar en OpenCode,
   al salir hacia MCP y resultado del validador. Comparar con llamadas primitivas
   correctas. Separar transporte simulado de una evaluación posterior del modelo
   real. Un test con argumentos correctos prefabricados no verifica que el modelo
   pueda generarlos.
2. **Tipar las herramientas del perfil `agent-evidence`.** Exponer herramientas
   concretas para catálogo, chunk y clusters, generadas desde los contratos
   compartidos y con sus campos tipados en el esquema visible. Reutilizar el mismo
   ejecutor, autorización y proyección. Conservar `ogid_query` para compatibilidad
   general, pero evitar el mapa de valores desconocidos como interfaz principal
   de este perfil. Actualizar allowlist, prompt versionado, capabilities e
   inventario juntos. No reintroducir la unión ambigua de parámetros ni convertir
   automáticamente `$ref`/objetos en IDs, cadenas o números.
3. **Acreditar contrato y progreso, conservando las guardias.** Verificar identidad
   de backend/worker/MCP antes de inferir, también en respuestas de error, sin
   depender del primer recibo satisfactorio. Conservar snapshot, fence, identidad
   de generación, mensajes idempotentes, la única reparación y el rechazo sin
   lectura real. Clasificar repetición de argumentos inválidos como causa MCP
   concreta, además de la terminación por falta de progreso. Introducir una
   espera acotada y visible por modelo/contrato ante fallos sistemáticos, con
   recuperación verificable y sin borrar cola, evidencia ni historial. No elevar
   `maxToolRepeat`, deadlines o leases para ocultar el problema.
4. **Hacer visible el resultado funcional del agente.** Publicar en Admin un corte
   explícito por arranque/intervalo, intentos por fence, candidatos iniciales y de
   reparación, lecturas acreditadas, publicaciones nuevas, fallos por causa y
   antigüedad de la última publicación. Separar sus 99 publicaciones históricas.
   Conservar disponibilidad del proceso como dimensión operativa y mostrar su
   calidad/productividad por separado, aunque siga conectado.
5. **Aclarar noticias sin falsear frescura.** Mostrar «última publicación
   geopolítica elegible», antigüedad, umbral de 10 min, ámbito y `evaluatedAt`, junto
   al último chequeo/commit/ciclo y la revisión de la proyección. Agrupar las tres
   etiquetas actuales bajo una causa canónica con sus procedencias. Mantener
   separados estado de ejecución, disponibilidad y calidad. Mantener la causa
   durante `running` y hasta contenido nuevo elegible. Un 304, una ingesta, un
   recálculo o una entrega WS no pueden rejuvenecer publicaciones.
6. **Verificar coherencia temporal de Admin y WS.** Consumir un mismo corte y
   revisión para causas, contenido y pipeline, rechazando respuestas anteriores.
   Probar el paso por el umbral sin contenido nuevo, chequeos 304, contenido nuevo
   financiero sin novedad geopolítica, ingesta tardía, ciclos concurrentes y
   reconexión WS. No se ha demostrado una carrera WS en esta incidencia. Evaluar
   una política diferenciada por ámbito/horizonte sólo con evidencia posterior;
   no aumentar globalmente el TTL para conseguir un indicador verde.
7. **Conservar trazabilidad y vigilar las latencias residuales.** El lifecycle de
   hijos resume ahora stdout/stderr en códigos y suprime repeticiones; por eso el
   log principal no contiene cada `agent_generation_failed` ni cada fallo MCP.
   Reenviar únicamente eventos estructurados permitidos, acotados y correlacionados
   por job/fence/generación/snapshot/contrato, sin textos ni argumentos. Correlacionar
   también SQL/commit lento con comando y worker. Reproducir fuera de esta prueba
   `awareness.getSnapshot` y commits demorados sobre copia consistente en SSD,
   midiendo frío/caliente y heartbeats. Mantener un escritor, lectores readonly,
   WAL/FULL y las guardias existentes.

Criterios de aceptación: argumentos primitivos correctos aceptados por transporte
completo; todas las formas inválidas detectadas rechazadas sin HTTP innecesario;
una lectura válida acreditada antes de cualquier publicación; cero publicaciones
si fallan la propuesta y su única reparación; aislamiento entre generaciones;
identidades de contrato verificables; calidad de noticias coherente con edad,
ámbito y revisión; ninguna lectura administrativa inicia adquisición ni inferencia.
Después, checks/tests de backend, MCP/inventario y frontend afectado en instancias
temporales. La evaluación del modelo real y una nueva continuidad de 24 h son
validaciones distintas de esos tests deterministas.

Este seguimiento sólo añade documentación y evidencia. La prueba actual continúa
para conservar contexto operativo; no se considera superada por disponer de HTTP
200 ni por mantener el proceso vivo, y todavía no acredita calidad del agente.

Comprobación de continuidad al terminar: muestra del observer de las
**19:22:36.164**, **213 muestras**, mismo PID 271599 y misma identidad, cero
indisponibilidades y cero fallos de los tres workers de almacenamiento. Sigue
`observing`, con 24 h incompletas. La calidad de noticias ha vuelto a `degraded`
por `content-publication-expired`; esto confirma que el indicador puede alternar
al cruzar el umbral entre publicaciones, aun con operación `ok`.

## Implementación local v1.9 — cierre de la revisión

La implementación posterior al diagnóstico se ha dejado en
`feat/agentic-intelligence`, conservando el trabajo local. Esta sección describe
las correcciones y las pruebas aisladas; los resultados operativos anteriores
permanecen arriba con sus cortes originales. No se ha iniciado otra observación
de 24 horas ni se ha habilitado publicación visible.

### Cambios y evidencia

| Requisito | Implementación | Comprobación |
|---|---|---|
| Argumentos MCP concretos | `ogid_agent_evidence`, `ogid_agent_evidence_chunk` y `ogid_agent_clusters` se generan desde el contrato compartido. Cadenas, enteros y enums estrictos; sin coerciones ni campos adicionales. `ogid_query` conserva su compatibilidad, pero queda fuera de los permisos del analista. | Stdio real: `$ref`, `$type`, `$oid`, tipos equivocados, offsets fraccionarios, formatos y campos desconocidos se rechazan antes de HTTP. |
| Identidad y acreditación | Descriptor canónico compartido para operación, snapshot, progreso y recibo. Identidad del adaptador también en errores. Un resultado `completed`, catálogo sin datos, `isError` o recibo sin contrato válido no acredita lectura. Los contratos incompatibles detienen nuevas admisiones. | Pruebas de recibos, contratos discordantes, snapshots ajenos, error final junto al último fallo MCP y cero publicaciones sin lectura. |
| Versionado y trabajos anteriores | Prompt `ogid-analyst-v1.9`, contrato `1.9.0`, hash `88cbdc5e72c9b0a05256bc81cc4dafc29b5510557075296fb2df58d45ebbe9e1`. Sustitución transaccional y acotada de trabajos antiguos sin iniciar; una generación interrumpida exige ACK con su fence antes de sustituirse. | Reconciliación, historial preservado, idempotencia, nuevo snapshot y rechazo del owner/fence anterior. Los trabajos fallidos históricos no se relanzan en bloque. |
| Razonamiento privado | GPT-OSS usa el proveedor nativo V2 `@opencode/ai/providers/openai-compatible` y `compatibility.reasoningField: "reasoning_content"`. Se conserva OpenCode 2.0.31 y su verificación de binario. | Transporte completo con el binario real, broker y MCP: dos turnos de herramientas conservan el campo privado. No se vuelca razonamiento ni argumentos en Admin o logs. |
| Error terminal y capacidad | El broker conserva el error SSE observado dentro de HTTP 200 y convierte un EOF incompleto en error explícito. El cliente detecta `peg-native` y EOF incluso en `assistant.retry.error`, sin esperar a que termine el retry interno de OpenCode. El owner interrumpe y confirma; un ACK perdido conserva estado incompleto y cancelación durable. | Errores inyectados atravesando el binario real: `LLAMACPP_OUTPUT_FORMAT` y `BROKER_INCOMPLETE_STREAM`, con liberación de capacidad y sin salida parcial válida. DNS, TLS, conexión, HTTP, timeout y cancelación conservan causas diferenciadas cuando hay evidencia. |
| Espera por fallos sistemáticos | Tras tres generaciones fallidas por argumentos MCP o formato, control durable por modelo y contrato en `runtime_kv`: 60 segundos iniciales, exponencial, máximo 15 minutos y jitter inyectable de ±20 %. Una comprobación al vencer la espera; reset por resultado validado. | Reinicio del repositorio, una sola comprobación, jitter, conservación de incertidumbre y reset tras publicación aceptada. |
| Admin verificable | Tarjetas de Broker, OpenCode, MCP, Worker y llama.cpp; fase, cola, observación, contrato esperado/observado, rechazos, último éxito y último fallo separados. Resumen desde el arranque y hasta 50 trabajos unidos a su run por job y fence. Máximo 16 problemas de validación saneados y respuesta acotada. | Chromium a 1440 y 390 píxeles: sin desbordamiento de página, fallos final/MCP simultáneos, contrato desconocido, pérdida de observación y conservación de actividad cuando falla almacenamiento. |
| Lecturas de Admin | Runtime consume telemetría del lifecycle; actividad usa el lector existente. El catálogo de modelos procede de una proyección en memoria, sin refrescar proveedores al abrir Admin. Sondeo de 5 segundos visible y 30 oculto, coalescido y con rechazo de respuestas antiguas. | La prueba de navegador sólo solicita `/api/admin/agent`; no solicita catálogo remoto, adquisición ni inferencia. Runtime mantiene sus componentes aunque falle la consulta de actividad. |
| Frescura de noticias | Política compartida `news-freshness-v2`: publicación geopolítica elegible 30 minutos; comprobación satisfactoria 10 minutos. Proyección, health, Admin y entrega WS usan el mismo cálculo. Un intento fallido posterior no vence un chequeo reciente. | Reloj controlado en ambos límites, fechas desconocidas/futuras, comprobación sin contenido nuevo, reinicio y orden de respuestas. Se mantienen las pruebas de adquisición condicional existentes. |
| Calidad e historial | Se separan captura, publicación y proyección, con edad, umbral, revisión y momento de evaluación. Las etiquetas redundantes se agrupan; publicación y adquisición vencidas siguen siendo causas distintas, también durante `running`. Snapshots nuevos congelan la política; los históricos no se reescriben. | Guardias numéricas y temporales intactas, política congelada comprobada y readiness independiente de la calidad stale. |

La configuración de razonamiento sigue la
[documentación de modelos de OpenCode V2](https://opencode.ai/v2/docs/models/#reasoning).
La hipótesis del diagnóstico sobre pérdida de razonamiento se contrasta además
con la [incidencia de llama.cpp sobre GPT-OSS](https://github.com/ggml-org/llama.cpp/issues/27720).
La evidencia local confirma el intercambio privado y la clasificación de errores;
no implica que el modelo no pueda volver a producir un formato inválido.

### Resultados de las pruebas

- Backend: `npm run check` y `npm test`, **1.035 pruebas correctas**.
- MCP: check, **30 pruebas correctas** e `inventory:check`, **83 rutas y 92 operaciones**.
- Frontend afectado: comprobación de sintaxis y navegador real, escritorio/móvil.
- `git diff --check`: correcto.
- Transporte fijado, cohorte final de **cinco instalaciones temporales**:
  **5/5 correctas**, dos turnos de herramientas, recibos reales, argumentos
  inválidos sin HTTP innecesario, y errores de formato/EOF diferenciados.

En dos de esos cinco arranques OpenCode anunció MCP conectado antes de ofrecer
herramientas al primer turno. Se conserva este resultado inicial en los logs:
no acredita lectura. La misma reparación única de evidencia utilizada por el
worker recuperó el turno en ambos casos; no se añadió una segunda reparación ni
se aumentaron deadlines. El contrato permanece sin verificar en Admin hasta
recibir identidad de una respuesta real del adaptador. Si la reparación también
falla, la respuesta continúa sin poder publicarse.

También se ejecutó inferencia con **GPT-OSS-20B residente**, usando bases pequeñas
temporales, sin proveedores de mercado/noticias y sin tocar la base operativa:

| Caso real | Resultado |
|---|---|
| Brief global | Publicación shadow válida tras la única reparación; catálogo y chunk UTF-8 acreditados. |
| Valoración geopolítica | Publicación shadow válida en la propuesta inicial. |
| Outlook global | Ambas propuestas rechazadas por `AGENT_UNVERIFIED_NUMBER`; ninguna publicación. |
| Outlook de ORCL con RSI null y warmup 21 | Catálogo/chunk consultados, pero ambas propuestas rechazadas por `AGENT_UNVERIFIED_NUMBER`; ninguna publicación ni conversión del requisito en medición. |
| Primer chat de la muestra completa | Dos consultas de catálogo sin contenido acreditado; rechazo `AGENT_TOOL_EVIDENCE_REQUIRED`, sin respuesta durable válida. |
| Chat aislado posterior a la aclaración de chunks | Respuesta válida con cita de cobertura, historial persistido, SSE y cancelación HTTP correctos. La lectura acreditada fue de cobertura; este chat no acredita por sí solo lectura de todos los chunks técnicos. |

No reapareció `peg-native` en estos casos reales. La muestra completa de cinco
tareas no se considera un aprobado semántico general: conservó dos publicaciones
y tres rechazos. El chat aislado posterior sí pasó. Los dos outlooks todavía
requieren revisión del modelo sobre evidencia suficiente durante la siguiente
prueba shadow; sus cifras inválidas siguen bloqueadas.

Evidencia y resultados saneados:
`.agent-validation/mcp-recovery-v19-20261024-pE4IJZ/summary.json`, con logs de las
suites, las cohortes de transporte, capturas de Admin y referencias a los fixtures
reales. Se conservan los fallos exploratorios del transporte por separado; no se
cuentan como éxitos de la cohorte final. Los ficheros privados de los fixtures
permanecen en sus directorios con permisos restringidos y no se incorporan a Git.

### Entrega y siguiente ejecución manual

No hay migración nueva: **001–022 permanecen intactas**. Esta implementación no
modifica `.env`, la base operativa SSD, modelos, llama.cpp ni publicaciones
históricas. No se hace commit, push, merge, despliegue o promoción visible en esta
petición. Las instancias temporales se cierran al terminar; backend operativo y
observer se dejan detenidos.

Para la siguiente ejecución, en una terminal:

```bash
cd /home/fedora/ogid/backend
npm start 2>&1 | tee "../.agent-validation/shadow-backend-v19-$(date +%Y%m%d-%H%M%S).log"
```

Cuando `/api/health/ready` responda correctamente y Admin muestre los workers
operativos, comprobar por separado OpenCode 2.0.31, conexión del worker y contrato
MCP observado 1.9.0. Un estado MCP inicial sin verificar es distinto de un contrato
incompatible. Noticias stale degradan calidad; no significan por sí solas que
SQLite no esté listo. Revisar las publicaciones **de este arranque**, además del
histórico.

Después, en otra terminal, iniciar manualmente el observer en una ruta nueva:

```bash
cd /home/fedora/ogid
node backend/scripts/agent-shadow-observe.js ".agent-validation/shadow-24h-v19-$(date +%Y%m%d-%H%M%S)" 24
```

Estas órdenes no se ejecutan en la entrega. `.agent-validation` conserva su
destino HDD. La continuidad de 24 horas y la revisión semántica de las respuestas
reales siguen siendo criterios operativos posteriores, sin promoción automática.

## Corrección de auditoría CI durante el shadow — 25/10/2026

El CI del commit `3ac9a1a` superó instalaciones, checks y pruebas, pero falló en
`npm audit --omit=dev --audit-level=high`. Se reprodujeron seis vulnerabilidades
en backend y una en MCP. El aviso de Zod afecta a versiones anteriores a 4.6.6:
[GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).

Se mantiene **Yahoo Finance 4.0.2** y se actualiza Zod a **4.6.7** en ambos árboles.
El lockfile de backend incorpora además las correcciones compatibles de
`body-parser` 2.4.0, `undici` 7.30.1, `fast-uri` 3.1.9 e `ip-address` 10.7.5, con
sus dependencias compatibles. No se usa `npm audit fix --force`, no se degrada
Yahoo a 3.x y no se rebaja el umbral de seguridad. CI audita ahora backend y MCP.

Validación en una copia aislada con **Node 24.22.1**, correspondiente a la versión
principal de CI: `npm ci` en ambos paquetes, checks, inventario, **1.035 pruebas
backend y 30 MCP correctas**, build y auditorías con **cero vulnerabilidades**.
El transporte simulado con OpenCode 2.0.31 también pasa con las dependencias
corregidas, incluida su reparación única ante catálogo inicial sin herramientas.

La publicación del avance en la rama es compatible con la observación en curso:
la identidad del backend se captura al arrancar y no cambia al mover HEAD. Las
instalaciones y pruebas se realizan fuera del checkout operativo; sus
`node_modules`, `.env`, base y procesos se conservan. La corrección de
dependencias publicada se aplicará al runtime en una instalación y arranque
posteriores; no se atribuye esa corrección al proceso que ya estaba ejecutándose.
La prueba de 24 horas continúa y su aprobación sigue pendiente de completarse.
