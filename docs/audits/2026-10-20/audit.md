# Auditoría OGID — 20 de octubre de 2026

**Resultado: correcciones implementadas y verificadas; mantener shadow. No se acredita estabilidad de producción ni una observación de 24 horas.**

Seguimiento posterior del primer arranque real del usuario: [incidentes shadow, corte 11:34 UTC](live-shadow-review.md). Incluye un rechazo nuevo por evidencia stale, progreso de adquisición, desajuste de telemetría RSS y latencias/memoria que requieren investigación. No sustituye los resultados anteriores ni acredita las mejoras pendientes.

Rama `feat/agentic-intelligence`, HEAD `5ac40d7cd126320443b9ce41ac0855f979f1db7b`; base de comparación `b6edb69ca322153912278c13a4831065df6540df`. El conector GitHub confirmó rama remota idéntica, sin commits adicionales. Checkout inicialmente limpio. Se trabaja sobre esa rama, sin mezclar main, publicar, desplegar ni reiniciar servicios existentes. Los cambios de esta auditoría quedan locales, sin commit nuevo. `.env` se conserva.

## Alcance real de revisión

El diff original comprende 115 archivos, 20.659 inserciones y 352 eliminaciones; 10.136 líneas corresponden al OpenAPI fijado de OpenCode. [inventory.csv](inventory.csv) enumera código, herramientas, configuración y pruebas con SHA-256, tamaño, señales estáticas y nivel de revisión. Se distinguen revisión funcional focalizada, lectura contextual, ejecución de pruebas e inventario estático. **El inventario completo no equivale a revisión semántica completa.** Permanecen módulos originales de mercado, proveedores, investigación, UI y coordinadores pendientes de revisión profunda; el CSV los identifica individualmente. Las pruebas verdes no eliminan ese pendiente.

Se leyeron AGENTS.md, PROGRESS-AGENTIC-INTELLIGENCE.md, CI, scripts operativos, rutas y contratos relevantes. La skill de entorno se consultó para red/permisos; este ejecutor local no expone `environment_status`. Los datos originales de validación permanecen intactos. [logs.md](logs.md) compara los diez logs completos; [logs.json](logs.json) conserva firmas, frecuencias, contextos, cronología, correlaciones, denominadores y referencias a cientos de informes adicionales. No se exportan prompts, noticias completas, cookies, credenciales ni razonamiento.

## Recorridos reconstruidos

| Flujo | Implementación y garantía comprobada | Límite |
|---|---|---|
| A. Fuente → SQLite → outbox | RSS/proveedores → normalización y clasificación → `SqlNewsArchive.ingest` → artículos/revisiones/enlaces → triggers de migración 010. Batches comprometidos antes de renovar progreso. Consumo de outbox y checkpoint en una transacción. | No acredita disponibilidad de cada proveedor externo. |
| B. Histórico → cálculo → API/WS | `StorageManager` dirige consultas a `queries`, cálculos a `analysis`; commits derivados regresan al escritor mediante RPC. Coordinación avanzada existente; resultados y revisiones persistidos. | Lectores compartidos pueden saturarse con corpus frío; no se añade otro motor. |
| C. Outbox → publicación | Consume/enqueue/claim con ID estable y fence → lectura consistente del snapshot → begin/page/seal por el escritor → sesión/turno OpenCode → broker serial → llama.cpp → MCP congelado → validación → publicación transaccional. | Una consulta o cita válida no acredita soporte semántico de todas las afirmaciones. |
| D. Chat | Dispositivo/CSRF → sesión propia → clave idempotente → job y messageId estables → progreso SSE efímero → respuesta durable con referencias válidas. | El smoke real cubre una conversación, no calidad general del modelo. |
| E. Fallo/reinicio | Lease 90 s; renovación serial tras 20 s; vencimiento/incomplete → reconciliación del mensaje concreto al ejecutar → interrupción con ticket y reconocimiento → nuevo fence. | No se promete exactly once entre HTTP, OpenCode y SQLite. |
| F. Inicio/cierre | Entrada operativa `cd backend && npm start`; hijos propios, IPC, grupos y credenciales aisladas; cierre de worker/OpenCode/broker antes de almacenamiento. | Los cierres históricos largos siguen requiriendo ensayo sobre carga real fría. |

