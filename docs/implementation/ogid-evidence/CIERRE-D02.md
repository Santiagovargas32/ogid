# Lote D/0.2 — estabilización acotada

28/10/2026. Base revisada `c19ac4be6e463732ee03f1968dcc46536aa9e1d0`, rama `feat/agentic-intelligence`, checkout inicialmente limpio; código anterior `124050a`. Cambios locales sin commit ni publicación. A–D permanecen integradas; E/F no iniciadas. La sesión autoriza pausa local, implementación, pruebas y arranques/cierres mediante `cd backend && npm start`; no promoción, push, merge ni despliegue.

## Identidad y pausa

Node **22.23.3**, contrato **1.12.0**, hash **d17de83ae09b45b6859544697a4cfd5905b03b8e09be2e14da850cb4a7e08d16**, inventario **98 rutas / 107 operaciones**. Instalación backend: 138 paquetes runtime, MCP: 3; ambas matched, cero discrepancias frente a locks. No reinstalaciones, upgrades, auditorías ni cambios de locks. Esquema efectivo **029/29 migraciones** por schema_migrations; sin migración nueva y 001–029 intactas.

Artefacto final local **`97d6ace9070bfdcc9c1392dda016146af6c013899567e58cbd5e2969bc2be706`**, hash de archivos de arranque, sin atestación ni commit nuevo. Distinto de los artefactos de las dos cohortes, que se conservan identificadas más abajo. Este último incorpora las dos regresiones descubiertas al cerrar el lote y está probado con fixtures.

Base seleccionada conservada: `/home/fedora/.local/share/ogid/db/ogid-repaired-20261026-183735.sqlite`. No se abre la imagen dañada ni se reabre la recuperación. Preflight del host: ningún backend/owner escritor; proceso Node ajeno en `/home/fedora` conservado y dos llama-server conservados. No se señalizan grupos de procesos.

La configuración local ya estaba en `AGENT_MODE=off`, los tres `AGENT_*_ENABLED=off`, `AI_PROVIDER=none` y `AI_MODE=off`; se verifica en vez de reemplazarla. `AGENT_TASK_MODES={}` conservado literalmente; no se añade manual/on-demand. Se guarda privadamente hash del .env y sólo las opciones permitidas para comparar reversión. Proveedores, selección de modelo, AWARENESS_MODE=visible y base conservados. El .env no entra en Git.

AgentMaintenance continúa habilitado por `business`, con sus mismas páginas, hashes y temporizador; apagado de IA no lo desactiva. La ruta interna también rechaza crear snapshots en modo off. Al arrancar se reconcilian únicamente leases vencidos por páginas de 128: job y ejecución pasan a incomplete/AGENT_LEASE_EXPIRED conservando fence, intentos y evidencia. No se claim/enqueue ni se repite inferencia. No se afirma que el intento terminó correctamente.

## Reconciliación D3

Lecturas previas readonly/query_only y acotadas; fuentes privadas D3-review y log original identificados en RESUMEN. **El ID de despacho del StorageManager no es necesariamente el requestId de su recibo.** No se busca un recibo por ese ID como prueba concluyente de no ejecución.

