# Cierre shadow y seguimiento de implementación

Rama: `feat/agentic-intelligence`. Evidencia histórica revisada el 23/10/2026.
Las horas de este documento son Europe/Madrid. Este informe no modifica la
evaluación del 21/10 ni los originales de `.agent-validation`.

## Actualización tras el arranque operativo del 23/10

El usuario arrancó el backend a las **18:08:53** después de la validación local
descrita más abajo. En ese arranque se aplicó **019** a la base operativa y el
montaje externo se comprobó con escritura habilitada. Las limitaciones de acceso
y los pasos de arranque pendientes que figuran en las secciones históricas
describen el estado anterior a esta ejecución.

La observación quedó interrumpida: durante el diagnóstico, la consulta de lectura
`GET /api/admin/history` realizada por el asistente ejecutó una enumeración no
acotada en el escritor; agotó la guardia de 30 s y provocó el cierre automático
a las **18:34:15**, con `server_stopped` a las **18:34:16**. No se reinició nada.
No hay aceptación de estabilidad continua de 24 h.

El [diagnóstico de esta ejecución](live-sec-etf-diagnosis.md) conserva la causa
del cierre, los reintentos y recuperaciones parciales de SEC, la falta de
recuperación intradía fuera de sesión para los ETF, los huecos diarios, el ID
alterado en la reparación de ASML y el uso semántico incorrecto de `warmup` en
una publicación. Esas correcciones **siguen pendientes** y requieren el siguiente
plan de implementación. Este conjunto de cambios se entrega como avance shadow
para revisión; los resultados de las suites no acreditan estabilidad operativa
ni habilitan promoción visible.

### Revisión del contenido para el commit

Comprobación posterior al diagnóstico: 66 archivos candidatos, incluyendo código,
pruebas, inventario API/MCP y los documentos de referencia y seguimiento. Se
añaden excepciones concretas a `.gitignore` para que el prompt, la evaluación del
21/10 y los dos informes del 23/10 entren en el repositorio. Se mantienen fuera
`.env`, credenciales, bases SQLite, logs y `.agent-validation`.

Validación repetida sobre este código: sintaxis backend/frontend y MCP correcta,
backend **959/959**, MCP **29/29**, inventario **82 rutas / 91 operaciones** y
`git diff --check` sin incidencias. La primera ejecución MCP dentro del sandbox
falló al ejecutar sus procesos de prueba; la repetición con acceso efectivo al
entorno completó los 29 casos. Estas comprobaciones usan fixtures y no arrancan
el backend operativo ni certifican la corrección de los problemas de carga y
semántica descritos en el diagnóstico.

La revisión de rutas candidatas y coincidencias con credenciales configuradas
no detectó secretos en el contenido preparado. La única coincidencia revisada fue un
identificador User-Agent público por defecto que ya existía en HEAD, sin correo
ni credencial. No se modifican las migraciones 001–018; 019 añade dos índices.

Evidencias locales de esta revisión:
`.agent-validation/precommit-review-20261023.json`,
`.agent-validation/precommit-backend-20261023.log`,
`.agent-validation/precommit-mcp-tests-host-20261023.log` y
`.agent-validation/precommit-mcp-inventory-20261023.log`.

## Resultado histórico comprobado

- Backend: `.agent-validation/shadow-backend-20261021-195556.log`, inicio
  21/10 19:55:57, cierre 22/10 12:32:46: 16 h 36 min 49 s.
- Observador: `.agent-validation/shadow-24h-20261021-203530`, 1.438 muestras,
  intervalo completado; las últimas 483 muestras sin servicio. No acredita
  estabilidad continua de 24 horas.
- 29 recuperaciones de analysis, cero de queries, 33 `STORAGE_CAPTURE_TIMEOUT`.
- Causa inmediata del cierre: heartbeat escritor ejecutándose durante 5 s,
  `STORAGE_OUTCOME_UNKNOWN` / `STORAGE_EXECUTION_TIMEOUT`, parada del backend,
  errores secundarios `STORAGE_NOT_READY` y un error de cleanup.
