# Estado de implementación — leer primero

Actualizado el 26/10/2026, 21:24 UTC. Plan v3. Rama `feat/agentic-intelligence`; HEAD `9a3aa2fb4e58b7fd1342f835288b843e1b06e2a9` (B). C cierra implementación y verificaciones en este checkpoint, incluyendo el diagnóstico `renewalId` previo. La base de partida es B; identificar el commit de cierre por el título indicado abajo. No se ha iniciado el backend operativo.

## Entrega C — cierre definitivo de código y verificaciones

C queda cerrada en implementación/integración para el commit autorizado `feat(news): cerrar entrega C de comparación y afirmaciones`, mediante el conector GitHub en feat/agentic-intelligence. Base anterior B: 9a3aa2f. Identidad de runtime final: **17aaed71a063a740c091b281071c799a6e5b5133b5b01e88a8e980a37796c0e4**, contrato 1.11.0, esquema 025. Este checkpoint forma parte de ese commit; el SHA y resultado remoto/CI se consultan en el recibo privado `C-close/publication.json` y se contrastan con GitHub al reanudar, o se localizan en Git por el título del commit.

Criterios y evidencias de cierre: [CIERRE-C.md](CIERRE-C.md). Backend completo final **1071/1071**, MCP **32/32**, regresiones de cierre **26/26**, build/check/inventario 92/101 correctos y dos auditorías runtime sin vulnerabilidades. Se corrigieron procedencia de origen tras merge/split, política de sólo titular, frames escapados/páginas vacías, relaciones paginadas por índices y menciones multilingües en enriquecimiento. Prueba real de una publicación sobre la base reparada con rollback completo, preservando IDs, fechas, revisiones, cursor y recuentos. No hay suites propias en ejecución ni fallos conocidos de cierre.

La publicación no despliega ni arranca el servidor. El backend sigue detenido y existe un adaptador MCP activo; conservar sus procesos y llama.cpp. Los históricos B/C siguen sin enriquecimiento persistente y hay 8+1 discrepancias de instalación, todas rastreadas a los locks actualizados en a1d0fb8. No son nuevas dependencias de C ni errores de código. Recomendación vigente: **parte 2 ahora (instalaciones y enriquecimiento), parte 3 por entrega, D→E→F, parte 4 sobre el candidato final**. Explicación, versiones y secuencia en CIERRE-FINAL.md.

Siguiente lote sugerido antes de D.1: alinear instalaciones con npm ci, coordinando la reconexión del adaptador MCP; ejecutar un piloto de enriquecimiento y después completar por páginas, con cobertura/latencia/cursor verificables. Se puede preparar a la vez corpus de evaluación y matriz E. No presentar el piloto con rollback como backfill completado ni adelantar las 24 h finales a un candidato que aún cambiará.

## Recuperación cerrada — base operativa seleccionada

El usuario autorizó reparar la base o crear otra con lo recuperable y seleccionarla como operativa. La recuperación ha terminado **sin pérdida ni descarte de registros**. `backend/.env` selecciona ahora:

`/home/fedora/.local/share/ogid/db/ogid-repaired-20261026-183735.sqlite`

Sólo cambió STORAGE_DB_PATH, de forma atómica el 26/10/2026 a las **20:40:56 UTC**. El original `/home/fedora/.local/share/ogid/db/ogid.sqlite` permanece intacto con su fallo; no volver a seleccionarlo como reversión. Se conservó la configuración anterior en un archivo privado, no publicable. Los procesos llama.cpp existentes y los controles de hijos/AGENT_MODE=shadow se preservaron. El backend **no está arrancado** y no se ha iniciado una observación operativa.

Daño localizado: overflow de agent_evidence.sequence=338423, dominio fundamentals, snapshot b17c4335-28f8-49af-84fd-0a55580d6b0e; payload SEC de 118327 bytes. Se reconstruyeron los 4096 bytes mediante 19 copias coincidentes y un sucesor de overflow único, cotejando todos los bytes legibles anteriores/posteriores. Coinciden el checksum Btrfs original 30a8db53 y el SHA256 original de las 334 evidencias del snapshot. El candidato usa reflink y un único bloque reparado; no se exportaron tablas con pérdida ni se inventaron valores.

Validación completa finalizada a las 19:21:52 UTC: **integrity_check=ok, FK=0, esquema/checksums 001–025 intactos, mismos objetos y recuentos en las 88 tablas, lectura completa de 10.117.750.784 bytes y hash del snapshot correcto**. Incluye 146.475 noticias, 295.076 revisiones de noticias, 356.701 evidencias del agente y 42.383 velas. SHA256 de la imagen validada antes de la prueba de escritura: 70278475c0611a17125300ff10883fcd87115a1c8889dad7f0829627e8ac7806; los metadatos de la base pueden cambiar al abrir un escritor.

Prueba de aplicación posterior: StorageManager ready, SQLite 3.53.4, un escritor, query/analysis readonly/query_only, escritura con rollback invisible para el lector, lectura de noticia y comparaciones, evidencia reparada legible a través del query worker, cierre limpio y sin owner residual. No arrancó el servidor ni consultó proveedores. El índice C contiene 0 publicaciones y las facetas B están pendientes de backfill: no se declara cobertura histórica enriquecida.

Evidencia privada: `/srv/bitcoin/ogid/recovery-20261026-183735/{reconstruction-proof,validation-result,application-probe,activation}.json`; resúmenes copiados a `.implementation-evidence/2026-10-26/recovery/`. Los scripts de recuperación están en ese directorio privado del workspace. La imagen con placeholder sigue siendo sólo de análisis; no confundirla con la base reparada seleccionada. El límite temporal del sistema de aprobación de la sesión anterior se superó al reanudar; no queda ninguna acción bloqueada por él. El primer intento de activar guardó la configuración privada pero falló antes de modificar .env; la repetición corregida terminó correctamente.

