# Ejecución D del 27/10/2026 — observador, backend y cierre

**Cohorte histórica PID 988930, anterior a D2/D3.** Sus pendientes y cierre describen este ensayo. Estado posterior y fallo de E/S del 28/10 en [RESUMEN-ACTUAL-2026-10-28.md](RESUMEN-ACTUAL-2026-10-28.md); entrada vigente [ESTADO.md](ESTADO.md). No reutilizar aquí «última ejecución» como referencia a D3.

Actualizado con lectura documental y SQLite readonly el **27/10/2026, 13:32–13:34 UTC**. Código vigente [df50aae](https://github.com/Santiagovargas32/ogid/commit/df50aae482d8bacaf13f81c21dc0aa210b93ba8c), contrato 1.12.0 / esquema 029. El cierre de implementación está en [CIERRE-D.md](CIERRE-D.md); estado y siguiente acción en [ESTADO.md](ESTADO.md).

Conclusión: **backend disponible en todas las muestras y cierre ordenado, con limitaciones operativas y semánticas abiertas**. Observador interrumpido, no prueba de 24 horas ni aceptación IA. Este informe incorpora evidencia disponible; no se han reproducido/fijado fallos ni arrancado servicios para redactarlo.

## Evidencia y ventanas separadas

| Fuente privada | Ventana / uso |
|---|---|
| `.agent-validation/shadow-24h-D-20261027-130254/summary.json` y `samples.jsonl` | 71 muestras de 12:02:55.223 a 13:13:35.090 UTC; observador finalizado interrumpido a las 13:14:12.888 |
| `.agent-validation/shadow-backend-D-20261027-130208.log` | Log del backend desde 12:02:09.395 hasta server_stopped 13:19:52.778; incluye tramo posterior al observador |
| `.implementation-evidence/2026-10-27/shutdown-988930/` | Identidad/pidfd, único SIGTERM, desaparición de hijos, puerto/owner/handles y cancelación activa |
| `.implementation-evidence/2026-10-27/docs-update/` | Extracción reproducible `summarize-run.py`, resumen del log/observador y corte readonly actual `database-current.json` |
| `.implementation-evidence/2026-10-27/D-release/` | Publicación/CI y smoke anterior; no mezclar con esta ejecución posterior |

Log completo: **5.910.268 bytes**, SHA256 `2440830c7ec443d26532e87a20da7b92ccf0662f433c56242efea6efc48b8ff7`. Las muestras/contadores son los existentes al cierre, sin copiar logs ni bases a documentación publicable. Los nombres de archivo usan hora local; las ventanas de este informe son UTC.

## Lo que demuestra el observador

- PID **988930**, inicio de proceso **12:02:08.759 UTC**, artifactHash `e5b5425d9468ae524e099a30e2938fa6203dfd26555e5ee0f554e43a53bea058`; backendChanges=0, telemetryGaps=0 y continuousBackendObservation=true **dentro de la ventana muestreada**.
- **71/71 health=200, 71/71 ready=200, 71/71 admin-agent=200**; unavailableSamples=0. Diagnóstico operativo y calidad `ok` en las 71 muestras; worker conectado y modos shadow en todas. No equivale a comprobar todos los contratos ni el contenido de cada respuesta.
- state=interrupted, completedObservation=false, observedMs=4.240.158 (~1 h 10 min 40 s); intervalo máximo entre inicios de muestra 67.572 ms. No convertir este ensayo ni el v19 de 23 h 54 min en una puerta formal de 24 h.
- Recuperaciones de análisis/consultas **0/0**; 8 muestras tenían algún heartbeat de writer/analysis/queries >15 s. No son ocho fallos confirmados del escritor.
- Máximo RSS backend **2.782.003.200 bytes**; máximo RSS de hijos gestionados medidos **642.752.512 bytes**, excluye llama.cpp y no es un pico simultáneo sumable. WAL físico máximo **289.186.952 bytes**, pendiente de checkpoint observado hasta **7.168.000 bytes**. El tamaño del fichero WAL no equivale a páginas pendientes ni demuestra por sí solo violación del límite de backpressure.
- Backpressure WAL y fallos de checkpoint muestreados **0/0**; checkpoint máximo muestreado **7.894,58 ms**. Conflictos/rechazos de capacidad de sincronización muestreados **0/0**.

## Lo que añade el log completo

El servidor registró `server_started` a las **12:02:42.669 UTC**, unos 34 s tras iniciar proceso. Siguió adquiriendo/procesando después del observador, hasta el drenado de cierre. Los siguientes son **episodios registrados**, no percentiles de todas las operaciones:

| Señal | Episodios del log | Máximo / interpretación |
|---|---|---|
| storage_slow_sql | 62 | **9.781 ms** |
| storage_slow_commit | 159 | **20.605 ms** |
| storage_wal_checkpoint en warn | 335 | **22.109,00 ms**; una advertencia no equivale a checkpoint fallido |
| signal_correlator_record_failed | **68** | `STORAGE_COMMAND_TOO_LARGE`; el límite rechaza registrar ese payload; no se cierra la persistencia del correlador |
| http_request con status>=500 | 0 registrados | No excluye rechazos 4xx de validación ni sustituye la revisión de lógica |

El máximo del log de checkpoint supera el muestreado; son fuentes y ventanas distintas. No atribuir SQL/commit/checkpoint a un fallo físico de disco sin evidencia; el checksum Btrfs anterior fue reparado en los datos y no explica automáticamente estas latencias. Tampoco usar `storage_command_failed` con errores semánticos como prueba de que murió el proceso escritor: el estado y el cierre se verifican aparte.

## Agente: denominadores y semántica

La última muestra del observador tenía **5 intentos completados y 6 fallidos desde ese arranque**. Los 151 completed / 529 failed / 66 incomplete de `agent.jobs` eran históricos; no describen 71 minutos. Los 53 completed / 11 failed del broker cuentan llamadas al modelo, no trabajos ni publicaciones independientes. No sumarlos entre sí.

Consulta durable posterior, `agent_runs.started_at >= 2026-10-27T12:02:08.759Z`, una fila por intento job/fence: **12 intentos: 5 completed + 6 failed + 1 incomplete**.

| Tarea | Completed | Failed | Incomplete |
|---|---|---|---|
| global_intelligence_brief | 0 | 1 | 0 |
| instrument_outlook | 4 | 5 | 1 |
| market_outlook_global | 1 | 0 | 0 |

Señales de fallo deduplicadas por job/fence en el log: tres intentos `AGENT_UNVERIFIED_NUMBER`, uno `AGENT_UNKNOWN_EVIDENCE`, uno `AGENT_EXECUTION_UNCERTAIN` (también aparece `ANALYSIS_LEASE_LOST`) y uno `AGENT_OPENCODE_TURN_FAILED`. Hay rechazos `AGENT_STALE_EVIDENCE` durante solicitudes y telemetría del broker `LLAMACPP_OUTPUT_FORMAT`: no contarlos como nuevos intentos adicionales. Una misma falla aparece en storage/request/worker; no sumarla por cada línea.

El último intento activo se canceló al apagar: **incomplete / ABORT_ERR** en inferencia; se informa separado de los seis fallidos espontáneos. Las guardias evitaron aceptar números/evidencia no verificados; no se han desactivado. Cinco completed no acreditan cinco análisis útiles o correctos: falta evaluación semántica por tarea sobre sus citas, números, correcciones y límites.

## Orden de cierre comprobado

El usuario detuvo el observador y autorizó parar el PID. Se verificó `node server.js`, cwd backend, padre `npm start` y starttime; se abrió pidfd y se envió **un único SIGTERM al principal** a las **13:19:04 UTC**. No SIGKILL ni señal manual a grupos. `shutdown_signal_received` 13:19:05.326; el ciclo aceptado terminó, el trabajo IA quedó cancelado de forma controlada y `server_stopped` llegó a **13:19:52.778**.

Pruebas de cierre: primaryCause=null, unconfirmedPersistence=[], cleanupErrors=[]; ningún PID gestionado pendiente, puerto 3000 libre, **0 owners, 0 trabajos activos, 0 handles de SQLite**, llama.cpp preservado. Esto demuestra drenado/cierre, no que no hubiera errores funcionales durante la ejecución. El correlador volvió a registrar su rechazo de tamaño antes del cierre limpio.

## Corte actual de datos y consumidor — 13:32:33 UTC

Base reparada de `.env`, sólo lectura/query_only: esquema **029**, sin propietarios escritores ni trabajos activos. **150.671 artículos**, facetas editoriales **150.671**, publicaciones C **150.671**, afirmaciones C **220.677**. Situaciones **12.032**, incidentes explícitos **0**, evidencia D **12.435**, outbox/revisiones de dominio **14.113**, alertas actuales **161**. Evaluaciones/perfiles editoriales **0/0**; no se ha inferido tendencia política a partir de la adquisición.

Consumidor news: procesado **170.399**, cabeza **186.736**, techo de ronda **179.501**, última actualización **13:13:17.992 UTC**, sin continuación ni error. **hasMore=true**, distancia de secuencias **16.337**. Awareness **3.097/3.097**, excluidas 3.097 por elegibilidad de tipos/fuentes D, sin backlog ni error. Bootstrap completo en ambos; disponibilidad `ready` no significa consumo al día. Hay historial de revisiones y posibles huecos: distancias/claims/outbox no son número de noticias únicas ni incidentes físicos.

Este corte sustituye, para datos/procesos actuales, al checkpoint de las **11:56 UTC**, que sí había quedado sin pendientes después de un replay explícito de 52 páginas del smoke anterior. No hacer pasar ese drenado previo por resultado de esta ejecución. No se ha escrito ni drenado nada para redactar este informe.

## Acciones pendientes de código — no ejecutadas por esta actualización

1. **Consumidor D bajo carga:** reproducir el aumento del backlog, su cadencia, la coordinación de AgentMaintenance y el coste concurrente de snapshots/analítica. Hacer que alcance y sostenga el consumo medido con límites existentes; validar reinicio y correcciones sin saltos. La causa exacta del atraso no se ha demostrado.
2. **Correlador y 0.2:** resolver el registro de señales que supera el presupuesto mediante referencias/metadatos/páginas según el contrato; medir SQL/commit/checkpoint y separar rechazo semántico, lease, lectura y escritor. No subir límites para ocultarlo.
3. **IA shadow / F:** revisar los seis intentos fallidos y los completados por tarea, con evidencia exacta y reparación única. No promoverla por HTTP200 o por ci verde.
4. **E → F → aceptación final:** fuentes/perfiles/evaluaciones permitidas, piloto y analista; después candidato identificado y 24 h continuas, con puerta semántica separada. Las pruebas acompañan cada entrega.
