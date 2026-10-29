# Estado actual de OGID — leer primero

Actualizado **29/10/2026**, lote **D/0.2 publicado**, base operativa revisada `dcde8bd959d504cf5a240ef47de4c18419ce5ac2`, rama `feat/agentic-intelligence`. `504df67`, `cfea52f` y `dcde8bd` comparten árbol `103233d276ebed42cdf30f24cd1501adf4117200`. Plan **v7**. Diagnóstico acotado de E/S cerrado con limitaciones; el usuario autoriza el **29/10** publicar este avance y sus MDs mediante el conector GitHub en la misma rama. **Sin merge, despliegue, promoción, nuevos arranques ni E/F**. Último resultado: **[CIERRE-D02-IO.md](CIERRE-D02-IO.md)**, seguimiento [KAN-8](https://santiagovargasmunoz.atlassian.net/browse/KAN-8) En progreso. [CIERRE-D02.md](CIERRE-D02.md) conserva A/B; la publicación posterior no les atribuye el artefacto final.

**Núcleo con IA off; no apto para empezar E.** Pausa ya configurada y conservada: AGENT_MODE y los tres hijos off, AI_PROVIDER=none/AI_MODE=off, AGENT_TASK_MODES={} sin cambios. AgentMaintenance habilitado por business. Esquema real 029, contrato 1.12.0, instalaciones backend/MCP matched sin modificar locks. Base reparada y llama.cpp conservados.

Implementado: reconciliar leases vencidos sin reclamar trabajo IA; bloquear snapshots IA en off; consultar cursor durable antes de reanudar velas; distinguir fallos de velas/proyección y hacer visible la persistencia sin resolver en drain y shutdownReport; correlacionar requestId durable con despacho sin payloads. No se reimplementan A–D ni se crea otra cola.

La cohorte A histórica **PID 1088798** terminó automáticamente el **28/10 a las 19:58:48.235 UTC**, por **STORAGE_OUTCOME_UNKNOWN / STORAGE_EXECUTION_TIMEOUT** en commit/btrfs_sync_log, con cuatro fases sin confirmar; el controlador **no envió señal**. B **PID 1104931** recibió un único SIGTERM, pero falló un lector con resultado incierto durante drain: su reporte vacío no acredita cierre limpio. Ese punto ciego se corrigió después y se probó con fixture. No confundir la caída de Code con una causa física demostrada.

**C-IO, 28/10:** operó el artefacto final `97d6ace9…`, principal **1124214**, server_started **21:22:20.015 UTC**. Reprodujo presión grave de memoria/E/S compartida con Code/Codex y un commit FULL completado de **599,543 s**. SIGTERM coordinado **21:38:01.268**, server_stopped **21:39:08.314** con **seis proyecciones indicators sin confirmar** y MARKET_PERSISTENCE_UNCONFIRMED: cierre no limpio. El corte manual llegó tarde por el bloqueo del propio observador/herramientas. No hay parche de negocio sustentado; memoria/reclaim es la contribución mejor acreditada, sin aislar dispositivo/Btrfs. Cero errores Btrfs nuevos en la cobertura disponible. No se declara resuelto.

**Corte durable comprobado el 29/10:** artículos **163.756**, news **241113/241168** (**55 pendientes durables**), awareness **3824/3851** (**27 pendientes**), dominio/outbox **24688/24688**; referencias nuevas comprobadas sin ausencias. **313 jobs de velas completos**, cero pendientes: los seis jobs identificados de C-IO tienen cursor y 32/32 efectos OHLCV confirmados; sus proyecciones no tienen nuevos resultados en la cohorte y siguen sin confirmar. No son los **12 errores D3**, cuya identidad histórica sigue desconocida. IA idéntica: **1171 intentos / 889 snapshots / 181 publicaciones**, lease D3 incomplete y fence/attempts/snapshot conservados.

Al retomar tras un reinicio del host **29/10 11:36:44 UTC**, se habían perdido los crudos/log C-IO guardados temporalmente en /tmp. El cierre nuevo distingue métricas de la transcripción de lecturas persistentes actuales; no se rehace la cohorte ni se inventa cobertura. Comprobación del 29/10: **cero backend/owners, puerto cerrado, llama.cpp activo** con PID del nuevo boot 1543/1872, sin señales de esta tarea.

**Validación:** artefacto D/0.2 previo backend **1.119/1.119**, MCP **33/33**, check/build e inventarios **98/107**; CI merge **40768313007**, según el corte remoto aportado. No se repiten suites por colector/documentación. Avance de E/S: **8/8 pruebas del colector**, smoke de dos muestras con archivo privado persistente y diff-check correcto; esquema 029, instalaciones matched y hash de aplicación/.env conservados. Aceptación operativa abierta; operar el artefacto final en C-IO no confirma retrospectivamente A/B ni todos los fixtures del lector incierto.

**Única siguiente acción propuesta:** ensayo de aislamiento de memoria, con cierre de Code/Codex por el usuario y llama.cpp conservado; exigir ≥4 GiB disponibles durante 180 s, captura persistente y controlador de corte independiente antes de otra cohorte. Impacto/reversión y límites en CIERRE-D02-IO. **No ejecutado ni nuevo arranque autorizado por inferencia. E sigue no apto**, KAN-8 En progreso; no exigir reconstruir identidades que los 12 logs D3 nunca registraron ni declararlas recuperadas. Sin E/F ni 24 h formales.

## Checkpoint histórico D3 — anterior a D/0.2

El resto de este corte documenta la revisión D3 y su base `124050a`; no sustituye D/0.2 ni C-IO ni autoriza repetir sus acciones. Los PID, cifras y configuración siguientes pertenecen a esa cohorte.

**A–D implementadas e integradas. D3 drenó el backlog; la estabilidad de almacenamiento falló al final de la ejecución extendida.** 0.2 y aceptación operativa abiertas; E/F y entrega final pendientes. No rehacer A/B/C/D, instalaciones ni enriquecimiento baseline por usar cifras históricas.

Resumen autónomo para preparar el siguiente prompt: **[RESUMEN-ACTUAL-2026-10-28.md](RESUMEN-ACTUAL-2026-10-28.md)**. [PLAN.md](PLAN.md), [DECISIONES.md](DECISIONES.md) y [PROMPTS.md](PROMPTS.md) contienen dirección/restricciones; [CIERRE-D.md](CIERRE-D.md) y [CIERRE-FINAL.md](CIERRE-FINAL.md), implementación y aceptación pendiente; [FUENTES.md](FUENTES.md), identidad/evaluaciones/piloto E. Inventario generado [API-MCP.md](../../../integrations/ogid-mcp/API-MCP.md), JSON ejecutable al lado.

El [diagnóstico del 25/10](../../OGID-diagnostico-direccion-y-plan-2026-10-25.md) fija la dirección. CIERRE-C, RECUPERACION, HISTORICO-CONTINUIDAD y EJECUCION-D-2026-10-27 son cortes históricos; ENTREGA-D es diseño previo. Sus procesos/backlog/esquemas/suites no sustituyen este estado. ESTADO v5 se conserva en Git.

## Identidad, instalación, base y proceso

- D inicial `df50aae`; mantenimiento separado `4bf31a6`; correlador compacto `c5c1ea0`; ajuste de consumo/persistencia/lecturas **124050a**. Publicación mediante conector, sin merge ni despliegue implícitos.
- D3 ejecutó los últimos archivos cuando aún había diff sobre c5c1ea0. ArtifactHash **`0f825dcc7aad4a103fc90a7ff9864784d75476a5fe2b321435bc38613545a86c`**, coincidente con el código de cierre. El SHA se creó después de D3; el hash local no certifica toda la instalación/configuración/UI/datos.
- Contrato **1.12.0**, **98 rutas / 107 operaciones**; esquema efectivo **029** según schema_migrations, no PRAGMA user_version. 001–029 inmutables; siguiente disponible 030. Este ajuste no cambia esquema, dependencias ni configuración.
- Manifiesto backend contrastado el 28/10: Node **22.23.3**, **matched / 0 discrepancias**. Instalaciones backend/MCP y enriquecimiento baseline cerrados en `fd165224`; no repetir npm ci sin cambio/desfase. Auditorías y CI anteriores son resultados fechados; la CI del nuevo commit se consulta por su SHA.
- `.env` conserva `/home/fedora/.local/share/ogid/db/ogid-repaired-20261026-183735.sqlite`, en Btrfs `/dev/sda3[/home]`. Recuperación exacta del 26/10 cerrada; original dañado preservado. No imponer copias/recuperación como precondición; backup manual del usuario.
- Último backend **PID 1047352**, iniciado por el usuario con npm start. Cierre automático **28/10 18:15:31.100 UTC**, causa **STORAGE_OUTCOME_UNKNOWN / STORAGE_DISPATCH_TIMEOUT**, **dos fases de persistencia sin confirmar**, cleanupErrors vacío. No fue un cierre limpio ni una señal enviada por la revisión.
- Comprobación posterior: PID ausente, puerto 3000 sin aceptar conexiones y **0 owners escritores**. Un intento IA sigue registrado running con lease vencido; no prueba un proceso activo ni finalización durable. No se arrancó/reanudó/reparó trabajo durante el análisis.

Un escritor, lectores readonly/query_only, FULL, límites, fences, leases y reparación única conservados. Arranque sólo `cd backend && npm start`, hijos según .env, conservar llama.cpp, sin systemd. IA shadow; publicar código no la promueve.

## Datos — consultas readonly del 28/10/2026, 18:33–18:36 UTC

| Superficie | Resultado |
|---|---|
| Artículos / revisiones | **163.334 / 535.538** |
| Publicaciones de comparación C | **163.334** |
| Incorporados durante D3 | **10.692** nuevos para la base; pueden tener publicación antigua |
| Consumidor news | **240.462 / 240.462**, continuación/error null |
| Consumidor awareness | **3.813 / 3.813**, continuación/error null; entradas excluidas por la política D |
| Dominio / outbox | **24.649 / 24.649** |
| Alertas heredadas | **176**, no incidentes físicos verificados |
| Señales | **11.748** filas de buckets; snapshot **18:12:03.906 UTC** |

Los cursores coinciden con las cabeceras durables. No confirman el trabajo RSS/mercado que quedó en vuelo. Lecturas y referencias comprobadas no constituyen una nueva validación global de integridad.

El baseline enriqueció **146.475/146.475** el 26/10 conservando identidad/fechas/contentRevision/snapshots. Sus 141.959 editores pendientes, 34.161 unknown-language y 2.671 unsupported-language no se han recalculado para el corpus actual. La adquisición nueva usa el flujo normal A/B/C/D; no rehacer el baseline. Evaluaciones/perfiles: último recuento documentado **0/0 el 27/10 13:32 UTC**, no recalculado en D3. Más noticias no producen evaluaciones políticas.

## Verificación y ejecución

Candidato de 124050a: backend **1.110/1.110**, MCP **33/33**, build/check e inventario **98/107** correctos; corpus real readonly de **5.407** filas con proyecciones completas iguales al lector previo. Caché/E/S del sistema sin controlar: no acredita 10× de velocidad ni un SLO. En este cierre documental se revisan evidencias/diff/enlaces/publicación; no se repiten suites cerradas ni se atribuye CI antigua al nuevo commit.

**D2 histórico:** el backlog creció de 16.417 a 27.684 en la hora y acabó en 30.509 tras el cierre solicitado. Timeouts y error de limpieza motivaron el ajuste posterior.

**D3:** observador de **61 muestras**, 27/10 **19:00:03.250–20:00:02.960 UTC**; health/ready 61/61, agente 60/61 y situaciones 60/61, con un timeout de cada una. Misma identidad, 0 cambios de backend y 0 recuperaciones de lectores en esa hora. News **30.533 → 0** pendientes; primera muestra al día **19:03:14.734**. **35.542** revisiones procesadas frente a **5.009** producidas durante la ventana. Log del backend hasta **28/10 18:15:31**, unas **23 h 16 min** desde el inicio: no son 23 h de observador ni 24 h aceptadas.

Tramo durable nuevo D3: **9.905** revisiones/outbox y **5.323** registros de evidencia, sin referencias ausentes ni emisiones new-report sin evidencia en lo comprobado. No son incidentes confirmados. Correlador sin STORAGE_COMMAND_TOO_LARGE registrado, con señales persistidas; no tratar ese defecto como reproducido actualmente.

## Fallos abiertos y siguiente acción

1. **E/S y escritor:** transacción de **85,538 s** en fase commit, hilo en btrfs_sync_log; lectores en blk_mq_get_tag, PSI full avg10 ≈71 %. Fallaron primero análisis/consultas y después expiró un heartbeat despachado. STORAGE_NOT_READY es consecuencia. Causa física exacta no establecida; el registro no demuestra un nuevo checksum Btrfs.
2. **Persistencia/reanudación:** 12 eventos market_observations_persist_failed / STORAGE_QUEUE_TIMEOUT; dos fases finales sin confirmar (history-cancellation, pipeline); RSS interrumpido e intento IA con lease vencido. Falta recuperación real con recibos/fences, sin replay ciego de resultados inciertos.
3. **IA:** **197 intentos job/fence = 34 completed + 160 failed + 2 incomplete + 1 sin cerrar**. Las 34 publicaciones son shadow; sin revisión semántica. Fallos de números/evidencia/formato/instrumento y preparación/modelo detallados en el resumen.
4. **Producto/final:** E/F sin implementar; contratos/UI/rendimiento/recuperación integrados y 24 h finales pendientes. Fixtures previos de reinicio/ACK/ráfagas no acreditan recuperación real tras este fallo.

**Siguiente acción al autorizar código:** lote D/0.2 focalizado en presión de E/S/confirmación y persistencia de mercado, partiendo de D3. Correlacionar app, commits/checkpoints y esperas del host; reducir trabajo repetido conservando cobertura/durabilidad. Verificar reanudación real y carga; continuar **E → F → validación final**. No repetir el backlog drenado ni otra recuperación sin evidencia nueva.

Evidencia privada: `.implementation-evidence/2026-10-27/D2/review.json`, `D2-fix/result.json` y `.implementation-evidence/2026-10-28/D3-review/review.json`; logs/observador en el resumen. No publicar bases, logs, credenciales, modelos ni artefactos privados.