| Trabajo/fase | Identidad disponible y recibo | Efectos / estado | Acción segura |
|---|---|---|---|
| Heartbeat IA final | job `2e7a7cae-63d0-4d33-867c-67bd6d9c04f9`, fence 1, renewalId `d174d204-f5d9-4b83-aa9b-4bfe8322482f`; despacho `8e36c460-4992-4e45-8d8d-d68e1ce8c8bb`; sin `heartbeat:<renewalId>` localizado | Resultado original **desconocido**; lease durable vencido, sin proceso ejecutor | Reconciliar vencimiento con escritor propietario, sin replay del heartbeat ni inferencia |
| history-cancellation del cierre | No requestId/job/fence en el reporte de esa fase; STORAGE_NOT_READY posterior a fallo | La petición de cierre fue rechazada antes de admitirla. Estado durable: ningún history/intraday running; dos history retry desde 09/10, no D3 | **No ejecutada** esa cancelación; conservar trabajos viejos y no relanzarlos por el cierre. No convertir ausencia de activos en éxito de la fase |
| pipeline del cierre | runtime.save/pipeline-stage: despachos `27dfc42f…`, `dd92654e…`, `0c8902fe…` documentados queued al fallar; sin requestId durable individual publicado | Esos comandos estaban **no despachados**; estados durables anteriores conservados. El flush global no confirma las últimas transiciones | Hidratar/reconciliar estados interrumpidos mediante arranque existente, no repetir escrituras inciertas |
| RSS final | Despacho `bbd84a4d-5e21-4b9d-84ff-a1f5c3712397`, sin recibo atómico de todo refresh; tres progresos confirmados | news.meta lastIngestAt 18:13:52.470; journal news hasta 240462; checkpoint RSS 18:13:00.783; pipeline RSS iniciado 18:13:39.699 quedó running. **Efectos parciales confirmados / final desconocido** | Reanudar desde checkpoints/feed states con adquisición normal e identidades conservadas; no replay del comando incierto |
| Velas durables D3 | 132 jobs market-persistence / 3.672 elementos admitidos en esa cohorte; IDs y cursores completos privados | 132 complete, cursor=n en la lectura; 296 complete contando históricos. **Confirmados esos jobs**, no 12 pérdidas ni éxito global por backlog cero | Consultar cada job/cursor antes de continuar; no crear otra cola ni readmitir observaciones |
| Mercado, episodio 14:17:07 UTC (2 logs) | Dos jobs candidatos GOOGL/GOOG 5min completados a 14:15:37; logs sin fase ni identidad | Coincidencia temporal de ~90 s con posibles proyecciones; **identidad exacta de los errores desconocida** | No inventar vínculo ni recuperar dos observaciones ficticias |
| Mercado, episodio 15:40:28 UTC (2 logs) | Dos candidatos ORCL/AAPL 5min completados a 15:38:58; logs sin fase ni identidad | Igual límite; velas candidatas confirmadas, proyección fallida específica no demostrada | Conservar incertidumbre individual y añadir correlación para nuevos fallos |
| Mercado, episodio 16:47:29–30 UTC (8 logs) | Ocho candidatos: seis series daily ETF/ASML y GD/SPCX 5min, completados 16:45:59–16:46:00 | Cuenta/tiempo compatibles con espera de proyección posterior; **no prueba exacta** de fase/recuperación por log | No contar 8 velas perdidas ni 8 trabajos recuperados |

No se equipara publicación, revisión, situación ni incidente. Los recibos de velas confirman cursor/contadores, no que toda observación histórica siga siendo la versión actual tras correcciones posteriores.

## Correcciones de persistencia

- `MarketDataStoreAdapter` conserva fallos **sin resolver por admisión** y fallos de proyección por serie, separados de contadores históricos. `flushPersistence` drena y devuelve error agregado con fase/commitId/jobIds/scope acotados cuando queda incertidumbre; el servidor la incluye en shutdownReport y falla el cierre. Ya no basta esperar allSettled. Una adquisición duplicada debe recalcular una proyección anterior pendiente/fallida; un callback que no hace trabajo no puede limpiar ese fallo.
- Un fallo durable de velas puede reconciliarse durante drain: primero se consulta su job/cursor; complete sólo necesita ACK, pending continúa desde su cursor. El éxito despeja únicamente esa admisión; un fallo histórico recuperado no vuelve a ensuciar el cierre. Proyecciones derivadas pueden quedar sustituidas por una proyección posterior confirmada de la misma serie, sin descartar hechos de velas.
- CandleWriteCoordinator consulta status antes de reanudar páginas y no programa recuperaciones contra un manager fallido. El drain comprueba también la cola durable que no pertenezca al adaptador actual. No hay replay ciego de OUTCOME_UNKNOWN. La política de un retry con el mismo requestId para no ejecución inequívoca de PipelinePersistence se conserva.
- Diagnóstico nuevo diferencia `candles` de `indicators`; incluye sólo correlación acotada, sin payloads ni secretos. La falta histórica de esa información no se repara inventándola.
- Si al cerrar queda un lector con STORAGE_OUTCOME_UNKNOWN, el reporte conserva `persistence.analysis`/`persistence.queries` y los comandos acotados, y el cierre devuelve error aunque el escritor haya liberado sus handles. Se corrige el punto ciego reproducido en B: cerrar conexiones no confirma los RPC de persistencia del lector.

