# Operación y recuperación de OGID

Aplicable a las correcciones locales sobre `5ac40d7`, esquema 001–017. No autoriza despliegue ni cambios a servicios existentes. Mantener llama.cpp y su modelo residente. El inicio normal sigue siendo exclusivamente:

```bash
cd /home/fedora/ogid/backend
npm start
```

## Incidente posterior que condiciona la siguiente vigilancia

La ejecución de las 15:22–15:31 CEST terminó por timeout del escritor en domain.registry al reconstruir el índice de eventos. Sigue pendiente de corrección; no considerar aprobada la vigilancia. El operador cambió después llama.cpp/.env a GPT, pero catálogo y selección durable del agente siguen en Qwen. **La configuración descrita en el apartado siguiente corresponde al cierre de la mejora anterior y ya no describe el modelo solicitado actualmente en .env.** Antes de otra aceptación de 24 h, resolver el bloqueo del registro y validar/alinear GPT sin alterar ejecuciones previas. Diagnóstico completo: [last-run-review.md](last-run-review.md). Esta revisión no cambió servicios, configuración ni base.

## Estado tras las mejoras operativas

Las rutas de operación ya están preparadas en el `.env` local y no dependen de los ficheros de ensayo: `AGENT_MODEL_MANIFEST=data/agent-runtime/models.json`, `AGENT_OPENCODE_BINARY=data/agent-runtime/bin/opencode`, modelo `llamacpp/qwen3-coder`, `AGENT_MODE=shadow`, `AGENT_TASK_MODES={}`, los tres componentes on y legacy none/off. Conservar llama.cpp residente. La base principal sigue en esquema 001–017; estas mejoras no requieren SQL manual ni migraciones nuevas.

El panel antiguo se ha sustituido por procesos, trabajos y publicaciones del agente. En `/admin` se pueden revisar respuestas shadow completas y sus límites/referencias; las rutas públicas continúan ocultándolas. Ya no hace falta consultar SQLite para leer las cinco publicaciones más recientes. Progreso y contadores del arranque están separados de los históricos. La descripción de la inspección inicial que sigue abajo es histórica, no la configuración vigente.

Para iniciar una nueva vigilancia, desde backend, con una carpeta de observación nueva:

```bash
cd /home/fedora/ogid/backend
umask 077
mkdir -p ../.agent-validation
set -o pipefail
npm start 2>&1 | tee "../.agent-validation/shadow-backend-$(date +%Y%m%d-%H%M%S).log"
```

En otra terminal:

```bash
cd /home/fedora/ogid/backend
node scripts/agent-shadow-observe.js "../.agent-validation/shadow-24h-$(date +%Y%m%d-%H%M%S)" 24
```

Esperar readiness y worker conectado; comprobar que las tareas son shadow, paused=false y que los trabajos cambian de fase/terminan. La telemetría distingue modo desconocido durante inicialización de modo visible. No reiniciar una ejecución válida por observar contadores acumulados constantes. Para cerrar usar Ctrl+C una vez y esperar server_stopped y cleanupErrors=0: los ciclos ya aceptados pueden necesitar drenaje. Revisar también que desaparezcan los procesos hijos gestionados. Resultados y limitaciones de esta revisión en [improvements.md](improvements.md).

## Dónde ver el trabajo y la respuesta

En `/admin`, el panel del agente muestra disponibilidad, tareas/modos, trabajos recientes y acumulados, fases, primera señal útil, herramientas, errores y snapshot/fence. «Respuestas validadas del agente» muestra las cinco publicaciones durables más recientes, incluidas shadow, con su propuesta completa, límites, cobertura y referencias. `/api/admin/agent` ofrece el mismo estado. Los resultados shadow no aparecen en brief/outlooks públicos.

Los logs registran diagnósticos; el observador guarda telemetría en samples.jsonl y summary.json. Ninguno es una transcripción del razonamiento. El contenido de las publicaciones puede contener noticias o contexto privado: no compartir respuestas completas sin revisión. HTTP 200 y worker connected no prueban calidad ni progreso: revisar finalizaciones, rechazos, publicaciones nuevas, frescura determinista y crecimiento de recursos.

El corte inicial de las 11:16–11:34 UTC detectaba rutas operativas ausentes, cero publicaciones y UI heredada. Es histórico y queda en [live-shadow-review.md](live-shadow-review.md). Se corrigió durante esta implementación; **no aplicar las antiguas rutas de ensayo del catálogo/binario**. La configuración vigente es la indicada arriba.

## Resultado de la validación temporal

