# Entrega D — cierre de implementación e integración

Corte: **27/10/2026**. Código publicado **[df50aae](https://github.com/Santiagovargas32/ogid/commit/df50aae482d8bacaf13f81c21dc0aa210b93ba8c)** en `feat/agentic-intelligence`; [CI 40499019337 correcta](https://github.com/Santiagovargas32/ogid/actions/runs/40499019337). Base anterior: `fd1652247892483e332148d9428d709318706ad2`, cierre de dependencias/enriquecimiento A/B/C. Documentación actualizada después de publicar código, con autorización del usuario; no confundir esa autorización con desplegar o promover IA.

Actualización **28/10/2026**: este cierre conserva las pruebas de D inicial; código posterior **124050a**. Entrada actual: [ESTADO.md](ESTADO.md); últimas ejecuciones D2/D3 y límites en [RESUMEN-ACTUAL-2026-10-28.md](RESUMEN-ACTUAL-2026-10-28.md). [EJECUCION-D-2026-10-27.md](EJECUCION-D-2026-10-27.md) conserva la cohorte anterior PID 988930. El [diseño previo](ENTREGA-D.md) se conserva fechado. **Cierre de código/pruebas; la capacidad operativa con adquisición concurrente y las puertas finales no están aceptadas.**

## Comportamiento implementado

- `SituationStore` sustituye el sondeo de últimas 500 filas de alertSync por consumidores durables de `news_comparison_changes` y `awareness_revisions`. Captura revisiones futuras de Awareness y una base histórica explícita; no inventa revisiones anteriores perdidas.
- Cursor, efectos, revisiones de dominio y outbox se confirman en la misma transacción del escritor. Páginas de hasta 100 referencias / 128 KiB y presupuesto de procesamiento por defecto 50 ms. El commit y E/S pueden exceder ese objetivo; se conservan guardias y errores visibles. Revisiones C con muchos miembros tienen continuación durable.
- Recibos por requestId, replay de ACK perdido e idempotencia. Leer outbox no equivale a confirmar entrega externa. Los cursores públicos fijan cortes estables; no confundirlos con el cursor interno de consumo.
- UUID propios para situaciones candidatas y para incidentes asociados explícitamente por operador. Agrupar titulares no confirma un incidente físico. Corroboración independiente permanece `not-established`; probabilidades desconocidas null.
- Evidencia exacta por revisión, modalidades y tiempos separados: ocurrido, publicado, recibido, cambiado y disponible. Sin evidencia del tiempo del hecho, occurredAt=null. Histórico o metadatos actualizados no crean por sí solos una alerta de incidente nuevo.
- Correcciones y reorganizaciones conservan IDs e historia. Las interpretaciones dependientes quedan needs-review sin reescribir snapshots. Merge/split de cobertura no fusiona IDs de incidentes. Prioridad crítica de A conservada; origen/revisor trazables.
- Alertas heredadas, lectura/archivo por dispositivo y ACK de la revisión vista conservados. Corregir una fuente puede volverla pendiente de revisión, sin sustituir contenido elegible por material sintético nuevo. Proyecciones del analista señalan fuentes revisadas; esto no implementa F ni reconstruye toda Awareness histórica para el analista.
- Reutiliza AgentMaintenance y su temporizador adaptativo; no crea otro scheduler y no necesita navegador ni inferencia para ejecutar el consumidor. La puesta al día bajo adquisición se comprobó después en D3; estabilidad de E/S y reanudación necesitan el cierre operativo indicado abajo.

## Esquema y contratos

| Migración aplicada | Función |
|---|---|
| 026_situations.sql | Journals, bootstrap, consumidores, situaciones, evidencia, invalidaciones, outbox y compatibilidad de alertas |
| 027_situation_reference_versions.sql | Referencias de incidentes a cortes históricos y orden de revisiones heredadas |
| 028_awareness_upsert_journal.sql | Captura correcta de revisiones bajo UPSERT de SQLite y guardia monotónica |
| 029_situation_reverse_links.sql | Índice para paginar asociaciones en ambos sentidos |

Esquema efectivo **029**, cambios aditivos; no editar 001–029 ni abrir la base con código anterior que los desconozca. Un escritor y lectores readonly/query_only.

Contrato **1.12.0**, **98 rutas / 107 operaciones**. Nuevas lecturas: `situations.list`, `status`, `detail`, `revisions`, `changes`; mutación `situations.review`, con operador `situations:write`, referencias/motivo/revisor e idempotencia. Rutas GET `/api/situations`, `/api/situations/status`, `/api/situations/:id`, `/api/situations/:id/revisions`, `/api/situation-changes` y POST `/api/admin/situations/review`.

Inventario ejecutable: `integrations/ogid-mcp/API-MCP.contract.json`; `npm run inventory:check` lo compara con el registro. API-MCP.md quedó en el corte anterior al publicar D porque se excluyeron MD; con la autorización documental actual se regenera desde el mismo registro y se valida mediante `inventory:check-markdown`. No simular coherencia cambiando una versión a mano. El perfil del agente continúa restringido a evidencia congelada; nuevas operaciones públicas no amplían sus permisos automáticamente.

UI: `/situations.html` con filtros, calidad/backlog, evidencia, asociaciones e historial por corte; enlaces desde dashboard/bandeja. Texto seguro, fechas desconocidas y atributos de fuente visibles; paginación conserva foco/scroll. Investigación de medios y comparaciones siguen en `/sources.html` y `/comparisons.html`.

## Verificaciones de D inicial realmente ejecutadas

Backend completo **1.089/1.089** y una prueba posterior adicional de reinicio real de writer/readers. MCP completo **33/33**, incluido stdio+HTTP+SQLite con IA off, revisión autorizada y corrección/corte congelado. Build/check/inventario/diff correctos; CI remota también pasó instalaciones y ambas auditorías runtime. No hubo cambios de dependencias de D.

Casos dirigidos: news 613, Awareness 527, reinicio con 613, ACK perdido, rollback de outbox, fuente demasiado grande bloqueada, merge/split de 150 miembros con continuación, cortes concurrentes, modalidades/sintéticos/no soportados, fechas con offset, prioridad crítica, conteo exacto de exclusiones y temporizador único. Fallos iniciales de UPSERT/alertas históricas y pruebas de entorno se corrigieron; sus logs no se presentan como pasadas correctas.

Firefox real: fixture a 1280/390 px con 15 contextos, 14 evidencias e historial, foco/scroll y texto seguro; después UI con la base operativa y backend iniciado exclusivamente por npm start. Dashboard con noticias/mercados y WebSocket conectado, fuentes/comparaciones/situaciones/evidencias renderizadas sin overflow. MCP research stdio real list/detail funcionó; un catálogo antiguo en el chat necesitó refresco para admitir los nuevos operationId.

## Replay y servicio real — cortes separados

1. Bootstrap inicial: 146.475 entradas news + 2.861 Awareness procesadas; 10.252 situaciones, 10.513 evidencias/outbox, ningún incidente inferido. Se conservaron artículos/revisiones/snapshots y los 157 IDs de alertas existentes; 29 revisiones de metadatos añadidas a alertas, sin nuevos IDs históricos. Se corrigió un sobreconteo diagnóstico al diferir filas por bytes y se reconcilió sólo ese contador, con regresión.
2. Primer smoke npm start: servidor PID 979268, readiness en unos 29 s, dependencias matched y esquema 029. Cierre 11:55:18 UTC limpio. Los cambios de adquisición del smoke se drenaron después en 52 páginas; a las 11:56 UTC news=155.744/155.744, awareness=2.995/2.995 y outbox=11.798. Ese «sin pendientes» fue un corte, no una garantía futura.
3. Ejecución posterior del usuario PID 988930: observador de 71 muestras y cierre solicitado a las 13:19 UTC. El corte readonly de las 13:32 UTC ya tiene 150.671 artículos y **distancia news pendiente 16.337**. No se drenó durante aquella actualización documental. Detalle, denominadores y fallos en EJECUCION-D.

Mediciones del primer replay: 2.381 páginas tras las 30 iniciales, p95 de ejecución 62,79 ms y máximo 953,54 ms; commitMs null no equivale a cero. Ocho lecturas list reales de 20 elementos: 5,43–11,29 ms, una consulta concurrente con suites, Ryzen 5 4500 / 12 CPUs lógicas / 16,64 GB RAM / Node 22.23.3. Son cohortes concretas, no un SLO general. Evidencia privada en `.implementation-evidence/2026-10-27/D/` y `D-release/`.

## Continuación de código y D3 — 28/10/2026

Mantenimiento 4bf31a6, correlador compacto c5c1ea0 y ajuste **124050a** preservan contratos/esquema. El último admite páginas D aunque RSS espere red, acorta la pausa con backlog, estabiliza el descubridor principal, evita leer cuerpos de nuevas fuentes excluidas, lee payloads por rowid conservando orden editorial, agrupa checkpoints RSS y acota estados reemplazables/retry/cierre.

Candidato del ajuste: backend **1.110/1.110**, MCP **33/33**, build/check/inventario correctos y proyecciones completas iguales en 5.407 filas reales readonly. No repetir suites por documentar este cierre. El ensayo D3 empezó con diff sobre c5c1ea0 y el mismo artifactHash que 124050a, creado después.

D3 procesó 35.542 revisiones frente a 5.009 producidas durante la hora: backlog **30.533 → 0**. Después del cierre: news **240.462/240.462**, awareness **3.813/3.813**. Tramo nuevo 9.905 revisiones/outbox y 5.323 evidencias, sin referencias ausentes en lo comprobado. Correlador sin rechazo de tamaño registrado y señales persistidas. Estos resultados sustituyen los pendientes de atraso/tamaño de los cortes anteriores, sin borrar su evidencia histórica.

## Pendientes de aceptación y reversión

- **0.2/E/S:** D3 terminó tras unas 23 h 16 min con escritor en commit/btrfs_sync_log y lectores esperando E/S. Causa física exacta no establecida; no demuestra un nuevo checksum corrupto. Analizar presión de app/host y reducir trabajo redundante conservando límites, FULL y un escritor.
- **Persistencia/reanudación:** 12 eventos de observaciones de mercado con timeout de cola, dos fases finales sin confirmar y un intento IA sin cierre/lease vencido. Falta acreditar recuperación real con recibos/fences. No reinterpretar backlog cero como confirmación de todos los comandos en vuelo.
- E, F y evaluación editorial/semántica pendientes. D3 dejó 34 intentos completados, 160 fallidos, 2 incompletos y 1 sin cierre; publicaciones shadow, sin evaluación semántica. El cierre automático no fue limpio.
- 24 h continuas del candidato final pendientes: la hora de observador D3 completada y el log extendido que termina con fallo no las satisfacen.

Reversión lógica compatible con 029: pausar capacidades/consumidor si hace falta, conservando cursor, outbox, revisiones y compatibilidad de alertas. No borrar proyecciones para obtener verde ni restaurar la base dañada. El usuario mantiene el backup manual.