No se ha creado persistencia durable adicional para proyecciones ni cambiado esquema. Una proyección histórica D3 sin identidad sigue sin poder certificarse individualmente después de reiniciar; es una limitación explícita, no una recuperación acreditada.

## Presión de almacenamiento

D3 aporta la reproducción: transacción en commit **85.538 ms**, hilo btrfs_sync_log, lectores blk_mq_get_tag, PSI full avg10 **71,05 %**. Último checkpoint completado: WAL físico **136.936.472 bytes**, log 192/checkpointed 186, deuda **6 páginas / 24.576 bytes**. El tamaño retenido no era deuda de 136 MB. Había otro checkpoint activo desde hacía 84,563 s; su resultado no estaba confirmado.

Telemetría acumulada: **229.103 generaciones de commit**, contador lógico estimado **48.781.455.128 bytes** y **17.707 checkpoints completados**. Son actividad SQL/estimaciones del instrumentador, **no bytes físicos escritos al dispositivo** ni una medida completa de amplificación. La aproximación incluye sentencias aunque no cambien filas. Registro: 2.232 agregaciones RSS y 28.315 transiciones pipeline; no se extrapolan a pérdidas.

Muestras D3 condicionadas por lo que se registra: slow_sql **n=272, p95=7.510 ms**; slow_commit **n=568, p95=8.500 ms**; checkpoints logueados **n=2.982, p95=3.527,59 ms**. Los dos primeros excluyen operaciones rápidas y el último registra lento/deuda; no son percentiles de toda la carga. El commit final bloqueado tampoco es un commit lento completado.

### Cohorte A real con IA off

Backend **PID 1088798**, npm start el 28/10 **19:50:20**, listo **19:51:38.894 UTC**. Observador **19:50:46.166–19:53:43.950**, **18 muestras**: seis durante inicialización (ready/agent 503), doce ready/agent 200 con modo off. Su observación acaba antes del fallo del backend. Ninguna suite se ejecutó simultáneamente con esta medición.

Muestra desduplicada de recentCommands (ventana deslizante, **no todos** los comandos): writer **n=195**, ejecución p95 **914,55 ms**, cola p95 **2.833 ms**; analysis **n=8**, ejecución p95 **64.101,94 ms**; queries **n=112**, ejecución p95 **1.195,42 ms**. Ejecución writer incluye workflows esperando red; no equivale a duración SQL/commit. Checkpoints distintos muestreados **n=17**, p95 **9.202,51 ms**; deuda máxima muestreada **10.866.688 bytes**. Cola del writer observada: máximo 2 pendientes/2 en vuelo. No comparar estos percentiles con los logs condicionados D3 ni llamarlos mejora de rendimiento.

Contadores /proc del proceso entre primera y última muestra: read_bytes **1.683.578.880**, write_bytes **376.131.584**, rchar **795.734.449**, wchar **415.035.051**. Son E/S atribuida por el kernel al proceso y bytes de llamadas, respectivamente; no miden toda la amplificación del dispositivo. La carga difiere de D3 por IA off, arranque y estado de caché; no se calcula ganancia porcentual.

Fuera de la ventana del observador: fallo del lector a **19:55:05.546** en scenarios.prepare, espera blk_mq_get_tag y PSI full avg10 **58,07 %**. Mercado completó startup-market **19:55:25.286**, 19 cotizaciones web-delayed, sin fallback, duración **226.354 ms**. A **19:58:41.306** falla el escritor: **STORAGE_OUTCOME_UNKNOWN / STORAGE_EXECUTION_TIMEOUT**, transacción de señales en commit **30.119 ms**, hilo btrfs_sync_log, PSI full avg10 **70,76 %**. WAL físico **87.434.672 bytes**; el último checkpoint confirmado no tenía páginas pendientes y había otro checkpoint activo. No es evidencia de nuevo checksum corrupto ni de OOM.

El controlador de cierre esperaba una ventana sin trabajo admitido; su sondeo agotó plazo y **no envió SIGTERM**. Cierre automático **19:58:48.235 UTC**, cuatro fases sin confirmar: history-cancellation, source-cancellation, market-jobs y pipeline; cleanupErrors vacío. **Cierre no limpio**. No se atribuye la caída del editor Code a una causa física concreta. Revisión posterior: backend ausente, cero owners, llama.cpp conservado.