## Hallazgos y correcciones

Cada fila distingue evidencia histórica de reproducción actual. Para defectos sin evento histórico correlacionable, la evidencia primaria es la regresión antes/después. Los logs originales no identifican de forma suficiente su commit/configuración: no se atribuyen automáticamente a HEAD.

| ID / prioridad | Evidencia → síntoma y causa | Código/corrección → comprobación |
|---|---|---|
| F01 P1 | `regression-before.log:3`: upstream acepta sin responder y sólo vence el cliente del test. El broker carecía de plazo propio; un stream detenido podía retener su lane. | `services/agent/broker.js`: presupuestos independientes de cola, cabeceras, inactividad, total y backpressure; abort upstream y limpieza. Tests con servidores TCP/HTTP reales comprueban liberación y siguiente petición. |
| F02 P1 | `regression-before.log:25,48`: JSON mal formado devolvía 502; JSON upstream inválido podía salir como 200. El contador `pending` se reiniciaba por chunk. | Validación de objeto/modelo/messages/tools, errores 400, comprobación de JSON no streaming antes de enviar cabeceras. Límite explícito por chunk y buffering JSON; streaming sin límite acumulado de salida. No se añaden límites de tokens ni se recorta contexto. |
| F03 P1 | `regression-before.log:71,88,111,133`: cancelación ignorada por internalClient y snapshot local que seguía esperando; `setInterval` podía acumular renovaciones de hasta 30 s sobre intervalo 20 s. `finally/onProgress` podía rechazar un task sin consumidor. | `internalClient.js`, `worker.js`: AbortSignal compuesto, reintento sólo de lecturas/heartbeat, espera de retry cancelable, renovación no solapada, aborto al perder lease, cleanup independiente acotado y errores de progreso observables. Pruebas verifican una renovación activa y aborto del snapshot. |
| F04 P0 | `fence-before.log:3`: **confirmado**, el lease vencía durante lookup/validación y la publicación se confirmaba igualmente. Sólo se comprobaba antes de validar. | `agentRepository.js`: revalidación dentro de la transacción y antes de terminar mutaciones; también páginas/sellado y respuesta de chat. Cero publicaciones y cero memoria tras expiración. Progreso efímero exige owner/fence y lease vigente; un aviso terminal no transporta texto. |
| F05 P1/P2 | Código original: messages/deviceAuth/run/status/publications pasaban por el escritor; SSE releía historial por conexión cada segundo. `all-regressions-before.log:389,419` observa el contador del escritor y cuatro clientes SSE. | Lecturas puras pasan por `queries` readonly/query_only y coalescing existente. `sessionAccess` comprueba acceso/revocación sin cargar mensajes. Claim espera también recuperación de queries. SSE limpia timer, contadores y salidas lentas; cuatro streams se cierran al revocar y no siguen consultando. No se prueba capacidad ilimitada de pestañas. |
| F06 P1 | `all-regressions-before.log:363` y código original: worker se declaraba running al crearlo; stdout/stderr ignorados. `verified:1007,1955,3360,3424,3442` contiene cinco salidas de hijos sin causa suficiente. | `managedRuntime.js`, `agent-worker.js`, `agent-opencode.js`: readiness tras informe del worker con control plane verificado, estado degradado/stale, drenaje de pipes con contadores y códigos permitidos, sin texto privado; backoff no se reinicia por arranques breves. Regresión y smoke real. Confirmada desaparición de los tres PID **y sus grupos** con señal 0. No se matan/adoptan puertos ajenos. |
| F07 P1 | `real-smoke.log:19` y `chat-tool-before.log:3`: background completed; chat failed `AGENT_TOOL_EVIDENCE_REQUIRED`. SQLite de la prueba registra un único assistant sin tool calls. No era un fallo de transporte. | `worker.js`: el incumplimiento del chat puede gastar la **misma única reparación** para exigir `agent.evidence` del snapshot. Si no consulta o vuelve a fallar, se rechaza; no se relajan citas ni validadores. Regresión positiva/negativa y smoke gestionado completo posterior pasa. |
| F08 P1 | `mcp-scope-before-detailed.log:3`: el perfil agent-evidence aceptaba `awareness`, permitiendo hechos vivos fuera del corte; `ogid_health` consultaba ese endpoint. | MCP `config.js`/`tools.js`: se retira esa operación del perfil restringido; health consulta sólo metadata operativa. Research general conserva sus operaciones. Regresión falla antes y 29 tests MCP pasan después. |
| F09 P1 | `all-regressions-before.log:571,595`: al fallar un dominio se perdía su lastSuccessAt; un cierre parcial podía terminar ready con nueva fecha de éxito. | `maintenance.js`: conserva éxitos anteriores, muestra stopped al interrumpir y evita duplicar timer. Pruebas de comportamiento. No se implementa un scheduler paralelo. |
| F10 P2 | `snapshot-copy.log:1`: una copia representativa con trabajos queued hacía que el comprobador reclamase otro trabajo y fallase después de modificar la copia. | `agent-snapshot-check.js`: admisión prioritaria de validación sólo en copia, enqueue/claim atómicos y rollback si no es el job esperado. Regresión conserva queued el trabajo previo. Copia de 4,26 GB: snapshot de 1.667 evidencias, 416 ms, sellado y hash recuperado al reabrir. Corte simulado; caché de disco no fría. |
| F11 P1 | `092503:22–25`: consulta Awareness de 28.155 ms en writer seguida de timeout a 30 s. `093603:548,1215,1314`: barridos de diagnóstico histórico; `093603:1829` supplemental sin finalizar a 180 s. | HEAD ya contiene proyección indexada/lector, contadores transaccionales y watchdog de progreso comprometido para adquisición. Tests pasan. No se imputa cada recuperación antigua a un único mecanismo ni se asegura que todo I/O frío esté resuelto. |
| F12 P1 | `verified:4053,4079,5034,5072`: scenarios/getLiveFeed agotan presupuestos y analysis se recupera dos veces. `read-isolation:137` conserva consulta de eventos de 25.907 ms. | HEAD conserva lecturas compartidas, índice por tiempo, preparación de escenarios y paginado físico. La consulta lenta sigue siendo posible; el nuevo aislamiento no demuestra capacidad suficiente. Falta ensayo frío representativo con agente, ingesta y cálculos simultáneos. |

