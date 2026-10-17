# Auditoría y entrega de persistencia SQLite

Base comprobada: `origin/main` = `adf837311aa51e366b436c39103ba2f3d639da16`.
Rama: `fix/sqlite-persistence-production`. Checkout inicialmente limpio.
No se ha inspeccionado ni modificado la base de producción ni `.env`.

## Recorrido previo a los cambios

Los colectores primario, suplementario y canónico descargan RSS, normalizan y
aplican las políticas de contenido. `NewsArchive` calcula identidad y revisiones;
`SqlNewsArchive.ingest` envuelve artículos, aliases, procedencias, relaciones,
revisiones y `onIngest` (eventos) en una transacción síncrona. Los lotes RSS se
persisten antes del recorte de transporte. `SqlNewsCorpus` consulta con un lector
propio y acumula riesgo diario completo, pero selecciona hasta `analyzeLimit`
para otros cálculos. `BusinessRuntime` ejecuta algoritmos en el trabajador de
análisis y envía `analysis.persist` al escritor. El controlador Advanced espera
el cálculo; el navegador abandona a los 12 s mientras el trabajo sigue hasta
el deadline del trabajador. No recupera snapshots Advanced tras reinicio.

## Inventario inicial y responsabilidades

| Dominio | Persistencia SQL / escritor | Lectores y estado auxiliar |
|---|---|---|
| Noticias, revisiones, procedencias, aliases, relaciones, FTS | SqlNewsArchive, transacción de ingestión | lector SQL; caché de selección en análisis |
| Eventos, evidencias, revisiones | SqlResearchStore / EventLedger; misma transacción al ingerir noticias | repositorios SQL |
| Señales y cambios | SqlAlertStore / signal_changes / outbox / consumer_checkpoints | diario y mapas materializados en memoria; riesgo de rollback incompleto |
| Cotizaciones | quote_observations, runtime.save | contexto HTTP y observaciones SQL |
| Velas y revisiones | SqlCandleStore, transacción por lote | trabajador analítico, revisiones disponibles |
| Análisis, indicadores | analysis_runs / indicator_values por escritor | cachés de algoritmos; hash inicial sólo de argumentos |
| Riesgo, impacto, predicciones | snapshots de mercado/noticias y contexto | parte en StateManager; resultados sobrescritos |
| Awareness | awareness_events, source_status, polls, runtime_audit | snapshot público y memoria; modos off/shadow/visible |
| IA | ai_enrichments, runtime_snapshots | registros con clave de entrada; presupuestos operativos |
| Adquisición y trabajos | acquisition_jobs, research_rows, pipeline_runs | estado por fuente/cursor RSS en runtime_snapshots |
| Checkpoints, estados operativos | pipeline_checkpoints / pipeline_stage_state / storage_commands | colas y telemetría en memoria |
| JSON heredado | importador explícito, respaldo de modo legacy | no es la fuente de negocio con modo SQL activo |

## Causas confirmadas por inspección

- Espera HTTP de Advanced incompatible con el timeout de navegador; caché sólo
  en memoria, sin lectura persistida independiente del trabajador ocupado.
- El mismo corpus SQL entra por `signalCorpus` y por `rssReadView`; los contadores
  de entrada cuentan ambas rutas, y `scoringUsesCompleteWindow` ignora truncamiento.
- `recordAnalysis` no reconoce `methodology.version` y su hash no identifica las
  entradas efectivas. Cada lectura cacheada solicita persistencia otra vez.
- `SIGNAL_ITEM_TOO_LARGE` es rechazo de representación del diario en la envoltura
  MCP. No demuestra rollback SQLite, pérdida de artículos ni enfermedad actual.
- El trabajador de análisis abre inicialmente una conexión escribible y migra;
  `query_only` se activa después de configurar.
- `SqlAlertStore` poda hechos del diario, recorre todo el diario para persistir y
  no restaura todos los mapas auxiliares ante fallo de transacción.