Informe publicable: [RECUPERACION.md](RECUPERACION.md). Matriz de entregas y criterios pendientes: [CIERRE-FINAL.md](CIERRE-FINAL.md).

## Alcance vigente y punto de continuación

C y la preparación de D están terminadas en el alcance técnico de este cierre autorizado para publicación. La nueva autorización de recuperación sustituyó la suspensión anterior de copias/forense únicamente para resolver este incidente; ese lote ya está cerrado. No repetir la recuperación ni las verificaciones completas de integridad sin cambios o indicios nuevos. El usuario conserva la tarea de backup manual; la imagen parcial no es un backup aceptado.

El esquema operativo es **025**. Las migraciones 023–025 se aplicaron al original el 26/10 a las 17:54:52 UTC y se conservaron exactamente en la base reparada. No editar migraciones aplicadas; el siguiente cambio aditivo empezará en 026. La recuperación no demuestra una causa física del fallo ni explica retrospectivamente todas las latencias v19.

Siguiente implementación de producto: **D.1**, desde ENTREGA-D.md. Se recomienda antes cerrar instalaciones y enriquecimiento histórico según CIERRE-FINAL.md. Conservar el código C/renewalId y la ruta operativa reparada. Dependencias operativas comprobadas de nuevo: backend 8 discrepancias y MCP 1 frente a locks; no se han reinstalado. Arranque sólo con `cd backend && npm start`. El cambio de base no acredita aceptación operativa, 24 h continuas ni promoción semántica de IA.

## Entrega C — implementación actual

- `025_news_comparisons.sql`: grupos y versiones, asignaciones históricas, publicaciones derivadas por revisión, afirmaciones inmutables, relaciones revisadas, auditoría idempotente y registro secuencial durable. Artículos, IDs, aliases, revisiones y snapshots originales se conservan.
- `comparisonFacts.js` / `newsComparisons.js`: asociación candidata por tipo, lugar exacto, contexto temporal explícito y ancla de seis horas; EN/ES/FR/DE/PT. Contexto insuficiente, varias localizaciones, fecha de publicación desconocida o idioma no soportado conservan publicaciones individuales. No se afirma ocurrencia ni independencia. Máximo 500 miembros por grupo y 64 candidatos; límites explícitos.
- Afirmaciones extractivas del titular y extracto permitido, atribuidas al editor de la publicación, con modalidad, idioma, alcance y evidencia `articleId + articleRevision + textHash`. No son extracción general de todas las proposiciones/personas ni una verificación factual. Los vínculos de apoyo/contradicción/contexto son revisiones de operador con motivo y referencias; las pistas automáticas sólo describen candidatos de la página devuelta.
- `merge`, `split`, `origin` y `claim-link` registran revisor, motivo, evidencia e idempotencia. Merge/split bloquean las asignaciones revisadas frente al agrupador. Las correcciones conservan afirmaciones antiguas consultables con `current=false`.
- Cinco operaciones nuevas API/MCP, contrato **1.11.0**, inventario **92 rutas / 101 operaciones**. Lecturas en query worker readonly/query_only; revisiones en escritor con permiso `news:comparisons:write`. Cursores fijan secuencia y ventana; páginas limitadas por filas y bytes.
- Vista `/comparisons.html`, enlaces desde tarjetas y navegación. Editor/origen desconocido, modalidades, revisiones y referencias visibles; relaciones revisadas por afirmación con paginación.
- El backfill existente cambia a sufijo `comparisons-v1`: reanuda por páginas en el mantenimiento determinista actual. 025 no escanea todo el corpus; no se ha ejecutado el backfill operativo ni se declara cobertura histórica completa.

## Histórico del primer cierre C — sustituido por CIERRE-C.md

C queda **implementada y verificada en aislamiento**. Su esquema se aplicó a la base configurada; publicación, backfill y aceptación operativa siguen separados. No hay fallos de pruebas conocidos pendientes en el candidato final.

| Comprobación real | Resultado y evidencia privada en .implementation-evidence/2026-10-26/ |
|---|---|
| Migración real | 022→025, sin backup/test previo, 17:54:52 UTC. Lectura posterior de metadata/checksums correcta y sin owner residual: c-schema-after.json |
| Backend completo | Primera pasada: 1.064/1.067, tres expectativas antiguas fallidas (contrato, detalle sin SQLite y cursor de backfill). c-backend-suite.log |
| Corrección de esos tres fallos | Archivos afectados: 10/10, c-backend-regression-final.log. No se repitió la suite completa sin necesidad |
| Regresión final de superficies | 25/25 C + editorial + contratos + B: c-final-targeted.log. Después, 9/9 C por ajustes de cabecera corregida e historial público: c-corrections-final.log y c-audit-final.log |
| MCP completo | 32/32, incluido stdio real de C: c-mcp-suite.log. Tras precisar proyección/relaciones históricas: stdio C 1/1, c-final-stdio.log |
| Check/build/inventario | Build backend/frontend correcto; MCP check correcto; inventario 92 rutas / 101 operaciones; sintaxis de todos los JS cambiados y git diff --check correctos |
| UI real con fixtures | Firefox a 390 y 1280 px, sin overflow; 10 publicaciones iniciales y 13 al paginar; texto HTML escapado, origen desconocido, relaciones y foco correctos. c-browser-accepted.log y C/browser/ |
| Dependencias | Sin cambios de manifests/locks. Se reutilizan auditorías verdes del cierre B; no se repitieron ni se instalaron dependencias operativas |

Los fallos y repeticiones se conservan. El runner inicial sin permisos efectivos no pudo arrancar; la repetición host expuso una expectativa incorrecta del fixture (el backfill A puede añadir revisiones de metadatos). Se corrigió para comprobar la inmutabilidad de cada revisión anterior. La primera prueba visual usó memoria donde SqlNewsArchive necesita un archivo para su lector readonly; se corrigió el fixture. Firefox detectó pérdida real de foco al ocultar el botón de última página: se captura el foco antes de deshabilitarlo y se lleva a la primera publicación nueva sin mover scroll.