`OpenCodeClient` también cancela cuerpos HTTP de error, libera su lector y clasifica JSON inválido sin reflejar contenido upstream. La regresión comprueba cancelación y ausencia de texto privado.

## Interpretación de los logs originales

- Arranque: 092503 falla por lectura Awareness en el escritor; recovery de cinco minutos falla con `STORAGE_START_TIMEOUT`. No son ensayos operativos satisfactorios.
- Carga: 093603 pierde escritor en supplemental. 102723/115112 y verified presentan timeouts de lector, indisponibilidad derivada y colas; el 115112 además pierde una escritura pipeline-stage. No se confunde `STORAGE_OUTCOME_UNKNOWN` de un lector antiguo con prueba de corrupción de negocio.
- Recuperación: ver reinicio/recovered no prueba progreso duradero. Los logs no conservan estados completos de todos los jobs, snapshots y turnos para cerrar cada operación incierta.
- Cierre: shutdown_failed aparece en 093603 y 115112. En final/run2/run3 hay cierres de aproximadamente 91/94/119 s; son un pendiente operativo, aunque terminen con server_stopped.
- WS: ocho conexiones y ocho desconexiones registradas; siete códigos 1005 y uno 1006 (`verified:5241`). El último sucede después de recuperaciones de analysis, pero faltan series de lag, heartbeat y cliente para atribuir causalidad. No se culpa al proxy.
- Validación: rechazos por cifras exactas, tarea/instrumento, evidencia sintética o IDs inventados son protecciones; no se convierten en publicaciones exitosas. Tampoco se consideran fallos de SQLite.
- Proveedores: GDELT/otros errores HTTP o cuotas se separan de saturación SQL. Las tasas publicadas usan endpoints HTTP completados como denominador, no líneas de error duplicadas ni disponibilidad temporal.