- `coverage.retainedSince` aplica una retención ficticia pese a conservar hechos.

Las observaciones de producción del usuario no se atribuyen a este checkout
sin verificar el proceso desplegado. Las mediciones y pruebas de la entrega se
registrarán por separado, distinguiendo fixtures, fallos inyectados y servidor real.

## Arquitectura implementada

El escritor posee una concesión identificada por token/PID en SQLite. El lector
analítico abre una conexión de solo lectura desde el principio; no migra ni
inicializa tablas. El padre sólo libera su concesión después de confirmar la
terminación de su trabajador. Las transacciones de negocio continúan siendo
síncronas y `synchronous=FULL`. No hay otra base ni dependencias nuevas.

`AdvancedCoordinator` devuelve el último resultado compatible o un estado
`preparing` mediante una operación breve independiente del cálculo. El escritor
normaliza filtros, captura contexto y revisiones y crea como máximo un trabajo
activo por selección/metodología. La identidad incluye la marca máxima de
revisiones de artículos y una ventana de frescura de 30 s. El lector consulta
las entradas; el escritor confirma resultado, descriptor, puntero al último
snapshot y trabajo en la misma transacción. La cancelación HTTP no es dueña del
trabajo compartido. Una publicación anterior no sustituye a una más reciente.
La cola durable admite 64 trabajos y la recuperación tiene un máximo de tres
intentos por trabajo. Los fallos permanecen visibles hasta nueva entrada o
reintento explícito; no se borran por haber atendido otra operación.

El transporte Advanced conserva HTTP 200 y `{ok,data}`. Añade `lifecycle` con
`preparing|refreshing|ready|failed`, disponibilidad, frescura, trabajo, intentos,
error y plazo de consulta. El navegador conserva el snapshot del mismo contexto,
reconsulta con espera progresiva de 2–15 s, descarta respuestas de filtros viejos
y evita solapamientos. El presupuesto de la lectura breve es 5 s de cola y 5 s
de respuesta; el cálculo tiene su propio deadline de 180 s. No se ha aumentado
el timeout general de 12 s del navegador.

## Archivo, entrada analítica y selección visual

`readAnalytical` lee las revisiones disponibles hasta `inputsAsOf` y hasta la
marca de revisión capturada. Elige la última revisión de cada artículo antes
de filtrar por publicación: una corrección que mueve la fecha fuera de la
ventana no deja reaparecer una versión antigua. Se excluyen publicaciones
futuras/desconocidas con contadores calculados sobre esa misma revisión.
Se cierra el snapshot SQLite antes de clasificación y procesamiento asíncrono,
para no mantener el WAL fijado durante la parte CPU.

La entrada Advanced cubre la ventana activa y la anterior sin el límite visual
de 3.000; el algoritmo recibe el corpus SQL una sola vez. El presupuesto explícito
es 64 MiB de JSON permitido de entrada, no 64 MiB de RSS total del proceso. Si se
supera, `analysisTruncated=true` y `truncationReason=analytical-input-byte-budget`;
no se afirma cobertura completa. La normalización informa exclusiones. Las
ventanas de 7/30 días de señales excluyen el intervalo activo y datos futuros;
la ausencia de muestras conserva su significado. Una noticia puede generar
varios eventos y una republicación no equivale a un origen independiente.

La selección visual mantiene sus límites/diversidad. Riesgo diario acumula
todos los candidatos elegibles; impacto/predicciones y condiciones consultan
la entrada analítica. La exclusión de la rama financiera fuera de Awareness
`visible` conserva el contrato y se muestra en `marketExcludedCount`.
`coverage()` describe el archivo real: sin retención temporal ficticia y sin
prometer continuidad de adquisición que no se conoce.