El backend de prueba sobre la base principal se cerró a las 13:08:33 UTC con cleanupErrors=0. Desaparecieron backend, broker, OpenCode, MCP y worker propios; llama.cpp continuó escuchando en 8080. No se deja otro backend iniciado por esta revisión. Comprobar de nuevo antes de arrancar, porque el operador puede haber iniciado otro posteriormente.

La base sigue en 017: no requiere SQL manual ni reiniciarla. Se conservan 501 fuentes configuradas/generadas, históricos y la ruta `/srv/bitcoin/ogid/db/ogid.sqlite`. Los totales al cierre y las pruebas están en [validation.md](validation.md). Mantener none/off para AI legacy y shadow para el agente. Los datos/contratos backend históricos se conservan aunque se retiró su interfaz antigua.

## Preparar un arranque

1. Conservar `.env`, credenciales y estado personal de OpenCode. Revisar `AGENT_MODE`, `AGENT_TASK_MODES`, `AGENT_BACKGROUND_MODEL`, manifest y switches `AGENT_BROKER_ENABLED`, `AGENT_OPENCODE_ENABLED`, `AGENT_WORKER_ENABLED` (`on`/`off`). Off global fuerza tareas off; shadow con un override visible permite visibilidad de esa tarea.
2. Confirmar la base correcta y espacio en el **destino** de backups. No ejecutar dos backend propietarios sobre la misma base. No borrar ownership de una base activa para forzar el arranque.
3. Ejecutar preflight de sólo lectura, con salida privada nueva:

```bash
node scripts/agent-preflight.js --output=../.agent-validation/preflight-operacion.json
```

El preflight no autoriza visibilidad. Consulta `/models` sin autoload y `/props` sólo para residentes; no carga/cambia modelos. Deben coincidir alias, contexto y slots. En esta auditoría: qwen3-coder, 65.536, un slot. La instalación personal observada es OpenCode 2.0.32; el runtime gestionado exige el binario 2.0.31 y SHA-256 `2df936a20cf74af5706020342164628f9a31978c50c2b0ad306b42b614fe245d`. No apuntar una versión distinta sin validar contratos y comportamiento. El binario operativo verificado está en `backend/data/agent-runtime/bin/opencode`, sin sustituir la instalación personal.

4. Arrancar con npm y observar estados. `spawnedAt/pid` sólo indican creación. Broker/OpenCode pasan por probes; worker necesita informe healthy después de verificar OpenCode/MCP y contactar backend. Consultar:

```bash
curl --fail http://127.0.0.1:3000/api/health/live
curl --fail http://127.0.0.1:3000/api/health/ready
curl --fail http://127.0.0.1:3000/api/agent/v1/capabilities
```

`ready` del backend y disponibilidad del analista son dimensiones distintas. La administración debe mostrar degraded/unavailable/stale cuando corresponda. No confundir puerto abierto con modelo operativo ni un worker conectado con calidad de sus publicaciones.

## Diagnóstico

- **RSS/cálculos:** comparar checkpoints y últimas adquisiciones/cálculos, no sólo HTTP 200. Revisar storage writer, analysis y queries, colas, comandos activos, lastExpiredCommand y recuperaciones. Un fallo del agente no justifica parar adquisición.
- **Broker:** cola serial y running. Presupuestos actuales: cola 30 min, cabeceras 90 s (incluye conexión y comprobación de contexto), inactividad upstream 90 s, total activo 30 min, backpressure 10 s. Timeout en cola no preempta al activo. Los 32 MiB limitan un chunk o buffering JSON no streaming, no los tokens ni la suma del stream.
- **Worker:** lease 90 s; heartbeat no solapado cada 20 s después de completar el anterior; deadline global 30 min. Perder lease aborta las llamadas del propietario; las mutaciones comprueban fence en SQLite. El cleanup intenta reconciliar interrupción durante un presupuesto independiente de 10 s. Una llamada HTTP abortada no implica que un cálculo síncrono ya iniciado en un worker de almacenamiento haya cesado.
- **Hijos:** eventos `agent_component_*` y `agent_child_diagnostic`. Diagnóstico guarda contadores stdout/stderr y códigos permitidos, sin contenido de inferencia. Logs siguen el logger existente; su retención/rotación depende del consumidor operativo. Si un puerto está ocupado, resolver al propietario; OGID no mata ni adopta ese proceso.
- **Chat/SSE:** reabrir/reconectar recupera mensajes durables por ID/cursor. No reenviar una consulta con una clave nueva tras perder respuesta: reutilizar la clave original o consultar su run. SSE no es el historial; los avisos terminales piden reconciliarlo. Una revocación cierra streams en su siguiente comprobación de acceso.
- **Rechazos del modelo:** conservar códigos de tarea/instrumento/cifra/cita y el snapshot. El chat puede efectuar una sola reparación compartida entre formato, citas y lectura obligatoria. Si falla, no publicar ni reintentar el prompt a ciegas.