Los logs no contienen ninguna observación completa de 24 horas demostrable. Las carpetas de muestras originales están vacías en este checkout; faltan los JSONL/resúmenes/copias que algunos logs mencionan. Los informes históricos incluyen un snapshot llamado passed que tardó 55.790 ms: esa etiqueta por sí sola no cumple el gate actual de 30 s. El soak histórico de 30 minutos tampoco acredita la revisión actual.

## Garantías y límites de los cambios

No se modifican fuentes RSS, ventanas analíticas, históricos, contratos de cálculos ni migraciones 001–017. Los únicos cambios a adquisición son del **harness**: conserva 66 RSS configurados + 435 búsquedas generadas y redirige transporte a fixtures loopback. La primera versión del harness acumulaba errores de red artificiales; su resultado se conserva y se excluye de aceptación de adquisición sana.

El escritor de negocio sigue siendo el worker de almacenamiento existente; broker, OpenCode y worker de inteligencia usan HTTP/RPC. Lectores verifican `readonly` y `query_only`. Los tests prueban que una respuesta RSS sin terminar no retiene transacciones ni bloquea otros commits. Los snapshots parciales se rechazan y un fence vencido no puede confirmar las publicaciones probadas. Los IDs estables, unicidad SQL, transacciones y reconciliación dan idempotencia en los fallos ensayados; no una garantía distribuida universal.

`AGENT_MODE=off` fuerza todas las tareas off. En shadow, un override por tarea a visible **sí permite publicaciones visibles de esa tarea**: shadow global no es una barrera absoluta. Para observación estricta hay que comprobar todos los taskModes. La IA heredada llama.cpp se desactiva al activar el agente o degradarse su configuración; adquisición y cálculos no dependen de esa IA.

## Pendientes antes de promover

**Bloqueantes:** observación shadow de 24 h con corpus/ingesta reales; carga fría y concurrente de la copia representativa con ambos lectores; pruebas reales de caída/reinicio durante prompt, validación y publicación, respuesta perdida y dos workers; matriz LAN/proxy y navegador real; revisión semántica de los flujos aún inventariados. Confirmar calidad de las afirmaciones, no sólo pertenencia de citas. El entorno de despliegue conserva un alias de fondo distinto del residente y carece del binario gestionado fijado; los overrides de validación no lo configuran para producción.

**Importantes:** memoria y duración de prepareSnapshot, que aún materializa referencias/grupos antes de paginar; limpieza segura de builds abandonados y retención de evidencias referenciadas; competencia de mantenimiento y consultas en lectores compartidos; crecimiento del WAL y memoria nativa durante horas; autenticación sensible y fair latency de chat bajo inferencia de fondo. La prioridad de pendientes no preempta una inferencia válida.

**Posteriores:** métricas separadas de conexión TCP/TLS y primera cabecera (fetch sólo permite un presupuesto conjunto de cabeceras), progreso por fase más rico y diagnóstico estructurado adicional de hijos. La evidencia histórica de fundamentos/metadata capturada en snapshot no constituye un backtest válido: la opción de corte simulado no reconstruye todas las revisiones de todos los dominios.

Resultados y comandos: [validation.md](validation.md), [results.json](results.json). Operación y rollback: [runbook.md](runbook.md).

## Implementación posterior al corte vivo

Mejoras aplicadas, regresiones y evidencias sobre el proyecto/base reales: [improvements.md](improvements.md). Configuración y vigilancia vigentes: [runbook.md](runbook.md). Los diagnósticos anteriores se conservan como evidencia histórica.