La búsqueda mantiene filtros, revisión máxima y cursor en memoria, y recorre
revisiones SQL sin copiar todo el resultado a tablas del escritor. El cursor
se invalida explícitamente al caducar o reiniciar; mientras vive, conserva la
misma revisión aunque lleguen correcciones. Se mantiene la ordenación y el
presupuesto de respuesta. Los índices nuevos cubren disponibilidad, publicación,
secuencia por instrumento, jobs y últimas observaciones. Las pruebas ejecutan
`EXPLAIN QUERY PLAN` sobre el acceso por disponibilidad.

## Derivados y conservación

| Dominio | Resultado/entradas y garantía final |
|---|---|
| Advanced v3 | `analysis_runs`, `analysis_inputs`, `analysis_jobs`, `analysis_latest`; publicación atómica; filtros normalizados, `asOf`, revisiones, descriptor/hash de artículos y copia de señales; contexto capturado en job |
| Riesgo, impacto, predicciones, insights | `news.projection` conserva el resultado completo; `runtime_snapshots` sirve el estado y `derived_observations` conserva observaciones distintas; no se reescribe la misma proyección cacheada |
| Condiciones, indicadores, técnico, acoplamiento, evaluación | `analysis_runs` y `analysis_inputs`, versión real disponible, parámetros, revisión de serie/cobertura; lecturas cacheadas conservan las entradas originales |
| Señales | buckets SQL históricos conservados, snapshots de señales observados y diario incremental; la caché móvil del correlador no borra buckets SQL |
| Escenarios y forecasts | repositorios SQL y revisiones/eventos existentes; no se recalifican resultados retrospectivos como predicciones prospectivas |
| IA | `ai_enrichments` y estado SQL existentes; presupuesto archivado cuando cambia; no se inventan entradas ni reproducciones deterministas de proveedores externos |
| Estados, cuotas, checkpoints | último estado operativo en SQL; observaciones históricas separadas de cachés; hechos e identidades de reintento sin poda automática |

Los análisis heredados que no exponen todas sus entradas se declaran con
`reproducibility.complete=false`, sin completar retrospectivamente hashes con
el contexto actual. Para Advanced, las revisiones anteriores al despliegue 009
pueden tener una disponibilidad histórica menos precisa: se informa
`legacyAvailabilityCount` y no se acredita reproducción completa. Los nuevos
manifiestos identifican la consulta, marca de revisión, límites y hashes; la
base y la versión de algoritmo siguen siendo necesarias para reconstruirlos.

No se han cambiado IDs existentes ni fusionado filas históricas. La identidad
URL de los algoritmos usa las reglas canónicas del archivo, preservando rutas
y parámetros significativos. La metodología Advanced pasa a v3 y fusión a v3.
Los caminos RSS conservan catálogo y configuración. Las noticias válidas se
archivan antes del recorte visual; `304`, vacío válido, timeout y respuesta
inválida son estados distintos. El canónico restaura validadores si falla la
persistencia, evitando que un `304` oculte datos todavía no confirmados.

## Diario y errores

`SqlAlertStore` no hidrata el diario completo ni elimina su histórico. Lee
cabeceras acotadas y carga cada detalle necesario; persiste diferencias y restaura
mapas/secuencia tras rollback. Las mutaciones síncronas con identidad de
reintento guardan resultado y efecto en la misma transacción; reutilizar la
identidad con otro contenido produce conflicto.

Un cambio que no cabe en `signals.delta` se entrega como
`historical-reference-v1`, con identidad, secuencia, revisión, motivo, estado,
fechas, bytes, hash y operación de detalle. `GET /api/signals/change` devuelve
fragmentos base64 de la representación **pública histórica** exacta, incluyendo
texto UTF-8 largo permitido. No es un enlace al estado actual de la entidad.
Se preservan las políticas de contenido y la ausencia de secretos. El cálculo
de tamaño incluye la envoltura MCP; leer páginas o delta no mueve checkpoints.
El contrato sube a `1.4.0`; inventario y consumidores se actualizan juntos.