Identidad de runtime candidato local (no release operativo): artifactHash `a1955bf38031c2d7fca7acace2fa87eb45650d5c43f4704969d02cd29aa0679a`, contrato **1.11.0**, HEAD B + diff. Manifiestos privados: c-identity.json y c-review-manifest.json. El hash del backend no incluye frontend/docs; el manifiesto de revisión identifica también esos archivos. Pruebas con Node 24.22.1 en instalación aislada; Node host 22.23.3 aplicó el esquema.

**Siguiente implementación: D.1**, después del lote operativo acotado recomendado arriba y descrita en [ENTREGA-D.md](ENTREGA-D.md): consumidor transaccional de revisiones de noticias y awareness, cursor durable, outbox idempotente y backlog visible. Cuando el usuario continúe D, empezar ahí, conservar este diff y usar 026 o posterior para cambios de esquema. La recuperación posterior ya está cerrada: no volver a ella ni repetir suites cerradas sin cambios, fallos o dudas nuevas. No hay procesos propios de validación prolongada pendientes.

## Resumen frente al diagnóstico del 25/10

| Fase / entrega | Estado real |
|---|---|
| 0 · Base operativa | Parcial. Recuperación cerrada y base reparada seleccionada, sin pérdida; almacenamiento real verificado. Dependencias operativas, mediciones 0.2, puesta en servicio y observación continua pendientes |
| 1 · A, identidad y clasificación | Implementada, verificada y publicada: `9cbdef2529d0a332d229824636818d250883c0eb`. Esquema correspondiente aplicado; backfill/aceptación operativa pendientes |
| 2 · B, fuentes y cobertura | Implementada, verificada y publicada: `9a3aa2fb4e58b7fd1342f835288b843e1b06e2a9`. 024 aplicada; sin dataset político incorporado, se muestra sin evaluar |
| 3 · C, comparación y afirmaciones | Cierre técnico verificado 1071/1071 + 32/32, listo para el commit del conector que incorpora este checkpoint; 025 aplicada. Puesta en servicio histórica/24 h separadas |
| 4 · D, situaciones y motor 24 h | Preparada documentalmente. Pendiente de implementación del consumidor transaccional, dominio y emisión; el journal de C no cierra D |
| 5 · E, piloto y fuentes | Pendiente. Matriz inicial en FUENTES.md, sin piloto ni RU/UK evaluados |
| 6 · F, analista e impactos | Pendiente. IA existente en shadow, promoción semántica separada |

## Restricciones y límites persistentes

Un escritor; lectores readonly/query_only; sin elevar límites/guardias, red ni inferencia en escritor. Preservar leases/fences/recibos, política de contenido, históricos y snapshots. Arranque exclusivamente `cd backend && npm start`, hijos controlados por `.env`, conservar llama.cpp. La publicación C está autorizada mediante conector; no implica despliegue ni promoción IA. La selección de base operativa reparada fue autorizada y completada; conservar el original y no restaurarlo como alternativa sana. Backup manual del usuario; no vaciar ni sustituir datos fuera del alcance autorizado.

El control `renewalId` de 0.2 permanece en el diff y sus pruebas; no demuestra retroactivamente la identidad de las tres reconciliaciones v19. Las instalaciones operativas siguen sin alinearse a locks; las pruebas usan la instalación aislada Node 24.22.1 en `/tmp/ogid-evidence-validation-ob4kdkj3`. Los logs privados preservados en el workspace permiten reanudar aunque desaparezca `/tmp`.

## Cortes históricos — no son el siguiente paso vigente

Las referencias a esquema 022, copias obligatorias, procesos activos y siguiente acción de 0.2 reflejan cortes anteriores a D27. Se conservan por trazabilidad y quedan sustituidas por el alcance y checkpoint de arriba.

## Histórico de 0.2 — acceso resuelto; backup impedido por EIO del origen

El usuario autoriza verificar escritura y continuar la copia consistente; durante las esperas se avanza en preparación/reproducciones de 0.2. Se preserva el cambio local previo de este documento. El sandbox normal sigue mostrando ro, pero la ejecución autorizada fuera de él permite escribir, fsync, releer y eliminar un archivo temporal en el directorio de validación. No se han cambiado permisos de archivos ni remontado volúmenes.

Volume-check completado en HDD: SQLite 3.53.4, WAL, lector concurrente, exclusión de escritor, recuperación de commit y rollback de transacción interrumpida correctos; integridad OK. Es una prueba temporal, no certifica el volumen a largo plazo.

Cohorte privada nueva: `/srv/bitcoin/ogid/reorganization-20261024/validation/ogid-0.2-20261026-eiep72z7`. Origen operativo leído readonly/query_only, 10.117.750.784 bytes, esquema 022, checksums 001–022 coincidentes, WAL de 0 bytes y sin procesos habituales de backend/observador detectados. Candidato: 9a3aa2f. Destino de baseline: `baseline-022.sqlite`; segunda copia prevista: `candidate-024.sqlite`. Preservar el baseline sin migrar.

Antes de la operación larga: runner privado `.implementation-evidence/2026-10-26/0.2/backup-runner.mjs`, ejecutado con Node 24 y dependencias aisladas. Usa createStorageBackup existente, añade sólo trazas de progreso/etapas en su proceso y no cambia los límites ni la lógica de backup. Log durable: `backup.log` en la cohorte; éxito requiere `backup-result.json` con integridad/FK correctas, esquema 022 y SHA256. Si falla, revisar `backup-failure.json`; no dar por válida una imagen parcial. Siguiente acción: recuperar ese resultado antes de crear la copia de trabajo y aplicar 023/024 únicamente allí. No se inicia operación ni C.