La transacción incierta incluye `signals.recordMeasurement` (despacho `517d8dfc-b5f8-43bd-aa29-dc1dc2f43e68`) y RSS `05b4ba51-f6db-4f4e-a025-1a90111a41a1`, con 931 elementos de progreso confirmados; alertSync y renovación de snapshot analítico estaban despachados, publication analítica en cola. **No se reenvían esos comandos.** Los snapshots analíticos deterministas no son snapshots de evidencia IA: AGENT_MODE=off no apaga la analítica existente.

Lectura durable posterior A: artículos **163.532**, news **240800/240801** (una secuencia pendiente), awareness **3821/3821**, dominio/outbox **24664/24664**, cero referencias ausentes o claves de emisión duplicadas en la cohorte nueva comprobada. A añadió **198 artículos**, **339 revisiones**, **15 revisiones/outbox**; no se llaman incidentes. Mercado **298 jobs completos**, dos admitidos/completados nuevos, **no dos trabajos recuperados**; cero pendientes de velas y los dos history retry antiguos intactos.

Intentos IA **1.171**, snapshots IA **889** (head rowid 894), publicaciones IA **181**, todos idénticos al corte anterior al arranque: **cero nuevos**. El único lease D3 vencido pasó durablemente a incomplete a las **19:50:42.239**, fence 1/attempts 1/snapshot conservados; no se volvió a admitir ni se marcó completed.

### Cohorte B — reinicio y cierre separados

Backend **PID 1104931**, npm start **20:23:50.992**, listo **20:25:34.339 UTC**. Mismos base/proveedores/IA off. Dos muestras consecutivas del escritor fuera de transacción preceden un único SIGTERM mediante pidfd; recibido **20:25:52.898**. Había cálculo determinista y lecturas aceptadas: el handler cerró admisión y las drenó. Mercado completó el ciclo aceptado **20:27:08.487**, 19 cotizaciones web-delayed, sin fallback, **94.114 ms**; no comparable al tiempo de A.

**La cohorte B tampoco certifica un cierre limpio.** A **20:28:37.636** el lector falló con **STORAGE_OUTCOME_UNKNOWN**, requestId `4339937e-49cb-418a-a52e-bdb5b9edf75d`, news.getProjection; espera blk_mq_get_tag y PSI full avg10 **58,11 %**. Sus RPC de persistencia no se consideran reconciliados por liberar el lector. El reporte original a **20:28:52.828** tenía primaryCause=null, unconfirmedPersistence=[] y cleanupErrors=[]: **punto ciego demostrado**, corregido después con regresión de comportamiento. No reenviar el comando incierto ni reinterpretar ese reporte vacío como confirmación.

Lectura readonly/query_only posterior: cero owners, artículos **163.637**, dominio/outbox **24668/24668**, awareness **3823/3823**, news **240834/240962**: **128 secuencias durables pendientes**, sin continuación/error. La adquisición aceptada siguió archivando durante el drain después de parar mantenimiento; estos pendientes son trabajo durable, no pérdida ni consumidor al día. Referencias nuevas y claves de emisión comprobadas sin ausencias/duplicación. **298 jobs de velas completos**, cero pendientes; contadores IA y job vencido idénticos a después de A. Control final **20:36:20 UTC**: **0 jobs IA creados desde el arranque A**, esquema 029, cero owners, puerto 3000 cerrado y los dos llama-server originales activos. Backend detenido al terminar.

Identidad de artefactos: base publicada `0f825dcc…`, cohorte A `9fe7e7aa…`, cohorte B `e9a429ad…`; hashes completos en evidencia privada. B añade correlación requestId y conservación de diagnóstico al reconciliar. Las dos últimas correcciones de proyecciones duplicadas y reporte de incertidumbre del lector se verifican **con fixtures después de B**, sin afirmar otra ejecución real de ese artefacto final. No se inicia otra cohorte ni observación formal para ocultar los fallos reproducidos.