## Backup y validación de una copia

No copiar un `.sqlite` aislado ignorando WAL. El script usa la API de backup SQLite con conexión original readonly, destino nuevo e integrity/foreign_key_check:

```bash
node scripts/agent-migration-check.js /ruta/origen.sqlite /ruta/nueva/candidate.sqlite /ruta/nueva/migracion.json
node scripts/agent-snapshot-check.js /ruta/nueva/candidate.sqlite /ruta/nueva/snapshot.json
```

El segundo comando **escribe únicamente la copia**: añade su job de validación, snapshot y ejecución incompleta. Conserva noticias/históricos; no importar esa copia como reemplazo del servicio por el mero hecho de pasar la prueba. La opción real `--as-of=ISO` permite medir una ventana histórica, pero usa reloj simulado y no reconstruye la disponibilidad pasada de todos los dominios. No sirve para certificar backtests.

Las migraciones aplicadas no se editan. Comprobar checksums antes de arrancar una revisión distinta. Si aparece schema ahead/mismatch, detener ese arranque y revisar compatibilidad; no eliminar registros de schema_migrations.

## Recuperación

1. Distinguir writer fallido, reader fallido, IA caída y job incierto. Readiness degradada no implica corrupción. No borrar históricos ni reinicializar base.
2. Para analysis/queries, permitir la recuperación existente; comprobar mismo writer, nuevo reader readonly y progreso posterior. Recuperaciones repetidas cuentan como incidentes, no como éxito del ensayo.
3. Para jobs running/waiting-model/validating tras caída, esperar expiración de lease y reconciliación. Buscar el messageId concreto, no sólo que exista una sesión. Las publicaciones tienen jobId único y propuesta consistente para replay. No reenviar prompts o publicaciones con identidades nuevas por pérdida de respuesta.
4. Cancelaciones remotas requieren ticket y reconocimiento antes de abrir la siguiente generación de esa conversación. Si OpenCode no confirma, conservar el estado incierto y diagnosticar su propia instancia.
5. Para cierre normal usar Ctrl+C en la terminal de `npm start`; esperar `server_stopped` y revisar cleanupErrors. Los grupos gestionados deben desaparecer. Nunca enviar señales a un puerto/proceso ajeno ni cerrar llama.cpp como parte de recuperar el analista.

## Observación shadow de 24 horas preparada

Con backend ya arrancado y todos los taskModes comprobados como shadow/off, desde la raíz y usando una carpeta que **no exista**:

```bash
node backend/scripts/agent-shadow-observe.js .agent-validation/shadow-24h-operacion-20261020 24
```

El observador lee la configuración local sin imprimir tokens, escribe JSONL/resumen privados y sale con informe interrupted si se corta. No inicia ni reinicia backend. Comprobar `completedObservation`, duración real y huecos; ninguna carpeta llamada 24h acredita esa duración. Examinar latencias, frescura, estado y antigüedad de jobs, publicaciones, heartbeats, recuperaciones, WS y memoria. Correlacionar con logs del mismo artefacto/configuración.

Los criterios fijados para el soak sintético de esta auditoría están en [validation.md](validation.md). No reutilizarlos como SLO universales para producción: fijar antes de un nuevo ensayo la baseline, corpus, carga y límites apropiados, incluyendo memoria de hijos y crecimiento WAL. No cambiar umbrales después para aprobar.

## Rollback compatible

La auditoría no introduce migraciones nuevas. Una revisión con los mismos checksums 001–017 puede abrir el esquema ensayado; `main` de referencia sólo llega a 009 y **no es un rollback de aplicación compatible sobre esta base**. No hacer downgrade borrando tablas o migraciones.

La contención operativa es desactivar analista mediante `.env` para el siguiente arranque normal y conservar almacenamiento/cálculos. Preparar primero copia consistente y comprobar revisión candidata sobre ella. Un cambio de revisión de un servicio existente necesita autorización operativa propia; esta auditoría no lo realiza. Una restauración de backup pierde escrituras posteriores: requiere procedimiento y ventana explícitos, no es una corrección rutinaria de la cola.