Resultado del primer intento de esta cohorte: SQLITE_IOERR durante la fase de copia, tras 149,3 s y antes de integrity_check/FK. El helper eliminó el parcial; no existe baseline aceptado. Evidencia en backup.log y backup-failure.json. El HDD tiene escritura efectiva y espacio suficiente; dmesg no permite lectura desde esta sesión. Se están aislando lectura del final del origen y escritura/fsync temporal del destino. El addon de better-sqlite3 reduce el código de sqlite3_backup_step a su byte primario; ese error no identifica por sí solo la causa física. No repetir la misma copia sin evidencia nueva.

Aislamiento posterior: lectura directa del último GiB del origen devuelve errno 5 (Input/output error), mientras que escritura y fsync de 1 GiB temporal en HDD terminan correctamente (11,3 s; archivo eliminado). El montaje de destino ya no es el bloqueo efectivo; hay un fallo real de acceso al archivo origen, aún sin causa física identificada. No usar recuperación que descarte páginas ni restaurar una imagen anterior sobre la base actual. El avance en reproducción sobre corpus y migración 022→024 queda condicionado a obtener una imagen íntegra.

Diagnóstico acotado de las 16:32 UTC: páginas aisladas al principio, al inicio del último GiB y al final son legibles, pero una lectura secuencial encuentra EIO en una petición de 4.194.304 bytes desde offset 9.685.958.656 (rango 9.685.958.656–9.690.152.959; no se ha delimitado una página exacta). Durante esa lectura, corruption_errs de Btrfs /dev/sda3 pasa de 7 a 10; write_io_errs/read_io_errs/flush_io_errs siguen en 0. Los contadores previos eran históricos; el incremento sí se observó en la nueva lectura. Esto identifica un problema de integridad al acceder al origen, sin demostrar aún avería física del SSD ni explicar retrospectivamente los episodios de latencia v19. El tamaño y mtime nanosegundo del archivo principal original permanecen iguales al preflight. Las aperturas readonly de SQLite pueden coordinarse mediante SHM; no hay escrituras de negocio, migraciones ni sustituciones del archivo principal.

Evidencias nuevas: `io-probes.json`, `source-io-diagnosis.json` y `source-tail-range.json` en la cohorte HDD. El parcial se eliminó por el helper. No hay baseline aceptado ni candidate-024.sqlite. No se ha ejecutado reparación, scrub ni restauración. Se ha solicitado al usuario la salida de lectura `sudo dmesg --level=err,warn --ctime | tail -n 80`, porque dmesg devuelve Operation not permitted en este entorno. Mantener la pregunta pendiente y no repetir lecturas del rango fallido sin una razón nueva.

Kernel recibido del usuario: BTRFS csum failed, root 257, inode 821869, offset 9685962752, csum observado 0xb97b3fc7 frente a 0x30a8db53 esperado. Coinciden subvolumen/inode del origen y el intervalo de EIO. Se repite desde el 26/10 a las 10:51:48 hora local, antes de esta copia. Con página SQLite de 4096 bytes corresponde a página 2364738. Lectura únicamente de cabecera y un trunk permite enumerar las 523 páginas libres (recuento coherente); la afectada no está libre. Falta identificar qué objeto/registro usa esa página. El OOM del 25/10 a las 16:13 que mató llama-server es un incidente distinto, no una causa demostrada del checksum.

Inventario de recuperación: `/srv/bitcoin/ogid/backups/pre-shadow-20261025-001503.sqlite`, 7.582.167.040 bytes, esquema 022, WAL 0, última recepción de noticia 2026-10-24T17:29:07.758Z. Es anterior a la base dañada: no sustituirla ni atribuirle cobertura actual. Se inicia su comprobación readonly/query_only con integridad/FK y hash; script privado check-historical-backup.mjs, log historical-backup-check.log y resultado historical-backup-check.json en la cohorte. Recuperar ese resultado al reanudar: todavía no marcar este respaldo como verificado. No se restauran ni migran datos.

Avance independiente durante la espera: reproductor privado `.implementation-evidence/2026-10-26/0.2/status-copy-benchmark.mjs` preparado. Abre sólo una copia de trabajo readonly/query_only; compara orden y tiempos de consulta anterior/paginada y status completo, conserva planes y SQL sin bindings, y declara la caché y falta de carga de escritor. Sintaxis verificada; la prueba de su guardia devuelve BACKUP_NOT_VERIFIED antes de abrir una base. Su comportamiento y latencias sobre corpus quedan **pendientes**, no verificados. El runtime aislado al que apunta está en /tmp; si desaparece debe reconstruirse desde el commit y locks sin instalar sobre la operación.

Cambio local independiente: StorageManager incluye renewalId válido y acotado sólo en diagnósticos de heartbeat, para enlazar el comando con su recibo heartbeat:<renewalId>. No registra owner, progress o argumentos arbitrarios. No cambia leases, límites, reintentos ni persistencia. Regresiones dirigidas 29/29, suite backend actualizada 1.058/1.058, MCP 31/31 y check correctos (logs privados 0.2). La primera prueba dirigida escuchaba el nombre equivocado del evento; corregida a control-delayed, sin cambiar comportamiento. El código no está publicado ni operativo; conservar diff local y distinguirlo del commit B ya cerrado.

Verificación histórica de heartbeat: tres pares control-reconciling/reconciled con el mismo commandId/jobId/fence, resueltos a 8.233 / 6.405 / 5.795 ms; cola 0 / 1 / 1 ms. Lectura acotada readonly/query_only localizó un recibo durable temporalmente compatible en cada ventana. Resultado posterior de jobs: uno completed y dos failed. Los logs antiguos no guardan renewalId/owner, por lo que no se afirma el vínculo histórico exacto del recibo ni éxito semántico. Evidencia heartbeat-reconciliation-review.json; el cambio de diagnóstico cubre nuevas cohortes, no reescribe evidencia pasada.