La observabilidad separa escritura, consulta, cálculo, transporte y trabajador;
conserva fecha/código históricos y errores activos por operación. Añade bytes de
salida y duración de commit donde se mide realmente. “Completadas” son operaciones,
no artículos. Un escritor listo con un antiguo `SIGNAL_ITEM_TOO_LARGE` no implica
un fallo actual de persistencia.

## Validación, mediciones y límites

Los resultados ejecutados están en [sqlite-persistence-results](sqlite-persistence-results/).
El [runbook](sqlite-persistence-runbook.md) distingue activación, mantenimiento,
rollback de código y restauración de base. No se ha desplegado ni inspeccionado
producción ni se ha leído `.env`.

La suite comprueba concurrencia equivalente, reinicio tras commit, rollback de
publicación, cálculo de 12,5 s con lectura del snapshot anterior, UI con cambios
de filtros, más de 6.000 artículos, revisiones tardías y fechas inválidas,
baselines 7/30 contra referencia, disco lleno/bloqueo SQLite reales en fixtures,
backpressure/worker interrumpido, conflicto de reintento, restauración 001–008
más 009, FTS/procedencias/relaciones, RSS antes del recorte y contrato MCP completo.
La prueba UI usa el coordinador real con DOM y respuestas controladas; no acredita
un navegador de producción. La carga usa proveedores sintéticos locales y no
mide cuotas, latencia de Internet ni continuidad editorial real.

Las lecturas analíticas son recorridos acotados por ventana y bytes; una consulta
histórica amplia sigue teniendo coste de I/O/CPU. Los históricos e identidades
crecen por diseño: capacidad, backups y tiempos de migración deben comprobarse
con la base real. No se declara neutralidad editorial absoluta, cobertura total
de Internet ni un SLA del cálculo completo a partir del p95 de lecturas rápidas.

## Resultados finales

| Métrica | Main | Fix breve | Fix 30 min |
|---|---:|---:|---:|
| Primera respuesta (ms) | 4158.02 | 3.45 | 2.84 |
| Tiempo adicional hasta snapshot (ms) | 0.00 | 3032.00 | 3032.00 |
| Lecturas de snapshot p95 (ms) | 4112.43 | 45.09 | 42.27 |
| Estado p95 (ms) | 3.33 | 48.34 | 46.26 |
| RSS máxima (MiB) | 537.61 | 466.39 | 860.59 |

El soak final duró 1.801,9 s y completó 1.724 rondas, 34.480 lecturas y 545
trabajos, todos confirmados una vez, sin errores ni claves de cálculo duplicadas.
Terminó con 16.124 artículos/revisiones, integridad `ok` y cero violaciones de
claves foráneas. WAL inicial/final/máximo: 8.128.792 bytes (7,75 MiB); pico de cola:
15 pendientes y 313.278 bytes, sin espera analítica acumulada. Event loop p95
20,50 ms (resolución 20 ms), máximo 29,00 ms.

La RSS máxima fue 860,59 MiB. Las medianas del primer y último cuarto fueron
741,78 y 843,61 MiB: hubo crecimiento durante el calentamiento y la ingestión;
30 minutos no demuestran ausencia de fugas indefinidamente. Vigilar memoria y
capacidad con el histórico real. No se promete un techo de RSS de 64 MiB: ese
presupuesto corresponde exclusivamente a los bytes de entrada analítica.

Los 66 RSS siguen habilitados y las 435 búsquedas generadas están intactas;
catálogo completo SHA-256 `fd1a77a5e8624a358c5648b351874fdc400ef4bdd34c5aa11e503a93ad39a65c`.
Migraciones 001–008, lockfiles y `.env` no cambiaron. `origin/main` se volvió a
consultar antes del cierre y sigue en la base indicada. La comparación final
breve de main se repitió sin la suite de CI en paralelo para quitar esa fuente
de contención. Todos estos resultados son del entorno local descrito.
