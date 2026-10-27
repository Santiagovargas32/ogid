# Estado actual de OGID — leer primero

Actualización documental: **27/10/2026**, después del cierre de la ejecución PID 988930. Plan **v5**. Rama `feat/agentic-intelligence`; código publicado **[df50aae482d8bacaf13f81c21dc0aa210b93ba8c](https://github.com/Santiagovargas32/ogid/commit/df50aae482d8bacaf13f81c21dc0aa210b93ba8c)**, [CI 40499019337 correcta](https://github.com/Santiagovargas32/ogid/actions/runs/40499019337). Esta actualización documental se publica aparte del código; no introduce cambios de runtime ni implica arranque o aceptación operativa.

**A–D implementadas; D publicada y comprobada con backend/UI/MCP reales.** El producto completo y la aceptación operativa siguen pendientes. La ejecución más reciente dejó backlog del consumidor D, episodios largos de almacenamiento y fallos de IA; el cierre limpio no los resuelve. Siguiente entrega de producto: **E**, precedida por un lote acotado de las brechas D/0.2 observadas cuando se autorice retomar código. No rehacer A/B/C/D ni repetir suites cerradas sin cambios/fallos.

## Entrada única y documentos

| Documento | Función y alcance |
|---|---|
| [ESTADO.md](ESTADO.md) | Identidad, estado actual, limitaciones y próxima acción |
| [CIERRE-D.md](CIERRE-D.md) | Qué implementa D, contratos, pruebas, replay y puesta en servicio comprobada |
| [EJECUCION-D-2026-10-27.md](EJECUCION-D-2026-10-27.md) | Último observador, log completo, resultados por intento, cierre y corte actual de datos |
| [CIERRE-FINAL.md](CIERRE-FINAL.md) | Qué falta para terminar producto y validaciones, con puertas separadas |
| [PLAN.md](PLAN.md) | Dirección, entregas y criterios de aceptación v5 |
| [DECISIONES.md](DECISIONES.md) | Decisiones cronológicas; D40–D47 incorporan D y esta actualización |
| [PROMPTS.md](PROMPTS.md) | Reanudación y próximo lote sin depender del chat |
| [FUENTES.md](FUENTES.md) | Identidad, perfiles, evaluaciones políticas, cobertura y piloto E |
| [API-MCP.md](../../../integrations/ogid-mcp/API-MCP.md) | Inventario generado de rutas, operaciones, parámetros y permisos 1.12.0 |

El [diagnóstico del 25/10](../../OGID-diagnostico-direccion-y-plan-2026-10-25.md), [CIERRE-C.md](CIERRE-C.md), [RECUPERACION.md](RECUPERACION.md) y [HISTORICO-CONTINUIDAD.md](HISTORICO-CONTINUIDAD.md) son cortes históricos. [ENTREGA-D.md](ENTREGA-D.md) conserva el diseño previo y enlaza su cierre; sus frases históricas «D pendiente», «025» o «siguiente 026» no describen el presente. El corte anterior de ESTADO está conservado en HISTORICO-CONTINUIDAD.

## Identidad, base y procesos

- Contrato **1.12.0**, **98 rutas / 107 operaciones**; esquema efectivo **029**, migraciones 026–029 aplicadas e inmutables. Siguiente número disponible: 030, sólo si un cambio lo necesita. Inventario ejecutable `integrations/ogid-mcp/API-MCP.contract.json`; `npm run inventory:check` lo valida. En esta actualización se regenera también API-MCP.md desde el registro y se valida con `inventory:check-markdown`; no editar los inventarios a mano.
- ArtifactHash backend observado: `e5b5425d9468ae524e099a30e2938fa6203dfd26555e5ee0f554e43a53bea058`. Identifica archivos de runtime, no atesta configuración, datos, UI ni instalación. La última ejecución observó ese mismo artefacto; la identidad del código y la del proceso son datos distintos.
- `.env` selecciona `/home/fedora/.local/share/ogid/db/ogid-repaired-20261026-183735.sqlite`. Recuperación exacta cerrada; no volver al original dañado ni repetir copias/forense como precondición. Backup manual a cargo del usuario.
- Backend **detenido**: único SIGTERM al PID verificado 988930; `server_stopped` **13:19:52.778 UTC**, `primaryCause:null`, `unconfirmedPersistence:[]`, `cleanupErrors:[]`. Sus hijos terminaron; puerto 3000 libre. Corte readonly posterior: **0 propietarios escritores, 0 trabajos activos, 0 handles de SQLite**; llama.cpp preservado. Observador detenido por el usuario antes del backend.
- El trabajo IA activo quedó **incomplete / ABORT_ERR**, cancelado por el cierre. No contarlo como finalización semántica ni como corrupción de persistencia. Túnel/adaptador MCP se conservan; sin backend, CONNECTION_FAILED es esperado. Las operaciones nuevas requieren refrescar el catálogo de una conexión que aún conserve el enum antiguo; stdio research real sí pasó.
- Arranque exclusivamente `cd backend && npm start`; hijos gobernados por `.env`, conservar llama.cpp y shadow. No systemd. Un escritor de negocio, lectores readonly/query_only, límites/fences/leases y evidencia inmutable.

Dependencias del cierre: Node operativo **22.23.3**, Express **5.3.0**, Helmet **8.3.0**, ws **8.22.0**, Yahoo Finance **4.0.5**, SDK MCP cliente/servidor **2.4.0**, Zod **4.6.7**, dotenv **16.6.1**. Manifiesto de arranque matched, **0 discrepancias**; CI D pasó ambas auditorías runtime. Son resultados fechados, no una garantía permanente. No repetir npm ci sin cambios/fallos o desfase comprobado.

## Datos: corte readonly del 27/10 a las 13:32:33 UTC

| Superficie | Resultado |
|---|---|
| Noticias / facetas B / publicaciones C | **150.671 / 150.671 / 150.671** |
| Afirmaciones extractivas atribuidas C | **220.677**; no son hechos verificados |
| Situaciones / incidentes explícitos | **12.032 / 0**; contextos candidatos, no incidentes inventados |
| Versiones de evidencia D / outbox | **12.435 / 14.113**; son registros distintos, no tienen que coincidir |
| Alertas actuales | **161**; hay adquisición posterior al baseline de 157 |
| Evaluaciones políticas / perfiles editoriales | **0 / 0**; «sin evaluar» y campos desconocidos son correctos |
| Consumidor news | **170.399 procesado / 186.736 disponible**, distancia **16.337**; continuación null, error null |
| Consumidor awareness | **3.097 / 3.097**, sin backlog; revisiones no elegibles para D según la política de clases/fuentes, no cobertura de incidentes acreditada |

La distancia de secuencias no es número de incidentes ni recuento exacto de filas si hay huecos. `state:ready` e inicialización completa coexisten con **hasMore:true**: no confundirlos con backlog cero. Último avance news registrado **13:13:17.992 UTC**; los pendientes se conservan tras apagar. No se ejecutó otro replay/backfill durante esta actualización documental.

El lote del 26/10 enriqueció **146.475** noticias bajo los métodos vigentes y verificó conservación global de IDs/fechas/contentRevision y muestras congeladas. Es un baseline, no el tamaño actual. Sus 141.959 editores pendientes, 34.161 unknown-language y 2.671 unsupported-language son cifras de aquel corte; no se han recalculado para la última ejecución. Más noticias no generan por sí solas una evaluación política; perfiles y evaluaciones requieren importación documentada. Detalle en FUENTES.

## Verificación y límites actuales

D: backend **1.089/1.089** y una prueba adicional de reinicio real del escritor/lectores; MCP **33/33**, build/check/inventario y CI correctos. Ráfagas news 613 y awareness 527, retry/ACK perdido, atomicidad, correcciones/cortes, merge/split e IA off cubiertos. Firefox 1280/390 px sobre fixture y después sobre la base real: dashboard, fuentes, comparaciones, situaciones/evidencias, foco/scroll y WebSocket. Primer arranque real del lote: unos **29 s**; la última ejecución registró server_started unos **34 s** después de iniciar el proceso. No repetir estas suites por editar MD.

Último observador: **71 muestras**, 12:02:55.223–13:13:35.090 UTC (~1 h 10 min 40 s), **200 en health/ready/admin-agent en todas**, backendChanges=0, recuperaciones de lectores=0. Se interrumpió: **completedObservation=false**. No es una aceptación de 24 h. Resultado durable por intento del arranque: **5 completados, 6 fallidos y 1 incompleto por cierre**, detallados por tarea en EJECUCION-D; no sumar contadores históricos ni llamadas del broker.

**Abiertos y medidos en el log completo:** SQL lento hasta **9.781 ms**, commits hasta **20.605 ms**, checkpoints hasta **22.109 ms**, 8 muestras con algún heartbeat de almacenamiento >15 s, **68** rechazos del correlador `STORAGE_COMMAND_TOO_LARGE`, y backlog D señalado arriba. No hay causa física demostrada. No elevar límites ni atribuir el atraso a una causa concreta sin reproducir. IA: rechazos `AGENT_UNVERIFIED_NUMBER`/`AGENT_UNKNOWN_EVIDENCE`, una ejecución incierta con señal de lease y un turno fallido; conservación de guardias, no aceptación semántica.

## Secuencia y siguiente acción

| Entrega | Estado y aceptación pendiente |
|---|---|
| 0 | Identidad, mantenimiento determinista, recuperación e instalaciones implementados; **0.2 y aceptación operativa abiertos** |
| A | Publicada 9cbdef2; enriquecimiento baseline cerrado, EN/ES/FR/DE/PT y desconocidos explícitos; ampliaciones evaluadas en E |
| B | Publicada 9a3aa2f; importador/perfiles/medidor/cobertura implementados; ningún dataset político real incorporado |
| C | Publicada 40a027d; comparaciones/afirmaciones/histórico; agrupación no acredita independencia ni ocurrencia |
| D | Publicada **df50aae**, código y pruebas cerrados; **backlog/capacidad bajo adquisición y aceptación operativa pendientes** |
| E | Siguiente entrega: fuentes/perfiles/enriquecimiento permitido y piloto Ucrania/Mar Negro + mar Rojo |
| F | Síntesis, cronologías e impactos sobre evidencia elegible; evaluación por tarea |
| Final | Pruebas progresivas, candidato identificado sin cambios durante 24 h continuas y puerta IA separada |

Secuencia acordada: **D → E → F → validación final**, con pruebas por entrega. Antes de ampliar el piloto E, el próximo lote de código recomendado es reproducir y acotar **backlog D + rechazos del correlador**, coordinando el mantenimiento y los trabajos analíticos existentes. Confirmar cursor/efectos/outbox y costes de cola/SQL/commit/checkpoint; no reiniciar el plan, saltar entradas ni aumentar guardias. No arrancar operación ni publicar por esta actualización de documentación; la sesión siguiente fija el alcance.

Evidencias privadas: `.implementation-evidence/2026-10-27/D/`, `D-release/`, `shutdown-988930/`, `docs-update/`, y `.agent-validation/shadow-24h-D-20261027-130254/` + `shadow-backend-D-20261027-130208.log`. Los MD contienen el resumen portable; no publicar bases, logs, secretos ni artefactos voluminosos.