El usuario no conoce otra copia posterior. Se prepara una imagen **parcial de análisis** en HDD: forensic-source-022.img.partial y mapa forensic-image-map.json. El bloque con checksum fallido queda marcado como desconocido y no se vuelve a leer; cualquier otra página ilegible se registra, con máximo de daño acotado. Los placeholders no son datos recuperados. acceptedBackup=false/migratable=false; jamás usar esta imagen para puesta en servicio, benchmarks de aceptación o migración. Objetivo: investigar el objeto afectado en una copia, preservando el original y el respaldo histórico. Runner privado forensic-image.py; log forensic-image.log; recuperar su resultado al reanudar. Las inspecciones acotadas de punteros B-tree en origen no encontraron aún al propietario antes de su límite y no permiten inferirlo como página libre, índice o overflow.

Imagen parcial completada: 10.117.750.784 bytes, un único rango desconocido marcado de 4096 bytes en offset 9685962752; fuente principal sin cambios y WAL 0. Se mantiene acceptedBackup=false. La primera pasada se detuvo ante lectura corta antes del hueco; el prefijo y su informe se conservaron y la reanudación maneja correctamente retornos parciales de pread. FIEMAP delimita el extent lógico 9685884928–9685987327, sin flag encoded reportado: no se atribuye el alcance a compresión. La imagen se dejó 0400 y tiene SHA256 propio (no es el hash del origen). Evidencias forensic-image-map-attempt1.json, forensic-image-map.json y source-extent-map.json.

Chequeo estructural de la imagen parcial en curso: sesión 56971, log partial-image-diagnosis.log, resultado partial-image-diagnosis.json; SQLite sistema 3.51.2, readonly/query_only/immutable, caché 128 MiB y quick_check máximo 20 mensajes. Investiga estructura y objeto afectado; ningún resultado convierte placeholders en datos válidos. El chequeo histórico independiente sigue abierto hasta que historical-backup-check.json confirme integridad/FK/hash; no presumirlo por el nombre del archivo. Candidato de código local: base 9a3aa2f + diff de diagnóstico, artifactHash 92da2408a9d21d020bcfef7e14589a2db1c690dbf1d66b636a19a11af63a8b17; contrato 1.10.0. No es el release operativo.

Siguiente acción vigente: recuperar los resultados de historical-backup-check.json y forensic-image-map.json. La verificación histórica sigue activa (sesión 24778, PID host 650821); el último control a las 17:03 UTC mostró lectura en avance y RSS 158 MiB. La imagen parcial sólo se investiga si el mapa confirma finalización y fuente sin cambios; el script preparado inspect-partial-image.py la abre mode=ro&immutable=1, ejecuta quick_check con progreso y mantiene acceptedBackup=false. Después preparar una estrategia de recuperación en copia que preserve el origen y cuantifique la cobertura faltante. El kernel ya confirmó el fallo de checksum en la base actual. La anterior barrera de permisos quedó superada por ejecución autorizada fuera del sandbox; el bloqueo actual es el EIO reproducido y el incremento de corrupción Btrfs. Después de resolverlo, abrir una cohorte nueva, crear/verificar el backup y proseguir sobre una copia de trabajo. No avanzar la migración ni la puesta en servicio sobre una copia incompleta. Los hitos de preparación independientes pueden continuar; las nuevas entregas conservan el alcance del plan.


## Checkpoint anterior de reanudación — 15:59 UTC