- El log no identifica la sentencia exacta que demoró ese heartbeat ni demuestra
  fallo físico del disco. La prioridad de despacho no interrumpe SQLite síncrono.
- 193 runs iniciados en el arranque: 79 completed, 90 failed, 23 incomplete,
  uno running al detenerse. Son ejecuciones/fences, no el acumulado de jobs.
- 79 publicaciones nuevas, todas shadow. Cero duplicados por job; cero
  publicaciones con snapshot ausente, sin sellar o posterior a la publicación.
- Migraciones 001–018 con checksums coincidentes; cero propietarios escritores
  residuales. `sealed`, no `complete`, acredita el sellado de un snapshot.
- Alphabet y ORCL terminaron healthy en sus estados SEC persistidos.

La comprobación de SQLite para el cierre fue una lectura inmutable de la imagen detenida,
sin WAL/SHM presentes y verificando tamaño/mtime antes/después. No certifica
integridad completa ni comportamiento futuro. La sesión expone `/srv/bitcoin`
en solo lectura; no implica que ese fuera el montaje durante la prueba.

## Invariantes y ejecución

Un escritor de negocio; lectores readonly/query_only; WAL y synchronous FULL;
snapshots sellados, evidencia congelada, idempotencia y fencing al commit.
Conservar RSS, ventanas, historial, validación y llama.cpp. Arranque sólo con
`cd backend && npm start`; hijos broker/OpenCode/worker controlados por `.env`.
Base operativa `/srv/bitcoin/ogid/db/ogid.sqlite`. Desarrollo y pruebas aisladas
en este checkout, sin modificar esa base ni `backend/.env`. Sin publicación,
merge remoto ni promoción visible automáticos.

## Cambios implementados

El timeout de control mantiene el aviso a 5 s y ahora bloquea nuevos despachos
mientras espera el resultado del comando aceptado. La guardia existente de 30 s
se cuenta desde su inicio. Un ACK tardío resuelve la reconciliación; sin ACK se
conservan causa inicial y comandos sin confirmar y se cierra. Cada renovación
lógica tiene un ID estable y usa `storage_commands`; su replay no vuelve a
ampliar la lease. El cierre durable exige el mismo owner/fence.

