# D/0.2 — diagnóstico acotado de E/S, cohorte C-IO

Cohorte del **28/10/2026**; reconciliación y cierre documental del **29/10**. Seguimiento: [KAN-8](https://santiagovargasmunoz.atlassian.net/browse/KAN-8), **En progreso / P0**. No se declara resuelto el bloqueo ni aceptado E. No se implementó un parche de aplicación: la contribución mejor acreditada es presión de memoria/reclaim y competencia de procesos que comparten almacenamiento; falta aislarla de la latencia del dispositivo/Btrfs.

## Identidad y alcance

- Checkout inicialmente limpio: `dcde8bd959d504cf5a240ef47de4c18419ce5ac2`. `504df67`, `cfea52f` y `dcde8bd` comparten árbol `103233d276ebed42cdf30f24cd1501adf4117200`. D/0.2 ya estaba publicado. El 29/10 el usuario autoriza publicar el avance y los MDs mediante el conector GitHub en esta rama; no autoriza merge, despliegue, promoción ni otra operación del backend.
- Backend **`97d6ace9070bfdcc9c1392dda016146af6c013899567e58cbd5e2969bc2be706`**; MCP `35699f3793c75566e560cb052fd139cbfcc4c791a218b434901a85daef40a3c8`. Mismos hashes antes y al terminar. El diff sólo añade colector/pruebas y documentación; el indicador dirty del checkout incluye esos archivos, sin otro artefacto de negocio.
- Node **22.23.3**, contrato **1.12.0**, hash de contrato `d17de83ae09b45b6859544697a4cfd5905b03b8e09be2e14da850cb4a7e08d16`; instalaciones **138/3 paquetes matched**, sin discrepancias. Esquema efectivo **029 / 29 migraciones**, consultado en schema_migrations. Hash de 001–029 `e51e6c9352141951e61cc7710e5ec940d1ab1b888eddc42597e960794e668e36`, intacto.
- AGENT_MODE y broker/OpenCode/worker **off**, AI_PROVIDER=none, AI_MODE=off; AGENT_TASK_MODES={} y AWARENESS_MODE=visible conservados. Hash privado del .env idéntico al anterior. Base reparada, proveedores y llama.cpp sin cambios de esta tarea.
- Un único arranque mediante **`cd backend && npm start`**, sin mantenedor escritor adicional. No se repiten instalación, recuperación, backfill ni A–D. Se conservan escritor único, lectores readonly/query_only, FULL, fences/leases, guardias y reparación única. Sin E/F, modo a demanda ni observación formal de 24 h.

## Mapa del host observado el 28/10

| Uso | Ubicación / montaje | Dispositivo y capas |
|---|---|---|
| DB, WAL y SHM | `/home/fedora/.local/share/ogid/db/ogid-repaired-20261026-183735.sqlite`, sufijos en el mismo directorio; `/home` | Btrfs `/dev/sda3[/home]` → SSD SATA **sda, ADATA SU630, 223,6 GiB**, 8:0 |
| Checkout y evidencia persistente privada | `/home/fedora/ogid` | Mismo sda3/sda; no se suma aparte |
| Modelo mmap observado | `/opt/ai/models/openai/gpt-oss-20b/gpt-oss-20b-MXFP4.gguf`, montaje `/` | Btrfs `/dev/sda3[/root]` → mismo SSD |
| Scratch FrozenRows y log de C-IO | tmpdir `/tmp`, `ogid-frozen-*`; captura stdout/stderr en `/tmp/ogid-d02-io-20261028/backend.log` | **tmpfs, RAM**; no es otro disco. No se individualizaron otros posibles temporales internos de SQLite |
| Logs/validación históricos | `.agent-validation` → `/srv/bitcoin/ogid/reorganization-20261024/validation` | ext4 `/dev/sdb1` → **sdb**, HDD 931,5 GiB, 8:16, `rw,noatime,seclabel`; el log C-IO no se escribió aquí |
| Swap real | `/dev/zram0`, 8 GiB, prioridad 100 | RAM comprimida, **backing_dev=none**; no hay swap en sda/sdb |

`findmnt`, `lsblk` y /proc se consultaron fuera de la vista artificial del sandbox: éste ocultaba PID y mostraba montajes readonly de aislamiento. Los montajes reales de Btrfs estaban **rw**, con `relatime,seclabel,compress=zstd:1,ssd,discard=async,space_cache=v2`, subvolúmenes root/home; no se observaron capas dm/LVM/cifrado. Cola sda: **bfq**, nr_requests=64. Las tasas se calculan por **sda/sdb completos**; no se añaden sda3/sdb1 ni los bytes de zram a los del SSD.

RAM total **15.870 MiB**. Swap casi llena desde la línea base: no constituye por sí sola thrashing. Zram al preflight contenía unos 8,26 GB lógicos y consumía unos **6,28 GB de RAM**, sin respaldo de disco. Los límites cgroup visibles de los procesos relevantes y sus ancestros eran memory.max/high/swap.max=max, cpu.max sin cuota e io.max vacío donde era legible. Dos oom_kill históricos en system.slice no son OOM de esta cohorte; el delta global oom_kill observado fue **0**.

Procesos conservados por PID/starttime (ticks de /proc/stat, HZ del host): principal **1124214 / 61775020**; llama-server **698209 / 44440842** y **698253 / 44441039**. Code y Codex compiten realmente durante la ventana; por ejemplo Code 1091375/61365342 y Codex 1091929/61368733. Se detectó también un Node ajeno, cwd `/home/fedora`, que se conservó. No se suman RSS compartidos como memoria física única. Una lectura smaps_rollup de llama 698253 durante la cohorte mostró PSS ≈3,45 GiB y swap ≈5,35 GiB; no demuestra actividad de inferencia ni que ese proceso sea la única causa.

Btrfs: write/read/flush/generation **0**; corruption **19 → 19**, también 19 al retomar el 29/10. Datos single **94,19 %** de lo asignado; metadatos DUP **51,60 %**; unos **34,73 GB** libres estimados, reserva global usada 0. No se detectó error nuevo ni filesystem ro en las lecturas disponibles. `btrfs filesystem show` sin acceso al bloque imprimió MISSING; **sysfs devinfo/1/missing=0, writeable=1**: no se interpreta esa salida parcial como pérdida real del disco.

Kernel mediante journalctl: sin entradas en las ventanas consultadas; también se consultó el boot anterior al retomar. dmesg y stacks de hilos: acceso denegado. SMART instalado, pero smartctl -a /dev/sda devolvió **Permission denied**; NVMe no encontró topología y el dispositivo observado es SATA. Uso Btrfs sin detalle por dispositivo por falta de privilegios root. No se elevaron privilegios de usuario, resetearon contadores ni ejecutaron tests SMART/scrub/balance/defrag/reparación. Ausencia de mensajes nuevos no certifica toda la salud del dispositivo/controladora.

## Instrumentación, ventanas y cobertura

UTC para correlación; duraciones de intervalos con `time.monotonic`/performance. El **28/10 Europe/Madrid = UTC+1**: 21:17 UTC son 22:17 locales. Las horas siguientes son UTC salvo indicación contraria.

Baseline y carga comparten host, candidato e instrumentos; durante baseline hubo lecturas de identidad/mapa, sin suites ni benchmarks. No se vaciaron ni controlaron las cachés. La lectura readonly anterior al arranque también calentó páginas; startup y mantenimiento normal cambian después la residencia de memoria y el corpus. Proveedores conservados: newsapi/gnews/mediastack/rss, mercado Yahoo sin fallback configurado, awareness visible; backlog news inicial 128, posteriormente crece con adquisición. La composición de procesos ajenos no se fijó. Las diferencias impiden tratar baseline/carga como un experimento causal aislado; el host reiniciado del 29/10 tampoco es un control equivalente.

`observe-host-io.py` es un proceso externo, sin dependencia runtime nueva. Lee /proc/diskstats, /proc/*/io/stat/status, /proc/vmstat y PSI io/memory/cpu cada 5 s; observa hilos D y wchan. Identifica PID/starttime, selecciona consumidores observados y declara truncamientos/permisos denegados. No recoge argv, entornos o payloads. IOPS/caudal/await de lectura, escritura y flush y cola media son **deltas por intervalo**, sin promedio desde boot; primera muestra sin tasas. /proc/io no permite atribuir con precisión cada bio físico ni todas las escrituras de kernel. iostat y pidstat no estaban instalados; vmstat sí estaba disponible, pero se usaron sus contadores /proc equivalentes para una única captura sincronizada.

App: se reutilizó shadowSample, interceptando su health sin duplicarlo, y se añadieron comandos con requestId/despacho/fase, estado de mantenimiento, situaciones y tamaño físico WAL. Intervalo objetivo 10 s, HTTP con timeout, sin lector escritor extra. La consulta administrativa añade lectura de estado: un comando observado produjo 155.715 bytes; el observador no es coste cero. No se llamó admin.history. sqlActivity, commitActivity, checkpoint y diagnósticos existentes no se modificaron.

| Tramo | Ventana y cobertura conservada | Resultado |
|---|---|---|
| Baseline, backend parado | **21:17:18.219–21:20:18.219**, 180 s, **37 muestras** | MemAvailable ≥1.747 MiB, PSI memory full avg10=0; I/O full avg10 capturado hasta 4,84 %. Swap-in 6 páginas, swap-out 0; 50 major faults, reclaim directo 0 |
| Arranque C-IO | npm start aproximadamente 21:20:55; server_started **21:22:20.015**, primer ready 200 aproximadamente 21:22:27 | Mismo artefacto final; IA off y AgentMaintenance activo |
| Host bajo carga | Primer timestamp exacto conservado **21:21:29.246**; **82 muestras hasta 21:38:05.536**, con huecos | Se reprodujo presión grave; no es una serie regular completa ni 10 minutos sanos |
| Observador app | Objetivo 10 minutos tras readiness; lectura registrada a **21:36:58.264**, duración monotónica desde primer ready ≈887 s | El proceso/HTTP y sus timers se retrasaron; el límite objetivo no fue una garantía de ejecución en el host bloqueado. Recuento total y distribución completa perdidos |
| Corte y drain | Único SIGTERM por pidfd **21:38:01.268**; server_stopped **21:39:08.314** | Principal verificado; reporte con seis proyecciones inciertas, cierre **no limpio** |

Coste baseline: **1,127 s de CPU en 180 s** (~0,63 % de un núcleo), captura por muestra hasta **31,674 ms**, salida **690.319 bytes**. La medida inicial ru_maxrss heredaba un máximo ajeno al trabajo de muestreo y se descartó; el colector final informa VmRSS/VmHWM propios. Bajo carga se conservaron muestras de **17,1 MiB RSS**, HWM **17.512 KiB**, y CPU acumulada **5,799 s** a 21:38:05. No se dispone del coste completo del observador app ni de todo el final de captura. Se registró un hueco entre muestras de **83,388 s**, y /proc fue lento: no se presenta el coste ordinario como cota durante el bloqueo.

Límites previos al arranque: error nuevo de E/S/ro, StorageManager fallido, 90 s sin progreso con trabajo activo, PSI I/O full avg10 ≥50 % durante 30 s o PSI memory full ≥10 % con MemAvailable <512 MiB durante 30 s. **El corte manual llegó tarde**: la presión también retrasó herramientas/observador. La duración desde server_started hasta SIGTERM fue 15 min 41 s; no se declara cumplido el objetivo inicial de cortar a tiempo. No hubo segundo arranque, SIGKILL ni señales a grupos/procesos ajenos.

El primer intento del colector de carga falló por un campo vacío de /proc/status; se corrigió y reanudó **sólo el colector**, sin reiniciar OGID. Ese defecto también limitaba el detalle de hilos de la versión usada en baseline; sus contadores globales/disco/proceso se conservaron. Se añadió regresión. El observador es de recogida, **no un controlador automático de cierre**.

**Pérdida de crudos:** se guardaron temporalmente en tmpfs para no añadir E/S al SSD investigado. La tarea quedó interrumpida antes de archivarlos; el host reinició el **29/10 11:36:44 UTC**, y al retomar ya no existían. No se atribuye ese reinicio ni su motivo a esta tarea. Los números de C-IO anteriores proceden de salidas de herramientas conservadas en la conversación, **no de crudos reanalizables ni un log completo con hash**. Es un incumplimiento de conservación de evidencia y limita la aceptación. No se rellena el hueco ni se repite la cohorte para ocultarlo. La versión final ofrece archivo privado exclusivo, con fsync, **después de capturar**, fuera del intervalo medido; no protege frente a pérdida de tmpfs antes de terminar.

## Línea temporal y atribución

| UTC 28/10 | Observación | Interpretación y límite |
|---|---|---|
| 21:17–21:20 | Baseline tranquilo aunque zram casi llena; cola media sda capturada ≤0,468 | Swap ocupada no acredita presión activa; sin nuevo fallo de kernel/Btrfs en la cobertura disponible |
| 21:21:29 | Backend RSS ≈923 MiB; sda ~33,75 MB/s lectura, await R/W 0,261/2,024 ms, cola 0,952; hilo OGID folio_wait_bit_common | Lectura/carga de aplicación sobre caché limitada; no prueba defecto físico ni repetición semántica innecesaria |
| 21:22:43–21:23:00 | Commits FULL completados de **11,151 y 12,454 s** | Ya hay esperas de durabilidad; máximos de eventos, no percentiles de operaciones |
| 21:24:04 | MemAvailable ~690 MiB; cola 4,318, lectura ~29,62 MB/s, escritura ~34,88 MB/s; await R/W/flush 0,655/4,216/1,289 ms; OGID y Codex en blk_mq_get_tag | Contención compartida; %util por sí solo no localiza el límite del SSD |
| 21:24:21 | news **241112/241112**, awareness **3824/3824**; outbox/domino **24688** | Mantenimiento normal consumió los 128 pendientes iniciales y nuevas entradas; no se saltó cursor |
| 21:24:34 | MemAvailable **281 MiB**, varios consumidores en D. Deltas capturados desde inicio del colector: OGID ~1,779 GB read_bytes; sólo Codex 1091929+1122424 ~1,867 GB | Hay E/S atribuida a otros procesos comparable a OGID; read_bytes no es reparto exacto de todo el disco ni prueba de causalidad exclusiva |
| 21:35:04–21:35:30 | Muestras con **171 MiB** disponibles, PSI I/O full avg10 **86,68–98,52 %**, memory full **24,86–31,28 %** | Presión grave simultánea de memoria y E/S, distinta de baseline. Faltan crudos completos para ordenar todos los cambios |
| Hasta 21:37:40 | Deltas conservados: **22.325.597 refaults de páginas file**, **27.493.032 páginas escaneadas en reclaim directo**, **98.159 major faults**; swap-in/out **2.947/4.476 páginas**, oom_kill delta 0 | Apoyo fuerte a reclaim/recarga de páginas file; no a una explicación basada sólo en intercambio masivo de swap en disco. Son contadores lógicos, no bytes físicos |
| 21:36:56.970 | Commit FULL completado de **599,543 s** | Prueba de bloqueo de durabilidad; el evento no registra requestId y no se lo adjudica a un comando concreto por coincidencia temporal |
| 21:37:18 | analysis: **STORAGE_OUTCOME_UNKNOWN**, conditions.getSnapshot requestId **c0dcc24b-84fa-4e97-b5e0-1c462cdefa60**, ≈806,6 s de ejecución; seis fallos de indicators con commitId/jobIds | Resultado original incierto; las velas y sus proyecciones son fases diferentes |
| 21:37:19 | queries: STORAGE_READ_TIMEOUT, agent.read/status requestId **3ed4e82d-6dfb-4cf9-b52a-ac34acc9f88f**, ≈754,6 s; nativeWait blk_mq_get_tag | El observador administrativo también quedó afectado y carga el lector; no confirma mutación de negocio por ser una lectura |
| 21:38:01–21:39:08 | Señal, drain y server_stopped con MARKET_PERSISTENCE_UNCONFIRMED | Se detiene admisión y se conserva la incertidumbre. Ni primaryCause=null ni liberar handles acreditan éxito de esas seis proyecciones |

Clasificación: **(b)** memoria/reclaim y contención de procesos es la contribución mejor sustentada en esta ventana. **(d)** coordinación de lectores/commit/WAL participa en la manifestación: el checkpoint pendiente y el commit se atascan; no se demuestra defecto de esa coordinación. **(a)** latencia/dispositivo/controladora sigue abierta: no hay errores nuevos en contadores/ventana de kernel, pero falta SMART y la serie completa de await. **(c)** no se demostró amplificación repetida dominante de aplicación que justifique otro parche. **(e)** falta un contraste con holgura de RAM y captura completa para separar memoria de dispositivo/Btrfs; tampoco se puede asignar responsabilidad exclusiva a llama.cpp, Code o un servicio por simultaneidad.

WAL: a 21:24:26 había **84.698.992 bytes físicos retenidos**, último pendingBytes=0 y confirmedGeneration=460 frente a generation=469; el resultado anterior de checkpoint no certifica las nueve generaciones posteriores. En el fallo: 529 frente a 523, último pendingBytes=73.728, checkpoint activo desde 21:24:43.805. Estas instantáneas son estados de momentos distintos, no deuda total exacta. Un WAL retenido de 84,7 MB no equivale a 84,7 MB sin copiar. Los bytes de commitActivity son instrumentación lógica, no tráfico físico.

## Reconciliación durable del 29/10

Lecturas readonly/query_only con presupuesto por consulta de 5 s. No se abrió escritor ni se repitieron operaciones inciertas. Últimos recibos persistidos **28/10 21:39:07.798**, checkpoint de pipeline **21:39:07.224**; no se observaron nuevos recibos posteriores al cierre. No se usa el reinicio posterior como prueba de cierre limpio de C-IO.

| Superficie | Antes C-IO → corte durable comprobado | Clasificación |
|---|---|---|
| Artículos / revisiones | 163637/536038 → **163756/536244** | +119 artículos, +206 revisiones confirmadas |
| News | **240834/240962 → 241113/241168** | 279 secuencias consumidas; **55 pendientes durables** posteriores, sin continuación/error |
| Awareness | **3823/3823 → 3824/3851** | Una consumida; **27 pendientes durables**, sin continuación/error |
| Dominio / outbox | **24668/24668 → 24688/24688** | 20 revisiones/emisiones nuevas; no son 20 incidentes. Cero referencias ausentes y new-report sin evidencia en lo comprobado; emission_key tiene unicidad. Leer outbox no confirma entrega externa |
| Velas | **298 → 313 jobs complete**, cero pendientes | 15 jobs adicionales confirmados; no 12 recuperaciones D3. Candles records **45147 → 45170** |
| IA | **1171 intentos, 889 snapshots, 181 publicaciones**, idénticos | Cero nuevos; lease D3 incomplete/AGENT_LEASE_EXPIRED, fence=1/attempts=1/snapshot conservados |
| history antiguos | Dos retry del 09/10, mismos cursores 3/5 y 0/5 | Preservados, sin atribuirlos a C-IO |
| conditions.getSnapshot incierto | RequestId anterior; ninguna nueva fila conditions en el tramo analysis_runs 32175–32187 | Resultado original desconocido; no se declara persistido ni se reproduce |

Los **seis casos nuevos identificados** por el reporte de cierre:

| Serie | Job de velas (sufijo tras market-) | Cursor y efectos | Proyección |
|---|---|---|---|
| NOC 1d | `7959e35e1fce18c17b219c7f5adb703c52b979e34b6cb5ad7fedc1d847246228` | 4/4; 1 insertada, 1 actualizada, 2 duplicadas | Sin confirmar |
| GD 1d | `29bf0bc81add31e7e5db60a651be980bf11e236831e54badbcedcd6243581037` | 4/4; 1/1/2 | Sin confirmar |
| SPCX 1d | `7c3c8ea29d9573a6eee6cfded90859e9ef411337e7bd53ce065a5b9c55233744` | 4/4; 1/1/2 | Sin confirmar |
| CRWV 1d | `5ff79ee0df456e4f7a4440425ba8ffd0f43cd9d53dee0b42cd26ce0df3eb479f` | 4/4; 1/1/2 | Sin confirmar |
| MSFT 5m | `adec541f4dbe45cf2df8fda71e2fbf26dac76fa3c66acc9a5324e715cc6e6a53` | 8/8; 5/1/2 | Sin confirmar |
| NVDA 5m | `30c59e57d31c741131a5dbbb56e3aa04ca4e65a62244781e1a5b50887e732da3` | 8/8; 5/1/2 | Sin confirmar |

Se verificaron **32/32 claves de velas con OHLCV idéntico** a sus páginas admitidas. El ACK durable de estas páginas es acquisition_jobs + efectos en la misma transacción; market.persist.page no genera un recibo genérico storage_commands, por lo que la ausencia allí no significa no ejecución. Ninguna de estas seis series tiene un nuevo indicators.calculate en el delta 32175–32187: quedan **pendientes de reconstrucción/verificación de su proyección**, con entradas de velas durables. No se afirma que exista una cola durable de reintento de proyecciones ni se crea otra. No se reconstruye el hash exacto de un resultado nunca conservado; la identidad disponible de serie/job/commit se mantiene para una reconciliación posterior autorizada. Son casos nuevos separados de los **12 históricos D3 sin identidad individual**, que siguen como límite histórico y no se cuentan recuperados.

server_stopped informó primaryCause=null, **unconfirmedPersistence: persistence.market / seis fallos indicators**, cleanupErrors=[MARKET_PERSISTENCE_UNCONFIRMED]. El artefacto final sí expuso esa incertidumbre en host; no acredita por ello todos los fixtures de lector incierto, ni cierre limpio. Al retomar el 29/10: **cero owners, cero procesos backend, puerto 3000 sin listener**. Llama.cpp activo con los PID del nuevo boot **1543 y 1872**; los originales se conservaron durante la cohorte, sin señales de esta tarea. No se declara continuidad de sus PID a través del reinicio ajeno.

## Cambio, verificación y siguiente acción

Sólo colector externo, pruebas y continuidad documental; **sin corrección de negocio ni cambio de almacenamiento**. El colector limita duración solicitada a 1–3600 s y salida a 32 MiB, rechaza particiones para evitar doble contabilización y usa creación exclusiva/0600. Sus límites son presupuestos cooperativos: un host bloqueado puede retrasarlos. El archivo posterior opcional requiere directorio privado persistente ya creado; no sobrescribe evidencia existente y devuelve error si no puede archivarla.

**8/8 pruebas** Python: campos vacíos de proc, comm con paréntesis, unidades/flush/colas, idle/contadores antiguos, PID reutilizado, reset de contadores, contenido/permisos del archivo y rechazo de sobrescritura. Smoke final en host con backend detenido: **2 muestras / 1,00024 s**, archivo privado conservado, RSS ~16,8 MiB. No es benchmark ni segunda cohorte de OGID. git diff --check correcto. No se repiten 1119/1119 backend ni 33/33 MCP del artefacto previo, ni suites durante la observación.

Ejemplo de recogida, con directorio privado ya preparado y salida tmpfs nueva:

```sh
python3 backend/scripts/observe-host-io.py /tmp/ogid-io-nuevo.jsonl \
  --duration 180 --interval 5 --devices sda sdb zram0 \
  --archive-directory /ruta/privada/persistente
PYTHONDONTWRITEBYTECODE=1 python3 backend/tests/observe_host_io_test.py
```

Evidencia privada que **sí existe**: `.implementation-evidence/2026-10-29/D02-IO/`: identidad final, transcript-derived.json etiquetado como transcripción, db-current.json, reconciliation.json, host-final.json, pruebas y smoke. No contiene la serie cruda ni log original perdidos. La publicación autorizada incluye este cierre, continuidad, colector/pruebas y la excepción específica de .gitignore; no DB, logs, secretos ni muestras. El hash del artefacto de negocio y el .env siguen idénticos.

**E sigue no apto; KAN-8 continúa En progreso.** Sin aceptación operativa, nuevas proyecciones sin confirmar, corte tardío y evidencia incompleta. La falta de identidad histórica de D3 no se convierte en una exigencia imposible ni se llama resuelta. KAN-9, E/F y las 24 h no se inician.

**Única siguiente acción verificable propuesta, no ejecutada:** preparar un ensayo de aislamiento de memoria con el usuario cerrando de forma autorizada Code/Codex ajenos y conservando llama.cpp, configuración, base y montajes. Requisito antes de admitir otra cohorte: **MemAvailable ≥4 GiB durante 180 s**, sin reclaim directo ni PSI memory sostenido, captura persistente completa y un controlador de corte independiente de las consultas HTTP/SQL y del editor. Registrar las diferencias de caché/procesos; comparar refaults, cola/await, commit y progreso con este corte limitado. Impacto: cierre temporal del editor/agentes y posible desconexión; guardar su trabajo previamente. Reversión: reabrir las aplicaciones después del cierre OGID, sin tocar datos. Si no se alcanza esa holgura manteniendo llama.cpp, el ensayo no se admite: requiere otra autorización de capacidad del host. No se ejecuta ahora ningún cierre ajeno ni otro arranque. Esta prueba distinguiría una contribución de memoria; no daría por sana la controladora por sí sola.