Reanudación solicitada por el usuario. Entrada sin diff ni cambios pendientes; los 42 archivos del manifiesto B coinciden byte a byte con sus hashes de cierre. El remoto sigue en B, sin commits adicionales; [CI B 40352199252](https://github.com/Santiagovargas32/ogid/actions/runs/40352199252) completada correctamente, verificada de nuevo por conector GitHub. Se conservan los resultados de suites cerradas: no se han repetido.

Comprobación actual de 0.2: base operativa de 10.117.750.784 bytes, WAL de 0 bytes, esquema efectivo 022 leído con `mode=ro` y `query_only=ON`; checksums 001–022 coinciden con el candidato, que espera 024. `/home` (Btrfs) y `/srv/bitcoin` (ext4) siguen montados `ro`; el directorio HDD previsto no permite escritura. No se ha repetido el backup fallido ni ejecutado una migración. `/tmp` tiene unos 7,4 GiB disponibles, menos que la imagen de la base; no sirve como destino completo. Estas comprobaciones no certifican integridad ni equivalen a un backup.

Instalaciones operativas: Node 22.23.3; ocho discrepancias backend y una MCP respecto a sus locks. Zod sigue en 4.5.4 backend / 4.6.5 MCP, frente a 4.6.7 esperado. No se han instalado paquetes. No se encontraron procesos con las entradas habituales `server.js` u observador en la vista de procesos accesible; el health del conector respondió `CONNECTION_FAILED` a las 15:59:01 UTC. Esto acredita falta de conectividad desde este entorno, no la causa de una caída.

Evidencia privada actual: `.implementation-evidence/2026-10-26/resume-20261026T155941Z/`; contiene preflight, comprobaciones remotas y estado de dependencias. La única modificación publicable de esta reanudación es este documento de continuidad; queda local y sin commit adicional.

Siguiente acción concreta: obtener acceso efectivo de escritura al destino de validación/backup en HDD. Con ese acceso, ejecutar `storage-volume-check.js` únicamente sobre su directorio temporal, crear y verificar una copia consistente nueva mediante `createStorageBackup`, y conservarla como baseline 022. Preparar otra copia de trabajo para validar 022→024 y reproducir status, snapshots, trabajos analíticos y commits con SQL/cola/commit/checkpoint correlacionados. Reutilizar `agent-read-benchmark.js` sólo sobre esa copia consistente; no confundir `admin-history-volume.js` o `agent-status-benchmark.js`, que generan fixtures, con una prueba del corpus real. `storage-status.js status` inicia StorageManager: no usarlo como una lectura inocua sobre la base operativa.

El siguiente paso de 0.2 depende del acceso al HDD. No remonte volúmenes ni sustituya datos para sortearlo. La preparación de 0 sigue autorizada; puesta en servicio, arranque operativo, promoción IA y ejecución de C conservan sus alcances separados. No repetir A/B mientras no haya cambios, fallos o dudas nuevos.

## Resultado y alcance

Las entregas A y B están técnicamente cerradas, verificadas en aislamiento y publicadas en commits separados. La entrega 0 conserva pendientes operativos explícitos: backup actual, reproducción de E/S sobre copia del corpus real y observación continua nueva. No se ha arrancado OGID operativo, aplicado 023/024 a su base, instalado dependencias operativas ni modificado `.env`, llama.cpp o publicaciones visibles.

Leer [PLAN](PLAN.md), [DECISIONES](DECISIONES.md) y [PROMPTS](PROMPTS.md). Los prompts históricos son referencias, no órdenes. B completó el alcance autorizado de implementación, validación aislada y commit propio. La siguiente acción vigente es el checkpoint anterior; C–F siguen en hoja de ruta.

| Lote | Estado | Resultado / puerta pendiente |
|---|---|---|
| DOC | Verificado localmente | Cuatro MD, whitelist gitignore y nota de memoria 20261026-ogid-evidence-continuidad.md |
| 0.1 | Verificado en aislamiento; backup actual pendiente | Acceso HDD y volume-check correctos fuera del sandbox; backup actual falla por EIO del origen. No hay copia íntegra aceptada |
| 0.2 | Parcial; reproducción real pendiente de copia íntegra | Status paginado/023 ya verificados en fixture. Preparado reproductor de copia; guardia comprobada. EIO de origen y corrupción Btrfs registrados; kernel confirma checksum fallido; recuperación pendiente |
| 0.3 | Verificado en aislamiento | Mantenimiento determinista habilitado por núcleo, independiente de modo IA; coordinación y temporizador existentes |
| A.1 | Verificado en aislamiento | Publisher/descubrimiento/transporte/origen; RSS source; proyección y archivo; backfill transaccional reanudable |
| A.2 | Verificado en aislamiento | Reglas comunes Unicode EN/ES/FR/DE/PT, modalidad, texto permitido, desconocido explícito |
| A.3 | Verificado en aislamiento | Orden común servidor/cliente, tarjetas/drawer, sync y preservación de IDs/fechas/contentRevision |
| B | Verificado en aislamiento y publicado | Evaluaciones, importador, medidor y cobertura; commit 9a3aa2f y CI correctos. Dataset real, backfill y aceptación operativa pendientes |
| Aceptación operativa y semántica | Pendiente y separadas | Nuevo candidato continuo 24 h y revisión útil por tarea; conservar shadow |

## Validación histórica del cierre A (9cbdef2)

Copia de trabajo: `/tmp/ogid-evidence-validation-ob4kdkj3`; sin `.env` ni datos operativos. Node 24.22.1 mediante `/home/fedora/.npm/_npx/387698761821791d/node_modules/node/bin/node`. Los checks de sintaxis incluyen frontend. Las suites sólo utilizan proveedores simulados, bases propias y puertos efímeros.

| Comprobación | Resultado | Evidencia privada |
|---|---|---|
| Backend completo Node 24 | 1.047/1.047; cero fallos/skips | `ogid-evidence-backend-suite-release.log` |
| Check y build backend/frontend | Correctos | `ogid-evidence-backend-build-release.log` |
| Compatibilidad Node 22.23.3 | 29/29 dirigidas, cero fallos/skips | `ogid-evidence-node22-release.log` |
| MCP | 30/30, check e inventario correctos | `ogid-evidence-mcp-suite-release.log`, `ogid-evidence-mcp-check-release.log`, `ogid-evidence-mcp-inventory-release.log` |
| Inventario | 83 rutas / 92 operaciones | `ogid-evidence-mcp-inventory-release.log` |
| Auditoría runtime backend / MCP | Cero vulnerabilidades en ambos | `ogid-evidence-backend-audit.log`, `ogid-evidence-mcp-audit.log` |
| Instalaciones aisladas | Manifest matched: backend 137 paquetes runtime, MCP 3; locks sin cambiar | Manifiesto y comprobación de instalación |
| Persistencia | Migración 022→023 en fixture; checksums 001–022 intactos, integridad OK, FK=0; replay/cursor/rollback y revisión congelada | Suite y benchmark |
| Higiene | git diff --check correcto; sin candidatos .env/DB/logs/node_modules | `review-manifest.json` |

Evidencias conservadas en `.implementation-evidence/2026-10-26/` dentro del workspace, directorio privado e ignorado por Git. `review-manifest.json` registra archivos, hashes y exclusiones. No depender de `/tmp`: los logs completos de esta sesión se copiaron allí, incluidos fallos y repeticiones.

Comandos reproducibles, con cwd backend de la copia aislada y Node 24 en PATH: `npm ci`, `npm run check`, `npm test`, `npm run build`, `npm audit --omit=dev --audit-level=high`. En integrations/ogid-mcp: `npm ci`, `npm run check`, `npm test`, `npm run inventory:check`, auditoría equivalente. El primer npm ci falló por DNS y pruebas HTTP por EPERM en sandbox; repeticiones con permisos efectivos correctas. La primera suite completa detectó el publisher heredado y tres expectativas de esquema 022: se corrigieron conservando el contrato y verificando 023 aditiva. El fallo de presupuesto 8 KiB se corrigió compactando metadatos repetidos, sin ampliar límites. Todos esos logs se conservan. El inventario detectó además una nota añadida manualmente al MD generado: se trasladó al generador y se regeneró con npm run inventory; inventory:check final correcto. El catálogo de idiomas del feed no se usa como idioma observado del ítem; se verifica en regresión. El esquema aplicado se distingue del esperado también en la proyección de health/MCP.

## Medición de status y límites de la evidencia

Reproducción: `node backend/scripts/agent-status-benchmark.js` desde raíz. El script genera exclusivamente un fixture SQLite en memoria de 100.000 jobs; nunca acepta una ruta operativa. Cincuenta muestras por cohorte del candidato final: página anterior p95 36,088 ms / máximo 40,035 ms; página nueva p95 0,056 ms / máximo 0,171 ms; status completo p95 7,159 ms / máximo 7,710 ms. El plan pasa de scan + TEMP B-TREE a índice parcial ordenado. Mantiene orden activo primero y resultados. Se añadió además una transacción de lectura y regresión con transición concurrente para impedir duplicados entre las dos páginas.

Son medidas del fixture con Node 22.23.3, no un SLO ni una prueba de disco frío/concurrencia del corpus operativo. Los episodios reales de 25 s no quedan explicados por este benchmark.

UI: pasan las regresiones de datos, orden, actualización, foco/scroll y estáticas existentes. No se realizó revisión visual manual en móvil/LAN. El soporte lingüístico es un conjunto de reglas versionadas y acotadas; no equivale a NLU general ni a una evaluación editorial de 300 publicaciones/100 incidentes.

Backfill preparado: máximo 100 referencias y 128 KiB por página, presupuesto objetivo 50 ms (acotado a 100 ms configurable), cursor y metadatos en el mismo commit y recibo idempotente. Un registro mayor devuelve NEWS_METADATA_ROW_TOO_LARGE sin saltarlo. Una página por tick existente; sin hidratación histórica completa al arrancar. No se ha ejecutado contra la base operativa ni se declara cobertura histórica enriquecida completa.

## Baseline v19 conservado

Archivos privados originales: `.agent-validation/shadow-24h-v19-20261025-111926/{summary.json,samples.jsonl}` y `.agent-validation/shadow-backend-v19-20261025-111537.log`. `.agent-validation` enlaza al HDD. No se modificaron estos originales.

Reproducir desde raíz: `node backend/scripts/shadow-baseline-report.js .agent-validation/shadow-backend-v19-20261025-111537.log .agent-validation/shadow-24h-v19-20261025-111926`.

Observador: 25/10/2026 10:19:27.448Z → 26/10 10:13:34.402Z; 1.430 muestras, interrupted, completedObservation=false, backendChanges=0. Health/readiness 200 en todas; tres timeouts de agent. SinceCounts al cierre: completed 42, failed 175, incomplete 2, running 1. No confundir con jobs históricos ni con fallos del log completo.

Log: 129.680.810 bytes, SHA256 `c6ac5a6666e98e8858967896dbf7bce95f182d53a994bc2f09447860a5a3def1`. Hasta 26/10 10:35:08.745Z; SIGTERM 10:34:37.269Z, cierre limpio. 179 intentos terminales únicos fallidos en esa ventana, 76 UNVERIFIED_NUMBER y 40 INVALID_PUBLICATION; tres reconciliaciones control recuperadas. SQL lento máximo 25.294 ms, commit 23.380 ms. Son observaciones, no causa física ni puerta continua de 24 h.

Hashes del observador: samples `816374c1a5d9b83b1d1e5fa8163c192e70b1594cf8c02cea25b70f54dab8085d`; summary `46c6c36504e4d9b7347e75203db7c3ad21ab4500f208a58dd24be69aaa6ec306`. El informe reproducido está en `ogid-evidence-v19-baseline.json`.

## Limitaciones operativas del corte A y trabajo 0 pendiente

En el corte operativo inicial, la base configurada estaba en SSD `/home/fedora/.local/share/ogid/db/ogid.sqlite`, esquema 022 confirmado por lectura readonly/query_only. El backup consistente con helper existente falló con SQLITE_IOERR; `/home` y `/srv/bitcoin` se exponen como ro en este entorno. No hay copia actual certificada y no se ha aplicado 023. No remonte volúmenes ni restaure una base antigua para obtener verde.

En ese mismo corte las instalaciones operativas estaban detrás de los locks. El nuevo manifiesto detecta ocho discrepancias backend (incluido Zod 4.5.4 frente a 4.6.7) y Zod MCP 4.6.5 frente a 4.6.7. Sólo la copia aislada está alineada. ArtifactHash de código candidato: `ea1cd62790fe86bba4f18fa91c3197f14a69607f7de309d0341964eda5ab9f92`; no acredita dependencias/configuración ni una versión operativa.

Siguiente acción de 0.2, actualizada tras B: cuando exista acceso efectivo para crear y verificar una copia consistente actual en HDD, reproducir allí status, snapshots, trabajos analíticos y commits, correlacionando SQL/cola/commit/checkpoint antes de atribuir causa física. Validar 022→024 sobre una copia de trabajo conservando checksums y hechos y reteniendo el backup original 022. Preparar después la puesta en servicio controlada del candidato, instalación desde locks y cohorte continua nueva; el arranque requiere su alcance operativo. Mantener separada la revisión semántica IA. No rehacer los lotes locales ya verificados ni repetir suites sin cambios o dudas nuevas.

Para reanudar: comprobar Git/diff y procesos actuales, leer este documento y continuar desde esa siguiente acción. Publicación sólo cuando se autorice, mediante conector GitHub y exclusiones existentes.

## Cierre de A y continuación autorizada

El usuario ha pedido cerrar A con commit en feat/agentic-intelligence y continuar B del mismo modo. El cierre publica A junto con las bases 0 dependientes y su documentación, sin convertirlo en aceptación operativa. Para B: evaluaciones versionadas por publisher/edición, importador de datos autorizados, tendencia del medio accesible y cobertura por medios/idiomas/regiones, con propiedad/origen conocidos separados. No hay dataset político autorizado disponible: dejar sin evaluar y probar con fixtures ficticios. Preparar un commit B separado al terminar.

Autorización de publicación mediante conector GitHub; no incluye PR, merge, arranque operativo ni promoción IA. Los límites de copia/volumen y las 24 h permanecen pendientes. Reanudar desde B después de verificar el commit A en GitHub.

## Cierre técnico B — verificado en aislamiento

A publicada mediante conector; árbol verificado de 46 archivos y sincronización local exacta. CI A: https://github.com/Santiagovargas32/ogid/actions/runs/40321335609 (completada correctamente).

B: repositorio temporal append-only de evaluaciones/perfiles por publisher y edición; importación operador con autorización de uso declarada y dry-run; lecturas acotadas current/asOf/knownAt, medidor con discrepancia/sin evaluar/no aplicable, y cobertura sobre facetas normalizadas de artículos anteriores al recorte. Datos políticos de producción inicialmente vacíos. Sin red al renderizar ni por tarjeta; consultas coalescidas y página Fuentes independiente.

B implementada, verificada y publicada en `9a3aa2fb4e58b7fd1342f835288b843e1b06e2a9`, con título `feat(sources): cerrar entrega B de evaluaciones y cobertura`. Base A: `9cbdef2529d0a332d229824636818d250883c0eb`. CI completada correctamente y remoto coincidente, verificados en el checkpoint de reanudación. El cierre técnico y publicación no aplican 024 a la base operativa ni acreditan cobertura real.

| Lote B | Estado | Evidencia / límite |
|---|---|---|
| B.1 Evaluaciones/perfiles | Verificado en aislamiento | Filas append-only por editor/edición, vigencia y registro, corrección/retirada, originales y permiso conservados; cursores fijan revisiones; desacuerdo/contextos separados |
| B.2 Importador/contratos | Verificado en aislamiento | Operador news:assessments:write, preview por defecto, 25+25 / 64 KiB, transacción y recibo durable; 4 operaciones nuevas, contrato 1.10.0 |
| B.3 Tarjetas/Fuentes | Verificado en aislamiento | Medidor accesible sin centro para desconocidos, lectura compartida y ligada al interés; foco conservado; detalle de evaluaciones/licencias; página Fuentes a 390/1280 px |
| B.4 Cobertura/matriz | Verificado en aislamiento | Facetas paginadas, archivo antes de selección, recepción ≤31 días; idiomas declarados/observados, menciones de países, propiedad/origen separados; [FUENTES.md](FUENTES.md) |
| Datos y operación | Pendientes | Sin dataset político real ni perfiles importados; no hay backfill operativo acreditado. Salud/adquisición y reportería regional pendientes de E |

Validación del candidato B (Node 24.22.1, copia aislada sin .env ni datos operativos):

| Comprobación | Resultado | Log privado B |
|---|---|---|
| Backend completo | 1.057/1.057; cero fallos/skips | ogid-delivery-b-backend-final.log |
| MCP completo | 31/31; cero fallos/skips, incluido stdio real de B y 8 KiB | ogid-delivery-b-mcp-release.log |
| Check/build backend y frontend | Correctos | ogid-delivery-b-build-final-node24.log, ogid-delivery-b-backend-check-final.log |
| Check MCP e inventario | Correctos; 87 rutas / 96 operaciones | ogid-delivery-b-mcp-check-final.log, ogid-delivery-b-inventory-final.log |
| Audits runtime backend/MCP | Cero vulnerabilidades, locks sin cambios | ogid-delivery-b-backend-audit.log, ogid-delivery-b-mcp-audit.log |
| Migraciones | 008/009 y 023→024 en fixtures, checksums previos y originales conservados, integridad/FK correctas | Suites completas y ogid-delivery-b-regression-node24.log |
| UI navegador | Firefox 157 headless: Fuentes sin overflow a 390/1280 px; componente medidor conserva foco y oculta marcador al retirar evaluación | browser/result.json, capturas sources-390.png y sources-1280.png |
| Higiene/publicación | Revisar manifiesto B-review-manifest.json y Git para el SHA resultante | Sin .env, DB, logs, modelos o dependencias versionados |

Evidencias de B conservadas en `.implementation-evidence/2026-10-26/B/`, privadas e ignoradas, con logs intermedios y fallidos. La primera suite detectó dos fixtures históricos que escribían con el repositorio actual antes de migrar; ahora se siembran con su esquema 008/009, sin debilitar guardias. El transporte MCP conserva los errores explícitos de B. La regresión de facetas detectó además una revisión innecesaria al releer la etiqueta canónica de un editor: se conserva su candidato original, manteniendo el rechazo de conflictos nuevos. La prueba final demuestra que el backfill no crea revisiones cuando los metadatos ya están completos. Los ensayos del navegador necesitaron perfil temporal y ruta BiDi /session; no se usó el perfil del usuario.

Los resultados de UI son de fixtures locales y comprobación del componente; no equivalen a revisión completa del dashboard en LAN/móvil real ni a evaluación de un dataset político. Las suites de B sí se ejecutaron con Node 24; la compatibilidad Node 22 dirigida que consta arriba corresponde al corte A.

Reversión: deshabilitar el consumidor/importador mediante una versión compatible conservando 024 y todos los registros. No usar DOWN ni arrancar el código A sin conservar el conocimiento de 024: el guard de migraciones rechaza un esquema por delante del código. Una corrección editorial se hace con una revisión nueva; nunca borrar sus originales.

La comprobación de commit B, CI y puertas 0 se completó en la reanudación de las 15:59 UTC. El siguiente paso vigente figura al principio: acceso efectivo al HDD, copia consistente y reproducción aislada 0.2. C sigue en hoja de ruta y necesita alcance de ejecución propio. Instalación/arranque operativo requieren su alcance separado y se realizan con npm. La cohorte continua nueva de 24 h comienza sobre el candidato final puesto en servicio. Mantener IA en shadow con puerta semántica separada.