Hipótesis evaluadas: (1) espera E/S del host, acreditada como mecanismo inmediato; causa física exacta abierta; (2) amplificación de app, plausible por volumen, sin un nuevo defecto dominante demostrado; (3) pérdida de velas por 12 logs, no demostrada por la ambigüedad de fase. Una consulta agrupada de todo analysis_runs se interrumpió con presupuesto; no se amplía el barrido ni se inventa un recuento. El chequeo de duplicados indicators por seriesRevision no aportó repetición en D3.

Se conserva el batching/coalescing y los hashes ya corregidos; no se reescriben analítica, RSS ni correlador. La pausa elimina admisión/inferencia automática y sus snapshots; la reconciliación evita reabrir páginas complete. **No se afirma resuelto el bloqueo E/S D3** ni se elevan límites, timeouts, concurrencia, retries o se cambia FULL para conseguir verde. La siguiente comprobación física requiere una cohorte comparable con latencia/cola del dispositivo, PSI y actividad por proceso, correlacionada con commits y checkpoints; no un nuevo backup como precondición.

## Validación y aceptación

Regresiones dirigidas iniciales **46/46**, primera revisión final **11/11** y última **30/30**, incluida continuación tras perder ACK de una página de 10/25 elementos, sin repetir sus efectos. La regresión de velas duplicadas falló antes del ajuste (Missing expected rejection); después exige reconstrucción real. **Backend final 1.119/1.119**, **149,15 s**, concurrencia 2 del proyecto; sustituye la suite anterior 1.117/1.117 a efectos del diff final. MCP **33/33**; check/build backend, check MCP, inventarios JSON/Markdown **98/107** y diff-check correctos. MCP no declara script build. Sin cambios de dependencias, no se ejecuta npm ci ni auditoría rutinaria.

La ejecución dirigida intermedia con nueve archivos paralelos quedó bloqueada durante presión del host y fue terminada por su principal; **no se contabiliza como pasada**. Se observó memoria disponible ~1,95 GB y swap casi llena; no acredita OOM ni explica por sí sola D3. La suite completa posterior con concurrencia 2 sí terminó. Los primeros intentos HTTP del sandbox devolvieron listen EPERM; se repitieron en host, sin alterar pruebas para ocultarlo.

Cobertura reutilizada: modo off con mantenimiento/adquisición/situaciones, fuente RSS lenta, presión de cola, un retry de no ejecución con requestId estable, ACK perdido, cursor/efectos/outbox, rollback/commit incierto, recuperación de velas/proyecciones y cierre que conserva errores. Las validaciones de fuentes externas reales pertenecen a las cohortes del host; los fallos inyectados pertenecen a fixtures.

Evidencias privadas en `.implementation-evidence/2026-10-28/D02/`: identidad/configuración permitida, lecturas antes/después, contexto D3, observación y logs completos A/B, pruebas y result.json. El hash del .env permanece igual; no versionar logs, .env, DB ni muestras crudas. La evidencia portable es este documento y ESTADO.

**Estado para E: no apto** mientras permanezcan la incertidumbre individual de los 12 episodios y el bloqueo de almacenamiento sin resolver. No se declara estabilidad de 24 h ni aceptación semántica IA. Una ventana corta y un reinicio no certifican la ejecución D3.

| Nivel | Resultado |
|---|---|
| Implementado | Pausa respetada, leases vencidos, recibos/cursores, fallos de proyección y cierre con incertidumbre visible |
| Probado con fixture | ACK total/parcial perdido, recuperación sin duplicación, proyección fallida/duplicados, lector incierto al cerrar, IA off y núcleo activo; suites indicadas |
| Verificado en host | Base/owner/esquema, cero IA nueva, progreso de adquisición/mercado/situaciones, reinicio y dos cierres observados; ambos con fallos, B mostró un reporte incompleto |
| Aceptado | **No**: E/S y resultados inciertos abiertos; último artefacto de cierre no se presenta como operado en host |

Reversión compatible: conservar esquema 029, jobs, snapshots, cursores, outbox y revisiones; mantener los seis interruptores IA en off. Los cambios de código son reversibles una vez detenido el backend; volver a 124050a reintroduce los puntos ciegos de cierre, por lo que no equivale a una aceptación. La configuración anterior recibida ya era off y se preservó; no reactivar proveedores/IA por inferencia ni borrar datos para revertir.