La captura evita competir con otro cálculo CPU en el mismo lector. Al terminar
la captura, los RPC de persistencia pueden compartir ese lector con un cálculo.
Se conservan los plazos efectivos, los límites de cobertura, las transacciones
WAL y el sellado atómico. Las páginas físicas pasan de 1.024 a 128 referencias
con 1 MiB de payload; los registros grandes se leen individualmente dentro del
mismo corte. La ingesta conserva diez filas por commit y añade 128 KiB por lote,
sin descartar una fila grande. Las transacciones de lectura siguen medidas por
`captureMs`: ceder JS no equivale a cerrar el snapshot ni a liberar su retención
del WAL. [SQLite WAL](https://www.sqlite.org/wal.html).

Se reutilizan la coalescencia de lecturas, los cálculos coordinados y
`AdvancedCoordinator`. La proyección administrativa clasifica y filtra una vez
por corpus/revisión, ventana y filtros, y pagina el resultado. Las vistas se
limitan a ocho por corpus; la caché de corpus existente mantiene su límite.
Reconstruir el lector conserva la racha de fallos; sólo trabajo productivo la
reinicia. No se añade un scheduler.

La migración **019** añade `agent_runs_started` y el índice parcial
`agent_snapshots_building_job`. Este último elimina el escaneo de snapshots
sellados en la búsqueda de construcciones abandonadas. Las búsquedas de nuevas
revisiones usan el índice de disponibilidad ya existente. No se editan
migraciones históricas ni se introduce otro escritor.

Los contratos de publicación y los ejemplos de abstención comparten definición
por tarea, con prompt `ogid-analyst-v1.6`. Se conserva parseo completo, cifras
exactas, evidencia congelada y una reparación. Los errores numéricos se devuelven
juntos con un máximo de 16 problemas; el catálogo técnico limita rutas,
profundidad, nodos y bytes e indica cómo continuar leyendo la evidencia.
`AGENT_TASK_FIELD_MISMATCH` distingue un campo ajeno de una identidad incorrecta.
OpenCode sigue en **2.0.31**: se declara contrato textual y gramática no aplicada;
no se infiere lo contrario de `structuredOutput` en el catálogo del modelo.

Admin une job/run por jobId **y fence**, conserva errores por intento y distingue
fase, reparación y resultado durable. La conformidad inicial y la eficacia de
reparación tienen denominadores independientes por tarea/modelo, con ventana de
1.000 runs y hasta 64 grupos. La entrega incierta no cuenta como propuesta
inválida. Las fases y duraciones observadas se registran por separado; tiempos de
espera del broker y carga de modelo que no se observan siguen siendo `null`.
`firstProgressMs` sigue significando primera actividad observada, no TTFT.

El perfil `dashboard-v1` añade una primera página de noticias, selección de
quotes, cobertura, resumen Awareness, modo del agente, resumen de operación y
referencia a la analítica durable disponible. Consultarlo no admite cálculos.
La UI descarga el resto de la selección de noticias al paginar/filtrar y conserva
el límite publicado por el backend. Los paneles usan interés visible y foco;
modelos y acceso de dispositivo se consultan al abrir el chat. Las lecturas JSON
del dashboard comparten dos puestos por pestaña, con una sola analítica pesada; retirar un
consumidor no cancela el de otro.

V2 conserva su forma. Se retienen también las revisiones anunciadas sin primera
lectura; las reservas fijan bytes, revisión, perfil y filtros durante un máximo
absoluto de 60 s. El presupuesto global comparte representaciones inmutables,
contabiliza reservas y limita sus entradas. Expiración, expulsión por capacidad,
epoch nuevo y falta de admisión tienen causas diferenciadas. Una página HTTP
final, incluyendo envoltura JSON, escapes y UTF-8, no supera 64 KiB. El cursor
continúa siendo un offset de cadena JavaScript.

`pipeline:status:v1` lleva epoch y secuencia monotónica, con máximo 16 KiB.
Cambios ordinarios se agrupan hasta 1/s; fallos y recuperación tienen prioridad.
El cliente recupera sólo recursos pendientes y usa el manifiesto válido del
error sin otro GET; si no es válido comparte una recuperación. El bootstrap
permite caché privada con ETag débil semántico; 304 conserva el cuerpo previo.
Las reservas permanecen `no-store`. El validador se comprueba antes de proyectar
y serializar el contenido. [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.2).

## Matriz de cobertura y aceptación

Los estados «aprobado» corresponden a las pruebas descritas, no a estabilidad
certificada del despliegue. Los fixtures nombrados por símbolo reproducen clases
de defecto; no reconstruyen los cuerpos históricos que el informe no guardó.

| Entrega / evaluación | Causa y cambio / símbolos principales | Prueba y resultado |
| --- | --- | --- |
| P0 escritor | La prioridad no interrumpe SQLite síncrono. `StorageManager.expire/pump/handleMessage`: reconciliación a 5 s, guardia desde ejecución a 30 s | `storageReconciliation.test.js`: ACK tardío, pausa, límite duro y no reanimación tras fallo; aprobado |
| P0 cierre | El error secundario de flush ocultaba la causa inicial. `StorageManager.failureContext/closeLocal`, `server.stop`: cierre idempotente y persistencia no confirmada separada | `storageWorker.test.js`: cierre con fallo real de persistencia y con escritor muerto; aprobado; copia real cierra sin errores |
| P0 lectores / §7,9 | Captura y CPU competían; reconstrucción podía parecer recuperación. `createAnalysisManager/recoverReader`, `prepareAgentSnapshot`, `physicalPages` | `processingCoordination.test.js`, `sqlNewsCorpus.test.js`, `storageWorker.test.js`: aislamiento, captura y una CPU; aprobado |
| A / §1: ASML, SPCX | Esquema general e instrucciones no expresaban restricciones. `publicationSchemaForJob/validatePublicationForJob/taskInstructions/parsePublication` | `agentIntelligence`, `agentOperations`, `shadowContracts`: enum, estructura, JSON completo y reparación única; aprobado |
| A / §1: AMD, ORCL | Dirección sin invalidación. Condicionales del contrato; guardia final de `assertPublication` | Fixtures direccionales y abstención; inicial válida publica una vez, reparación válida una vez, ambas inválidas cero; aprobado |
| A / §1: AAPL | Path a objeto y número aproximado. `numericPaths/numericFactProblem`, catálogo en `AgentRepository.evidence` | Objeto `.sma`, sugerencia `.value`, cifra exacta, varios problemas y truncamiento; aprobado |
| A / §2: EUNL | Campo exclusivo confundido con identidad. `AGENT_TASK_FIELD_MISMATCH`, contrato maxItems=0 y reparación compartida | Fixture EUNL y tareas restantes; identidad ajena continúa rechazada; aprobado |
| A transporte | 2.0.31 no transmite schema en prompt. `publicCapabilities.generationContract`, metadatos del worker | Contrato fijado y transporte inyectado de suites agente/broker; aprobado. Gramática en generación real: no aplicada |
| B / §3 | Renovación tardía detrás del commit. `AgentRepository.heartbeat/publish`, `IntelligenceWorker.execute` | Replay de renovación, mismo owner/fence, cierre durable, fencing vencido, cancelación y rollback; aprobado |
| C / §4 | Frescura uniforme para una configuración puntual. `PipelineMonitor.register/snapshot`, salud/readiness | Inicialización no caduca; periódica sí; worker y reconciliación degradan salud; aprobado |
| C / §6 | Contenido, adquisición y proyección se confundían. `SqlNewsPipeline.getProjection`, badge de dashboard | Fechas y `staleReasons` distintos, cobertura/límite conservados; suites news/processing aprobadas |
| C/H / SEC | Un ciclo sin fuentes elegibles podía aparentar recuperación. `sourceFailureCode`, `SecSourceAgent.tick` | Transporte inyectado, timeout, cooldown, Retry-After, última lectura y recuperación posterior; suite SEC aprobada |
| D / §5 | Raw reclasificaba candidatos al paginar. `SqlNewsCorpus.feedViews/getFeed` | Corpus único, filtros normalizados, páginas y límites conservados; aprobado |
| D / §7,9 | Analítica pesada y bootstrap competían/admitían trabajo equivalente. `coalescedRead`, coordinación existente, `AdvancedSnapshots.peek` | `durablePersistence`, `processingCoordination`, `dashboardBootstrap`: trabajos durables, publicación atómica y lectura sin adquisición; aprobado |
| H / §7 | Unión por job sin fence y reparación sin progreso. `agentOperationsView`, `worker.metrics/validationAttempts` | Suites agente y `shadowContracts`: fases y denominadores propios, resultado desconocido separado; aprobado |
| E / §10.1 | Páginas pequeñas y descarga completa repetida. `StateSync.page` y `StateSynchronizer.sync` | Comparación S1 con payload idéntico y 1/2/5 clientes; medición al final |
| E / §10.2 | Se reemplazaba una representación aún no paginada. `StateSync.change/manifest` | Revisión inicial y revisión no leída sustituida, igualdad profunda; cero conflictos en esa carrera; aprobado |
| E / §10.3 | GET redundante tras 409 y recuperación global. `validSyncManifest/recoverManifest` | Manifiesto válido: cero GET adicional; recursos completos conservados y jitter localizado; aprobado |
| E / §10.4 | Caracteres no equivalen a bytes HTTP. `page.dataAt/fits/safeBoundary` | Unicode suplementario, escapes, progreso y reconstrucción; cuerpo final ≤64 KiB; aprobado |
| F / §10.5 | Arranque arrastraba históricos y paneles. `projectDashboard`, `getDashboardBootstrap`, módulos por interés | Bootstrap versionado, sin adquisición, quotes/IDs conservados, noticias siguientes y detalle v2 accesibles; aprobado |
| F / §10.6 | Pipeline invalidaba descargas grandes. `publishState`, `pipeline:status:v1`, reservas de `StateSync.page` | Secuencia/epoch, pinning bajo cambios, presión, vencimiento y token sin acceso adicional; aprobado |
| F / §10.7 | Propiedad de arranque y cancelación no compartidas. `StateSynchronizer.syncCompact`, `ReadCoordinator`, `observeInterest` | Navegador: paginación, filtros rápidos, panel, reconnect, bfcache simulado, dos pestañas, chat explícito, Admin y recarga; aprobado en fixtures |
| G / §10.8 | Refrescos redundantes y 304 sin cuerpo reutilizable. `api.performRequest`, ETag semántico, guardias de interés | 304 HTTP y cliente, fallback v2, paneles diferidos y navegación fría/caliente; aprobado en fixtures |
| H / §8,10.9 | Intervalo completo no acredita continuidad. `shadowSample/recordContinuity`, `RuntimeMetrics`, logger | Identidad PID/startedAt/build, huecos, reinicio, readiness frente a observación y desconocido frente a conexión rechazada; aprobado |
| H / §10.9 | Agregados mezclaban tráfico e intentos. Métricas HTTP por canal, requestId acotado, diagnóstico job/fence, captura/validación/commit | Resultado terminal único y aborto independiente; buffers acotados; suites aprobadas |
| §10.10 | Necesidad de medir con carga equivalente | Harness `scripts/dashboard-validation.js`, backup SQLite, corpus y adquisición iguales, 1/2/5 clientes; detalle abajo |
| §10.11 | Compatibilidad y contrato inventariado | `ogidOperations` 1.6.0, capacidades, ruta bootstrap, inventario MCP: 82 rutas / 91 operaciones; 29 pruebas MCP aprobadas |
| Migración / entorno | No sustituir base ni editar migraciones desplegadas. `019_agent_diagnostic_indexes.sql`, `assertStorageVolume` | Copias WAL de esquemas 009 y 018; backup real 018→019; volumen ausente/ro falla sin fallback; aprobado |

## Validación ejecutada

- `cd backend && npm run check`: aprobado.
- `cd backend && npm test`: **959/959**, cero fallos, cancelaciones o skips;
  91,84 s. Log `.agent-validation/implementation-complete-suite-final.log`.
- `cd integrations/ogid-mcp && npm run check && npm test && npm run inventory:check`:
  **29/29**; inventario vigente. Log
  `.agent-validation/implementation-mcp-final.log`.
- `git diff --check`: aprobado. No cambios en `.env`, lockfiles, migraciones
  001–018, evaluación histórica o logs de observación originales.
- Comparación remota mediante conector GitHub: main sigue en `b6edb69`, rama
  remota en `0fc9da2`, cinco commits por delante y cero por detrás. Los cambios de
  esta entrega son locales y no se han publicado ni integrado.

### Backup de la base real y migración

`production-copy-validation-20261023/result.json` registra un backup de
**6.688.047.104 bytes**, realizado con la API de backup SQLite desde la imagen
parada, readonly/inmutable y sin WAL/SHM presentes, comprobando que tamaño,
inodo y tiempos del original no cambiaron durante la copia. En fixtures de WAL
activo se usa el helper `createStorageBackup`, que incorpora el estado WAL.
No se copia sólo el fichero de una base activa.
[SQLite Backup API](https://www.sqlite.org/backup.html).

La copia conserva 127.801 artículos, 258.649 revisiones, 135.661 eventos,
39.498 velas, 18.865 análisis, 527 jobs, 605 runs, 97 publicaciones,
337 snapshots y 113.188 comandos. Tras migrar coinciden todos esos recuentos y
los checksums 001–018; `integrity_check=ok` y cero infracciones FK. La migración
019 tardó 182 ms con esta caché/entorno. El plan de la consulta de limpieza usa
el índice parcial; una lectura caliente de control tardó 0,054 ms (N=1, no p95).

El arranque aislado sobre esa copia tardó **28,16 s**, dejó escritor y dos lectores
ready (`readonly/query_only`), sirvió `dashboard-v1` con HTTP 200 y **11.763 bytes**,
y cerró sin errores ni persistencia pendiente. Proveedores, hijos y modelo estaban
desactivados en esa prueba. No equivale a un arranque operativo con adquisición.
Evidencia: `.agent-validation/production-copy-validation-20261023/startup.json`.
La copia temporal de 6,69 GB se retiró tras las comprobaciones para liberar
espacio del checkout. Se conservan los informes; el original permanece intacto.

### Medición de navegador

La ejecución final terminó sin errores de navegador ni HTTP 5xx en
`.agent-validation/dashboard-final-measurement-20261023/result.json`. El harness
usa Chromium 141.0.7390.37 headless, Node 22.23.3, Linux x64, 12 CPUs lógicas
y 15,5 GiB de RAM. Es **loopback**, con assets externos servidos desde fixtures,
sin proveedor/modelo real; no es la LAN del operador ni replay histórico.

Semilla de 400 noticias en backup consistente, tres instrumentos y 7.000 puntos
de histórico por instrumento. Adquisición sintética cada 2 s y renovación fenced
de prueba cada 5 s, independientes de los clientes. El corpus crece durante la
ejecución: plantilla y cadencia son comunes, los cuerpos no son un corte idéntico
entre cohortes. La línea «v2/8.000» fuerza ese presupuesto sobre el código nuevo;
no ejecuta el checkout histórico completo. Los porcentajes siguientes miden la
entrada de este escenario, no toda una sesión de Admin o análisis.

Hay 50 navegaciones frías por cohorte. En compacto se añaden 1/2/5 navegaciones
observadas durante diez segundos (N agregados 51/52/55). La recarga caliente y
los paneles se validan aparte, sin estimar su p95 con una sola apertura.

| Perfil | Clientes | N | API inicial, mediana | Vista útil p95 / máximo |
| --- | ---: | ---: | ---: | ---: |
| v2 / 8.000 caracteres | 1 | 50 | 235 | 1658 / 1748 ms |
| v2 / 8.000 caracteres | 2 | 50 | 235 | 2162 / 2217 ms |
| v2 / 8.000 caracteres | 5 | 50 | 235 | 4038 / 4092 ms |
| S1 / 64 KiB | 1 | 50 | 47 | 653 / 654 ms |
| S1 / 64 KiB | 2 | 50 | 47 | 854 / 860 ms |
| S1 / 64 KiB | 5 | 50 | 49 | 1638 / 1707 ms |
| dashboard-v1 | 1 | 51 | 2 | 282 / 298 ms |
| dashboard-v1 | 2 | 52 | 2 | 349 / 372 ms |
| dashboard-v1 | 5 | 55 | 2 | 654 / 754 ms |

S1 reduce las solicitudes iniciales **79,1–80 %** respecto a v2/8.000 en estas
cohortes; compacto reduce **99,1 %**. Los ocho clientes observados diez segundos
hacen **7 solicitudes cada uno**, con adquisición activa. El máximo cuerpo API
del compacto observado es **27.668 bytes**; el bootstrap sobre la copia real
midió 11.763 bytes. El presupuesto de cada página sync se comprueba por bytes
en pruebas de reconstrucción, independientemente del tamaño de otras APIs.

Las medianas de Resource Timing son 1,90 MB JSON / 1,97 MB transferidos para
v2/8.000, 2,07 MB / 2,08 MB para S1 y 27,9 kB / 28,5 kB para compacto. S1
reduce solicitudes; estas cohortes con adquisición no acreditan una reducción
aislada de bytes atribuible sólo a paginar. No se ha añadido compresión.

Avanzaron **187 ingestas**. No hubo fallos de escritor ni recuperaciones de
lectores; las renovaciones de prueba confirmaron en ≤24,5 ms. El muestreo de
colas cada segundo vio cero pendientes del escritor y hasta uno de lectores.
El p95 del event loop estuvo entre 20,8 y 25,1 ms, con resolución de muestreo
de 20 ms. La RSS máxima del proceso compartido fue 759 MiB; creció entre
cohortes secuenciales. Esto **no prueba ausencia de crecimiento sostenido de
memoria** ni sustituye un ensayo de procesos separados o las 24 h reales.

El recorrido independiente pasa: segunda página de noticias bajo demanda,
filtros rápidos, panel Advanced visible, reconexión, eventos de lifecycle bfcache
simulados, dos pestañas, descubrimiento de modelos al abrir chat, Admin→dashboard
y recarga caliente. El chat usa catálogo inyectado y conserva el rechazo de
dispositivo no autorizado. Los eventos simulados no certifican por sí solos
la elegibilidad nativa de bfcache en todos los navegadores.

Comando reproducible desde backend, usando el Playwright instalado:

```bash
OGID_PLAYWRIGHT_MODULE=/home/fedora/.npm/_npx/d537ee5ee2a13f03/node_modules/playwright/index.mjs \
  node scripts/dashboard-validation.js ../.agent-validation/OTRA-RUTA-NUEVA 50
```

El script rechaza reutilizar su directorio de salida y trabaja sólo con sus
bases de validación. No está incluido en la suite ordinaria. Los archivos
exploratorios previos con fallos de fixtures o carga concurrente se conservan,
pero no se utilizan como aceptación.

## Entorno operativo y puertas pendientes

Se conserva la ruta `/srv/bitcoin/ogid/db/ogid.sqlite`, shadow, los interruptores
de los tres hijos, `AI_PROVIDER=none`, `AI_MODE=off`, modelo de fondo
`llamacpp/gpt-oss-20b`, endpoints loopback y credenciales privadas. La guardia de
volumen impide crear una base alternativa si falta `/srv/bitcoin` o su directorio
no es escribible. Los fixtures usan rutas explícitas distintas.

1. Validar escritura/WAL/bloqueo en el montaje externo cuando tenga acceso
   efectivo: `cd backend && npm run storage:volume-check`. Esta comprobación usa
   su propio directorio temporal y no la base operativa.
2. Revisar este diff y preparar el arranque operativo exclusivamente con
   `cd backend && npm start`; no se ha arrancado ni reiniciado el servidor real.
   La migración 019 se aplicará a la base operativa en ese arranque, no en esta
   sesión. Mantener un backup consistente previo.
3. Medir con adquisición real y clientes de la LAN; ejecutar una **nueva
   observación continua de 24 h**. Las pruebas deterministas acreditan los casos
   corregidos, no que hayan desaparecido todas las expiraciones futuras del disco.
4. Revisar semánticamente las publicaciones y el recorrido real del modelo.
   Suites, rendimiento o intervalo completado no activan `visible`.

El observador se ejecutará en una ruta nueva; conserva originales y distingue
intervalo, disponibilidad y continuidad. Un worker reconstruido no se presenta
como recuperación de su cálculo anterior. Un heartbeat retrasado tampoco se
trata como confirmación de fallo físico: primero se resuelve su resultado durable,
con idempotencia y sin reenviar mutaciones a ciegas.
[Idempotencia y resultados inciertos](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/).

Memoria persistente solicitada: nota en
`/home/fedora/.codex/memories/extensions/ad_hoc/notes/2026-10-23-ogid-shadow24h-architecture.md`,
sin secretos, más la actualización final
`/home/fedora/.codex/memories/extensions/ad_hoc/notes/2026-10-23-ogid-shadow-implementation-results.md`.
