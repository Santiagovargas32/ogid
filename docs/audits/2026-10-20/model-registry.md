# Catálogo de modelos, reconstrucción del registro y plazos

Continuación sobre `feat/agentic-intelligence`, HEAD del operador `55cd35f9f4ec32a8f5c61d28fd2a99fe16dc116a`, que incorporó el trabajo en curso. Se preservó ese commit y se completaron correcciones locales. Código en `/home/fedora/ogid`; base principal `/srv/bitcoin/ogid/db/ogid.sqlite`. Fechas de los JSON en UTC; las horas de esta nota, cuando se expresan como hora local, son CEST (UTC+2). No se ha publicado ni fusionado nada desde esta revisión.

## Reconstrucción durable y disponibilidad

La causa anterior queda en [last-run-review.md](last-run-review.md): `domain.registry` borraba y recalculaba todo el índice en una única transacción; agotó 30 s y terminó al escritor. Aumentar ese plazo mantendría el bloqueo y no garantiza completar un histórico creciente.

La migración nueva **018_event_index_generations.sql** añade un índice por generación, conservando las tablas e históricos previos. No se modifican migraciones 001–017. `eventIndex.js` prepara lotes de hasta 64 eventos, cediendo tras el evento actual al alcanzar un presupuesto orientativo de 250 ms y guarda cursor/progreso en la misma transacción de cada lote. Recorre por rowid físico en lugar de UUID, conserva el índice completo anterior y sólo cambia el puntero activo al finalizar. Nuevos eventos y revisiones escriben también la generación en construcción dentro de su transacción de negocio; no se pierden actualizaciones detrás del cursor. Una generación abandonada nunca se publica. El retiro de generaciones inactivas es paginado e indexado; no borra la activa, la que se construye, noticias o evidencias congeladas.

El StorageManager existente admite cada página en su escritor único, cede entre páginas y conserva el watchdog de escritura de 30 s. Reiniciar reanuda el cursor, sin repetir la reconstrucción completa si el fingerprint no cambia. Las listas de instrumentos/aliases se ordenan para que una permutación no provoque otro rebuild. No hay otro proceso escritor ni otra base del agente.

Se difiere la admisión del rebuild hasta terminar la hidratación inicial. Al cerrar se detiene su admisión y se drena la página aceptada. El panel muestra `Event index` con estado, procesados y duración de página; consultas de eventos incluyen la cobertura de la generación anterior y aviso mientras se reconstruye. No se presenta cobertura parcial como completa.

También se preserva un slot interactivo en el lector queries: admite hasta dos órdenes, con **un solo cálculo CPU**. Un cálculo asíncrono de noticias puede ceder al estado/mensajes/cancelación de lectura, sin admitir otro cálculo pesado paralelo. Los contratos siguen readonly/query_only; las transacciones síncronas no se intercalan con otro código JS. Esta corrección se motivó por un timeout real de administración y una captura de navegador que no logró hidratar a tiempo, conservados como fallos del ensayo anterior.

## Modelos: descubrimiento, carga y comprobación

El runtime descubre por `/models` los aliases y el contexto/slots configurados del router, sin cargar modelos al listar y sin copiar args, rutas, credenciales o presets privados al frontend. Genera el catálogo de OpenCode **2.0.31** con todos los modelos configurados y cruza `/api/model` autenticado con el broker. La interfaz separa disponible/seleccionable, residente y contrato verificado.

Seleccionar un modelo solicita su activación y devuelve **202**. Se espera en la cola serial del broker, se comprueba que otro modelo residente esté libre y se pide la carga una sola vez. Una respuesta perdida se reconcilia consultando inventario; no se reenvía ciegamente la mutación. No se cancela una inferencia válida para favorecer el cambio. Se valida contexto, ausencia de límite fijo de salida, llamada de herramienta con nonce, retorno estructurado JSON en streaming y liberación del slot tras abortar un stream. Los prompts de prueba son sintéticos; no se exportan cuerpos ni razonamiento.

Sólo después de una comprobación satisfactoria se guarda la selección mediante el escritor/control existente. Los pendientes se superseden/reencolan con IDs nuevos según el contrato actual; sesiones y runs ya congelados conservan su modelo. Si se pierde la confirmación de control se consulta la selección durable; una situación incierta se muestra como incierta. El catálogo verificado se conserva de forma atómica en el fichero operativo. El panel consulta el avance de la activación y permite reintentar un modelo fallido sin fingir que pasó la prueba.

Resultados de router reales: **7/9** superaron herramientas, JSON en streaming y cancelación: GPT OSS 20B, qwen3-coder, qwen36-agentic, qwen38-cyber-agentic, qwen38-mythos, qwen38-q5 y qwen38-uncensored. Los otros dos permanecen seleccionables, con el fallo indicado:

- `mistral-small-32`: no pudo reservar 5712 MiB de CUDA para KV con el preset actual. El hijo salió por fallo al crear contexto.
- `qwen38-q4-base`: el kernel mató procesos por OOM durante la carga. El supervisor ya existente reinició su unidad; OGID no ordenó ese reinicio. El primer ensayo quedó partial y no confirmó restauración. Después el router volvió con GPT por su preset; se probaron los dos modelos que quedaron sin ejecutar y se confirmó la restauración de GPT.

No se redujeron contextos, offload, ventanas, evidencia o salidas para aprobar. Los dos fallos necesitan capacidad/configuración de llama.cpp suficiente antes de considerarlos aptos. Ser seleccionable permite solicitar la prueba; no garantiza que el hardware pueda cargarlo. Repetir indiscriminadamente validate-all durante vigilancia puede volver a provocar OOM; listar modelos es una operación de lectura segura.

La selección real anterior persistía Qwen y podía prevalecer sobre .env. Se alineó por la API administrativa a **llamacpp/gpt-oss-20b**: ack 202, confirmación durable y GPT residente, nueve opciones seleccionables; 22 pendientes reencolados, sin reescribir runs activos. El ensayo de alineación apagó sólo su worker para no lanzar nuevos turnos Qwen. `.env` conserva sus tres switches on para el siguiente inicio normal.

## Entorno de medición

Fedora kernel 7.2.8-200.fc44.x86_64, AMD Ryzen 5 4500, 12 CPU lógicas, RAM 16.640.933.888 bytes. Datos en /dev/sdb1, /srv/bitcoin, 879 GiB disponibles en el corte; proyecto en /dev/sda3, unos 12 GiB libres. Node 22.23.3, SQLite 3.53.4 (better-sqlite3 13.0.3), OpenCode 2.0.31 fijado y llama build 10741 (9d817213a). No se cambiaron dependencias ni presets para conseguir resultados verdes. Hash del diff de código backend/frontend frente a 55cd35f: `bc472fd723cb385a9714e9075f5f0688490eb4245f878f6306b49aaca5274a92`.

## Presupuestos de tiempo

| Tipo | Política vigente | Motivo |
| --- | --- | --- |
| Escritura corta / página del índice | 30 s; cola 90 s | Eliminar el trabajo monolítico, no ocultar un writer colgado. |
| Lecturas de noticias, awareness, evidencia y cálculo común | 90 s por ejecución; cola separada | getFeed/getLiveFeed/search/getItem/getHistory/coverage habían quedado con el default de 30 s; ahora tienen perfil explícito como getProjection. |
| Advanced y mapa | 180 s | Perfil existente, sin ampliación global. |
| Configuración y snapshot | 300 s | Perfil existente de trabajo grande. |
| HTTP interno de mutaciones | 125 s | Cola 90 + ejecución 30 + margen 5; sin retry automático de publicación/prompts. |
| HTTP interno de evidencia | 185 s | Cola 90 + ejecución 90 + margen 5. |
| HTTP interno de snapshot | 395 s | Cola 90 + ejecución 300 + margen 5. |
| Heartbeat / lease | 30 s HTTP; heartbeat cada 20 s; lease 90 s | Renovación serial y acotada; no confundir lease con duración del job. |
| Frontend | default 12 s; lecturas almacenadas/noticias 185 s; análisis 275 s; watchlist 45 s | Presupuestos por operación; no extender todas las peticiones ni mantener un save esperando todo el índice. |
| Carga de modelo / probe | 360 s de carga; 180 s de prueba | Separados de headers/idle de inferencia; el timeout de carga cubre también reconciliación. |
| Broker de inferencia | headers e idle 90 s; total/cola 30 min | Conserva contexto del servidor y ausencia de cap fijo de salida; sin preempción. |

Los TTL de caché/frescura y las retenciones no se han ampliado para esconder retrasos. Un deadline sigue fallando cuando no hay progreso. La expiración de una mutación iniciada mantiene el resultado incierto y el fencing; no devuelve vacío/healthy falso.

## Pruebas y límites

Regresiones: generación parcial invisible, reanudación, doble escritura de revisiones, rollback de página, fingerprint estable, admisión tras readiness, slot de control durante cálculo, catálogo sin secretos, bloqueo de cambio si otro modelo está ocupado, carga sin retry tras pérdida de respuesta, selección durable conservada ante fallo y reconciliada si su confirmación se pierde, hidratación Awareness y perfiles internos. Una expectativa de caché detectó una orden de índice innecesaria en almacenamiento sin negocio: se corrigió la admisión y se mantuvo la prueba de que GET health/admin no genera SQL.

Awareness distingue metadatos compactos e hidratación; puede recuperar las primeras tarjetas de una respuesta completa anterior, marcándolas como revisión anterior, sin resucitar un estado completo más nuevo que ya esté vacío. El total global no equivale al número de tarjetas renderizadas.

Se conserva el arranque fallido `model-registry-primary-alignment-20261020.log`: getFeed agotó sus 30 s mientras otra validación competía por HDD. El siguiente arranque incorpora el perfil de lectura y el aplazamiento del índice. Se conservan también el primer timeout de admin y el navegador fallido, sin sustituirlos por un resultado verde. Las verificaciones finales y sus límites se incorporan al cierre en este informe y en el resumen estructurado.

Backup previo: SQLite Backup API, origen readonly, `before-018.sqlite` en `/srv/bitcoin/ogid/validation/20261020-model-registry/`, esquema 017, quick_check=ok y foreign_key_check vacío. La copia terminó a las 14:14 UTC; la verificación terminó a las 15:18 UTC bajo carga de disco. **No se ha ejecutado integrity_check completo en esta nueva copia**. Se conserva intacta; el ensayo 018 usa candidate-018.sqlite. No copiar la base activa ignorando WAL.

Mantener **shadow**. No se acredita estabilidad de 24 h ni calidad semántica de todas las respuestas. Las siete validaciones de router no equivalen a probar todas las tareas de OpenCode con cada modelo. El smoke completo de GPT y el ensayo representativo tienen sus resultados separados. No usar aplicaciones <=017 sobre esquema 018: rollback compatible requiere conservar esquema/datos y una revisión que lo soporte; restaurar la copia 017 perdería las escrituras posteriores y no se hace automáticamente.

## Cierre sobre el backend real

Arranque normal de la última corrección: `npm start`, sin overrides de switches, base principal 018 y GPT. Log íntegro local `model-registry-primary-final-20261020.log`: 541 líneas, 537 JSON, 17:28:31.848–17:35:29.541 UTC (6 min 57,693 s). Readiness llegó a las 17:29:37.739 UTC; no interpretar el 503 inicial como caída sostenida. Los lectores analysis y queries confirmaron readonly/query_only. La observación solicitada fue **0,1 h**, siete muestras y 360.017 ms: una muestra inicial sin disponibilidad/modo conocido y otra con worker aún stale; las cinco restantes con worker connected. Cero recuperaciones de analysis/queries; no hubo timeout de storage ni error del logger. Se conservan siete slow_sql: hidratación fría hasta 10.676 ms y escritura pipeline de 2.421 ms, entre otros. Dos avisos Awareness al cerrar indican abortos por shutdown, no fallos previos de proveedor.

El escritor mantuvo state=ready, failed=0, rejected=0 y 1329 órdenes completadas en el corte. Dos snapshots internos terminaron HTTP 200 (máximo 40.468 ms); 13 heartbeats HTTP 200 (máximo 15.619 ms). Esto respalda separar el presupuesto snapshot del heartbeat y de las mutaciones cortas; no acredita latencia constante. El índice principal reanudó la generación `5119ee54-3e35-4161-879a-28be95366887`; 56.420 eventos recorridos en la lectura durable al cierre, todavía building. El catálogo RSS conserva **501** fuentes y se completó un ciclo news real de 121.160 ms, con proveedor RSS y consultas NewsAPI/GNews. Conteos sucesivos (no snapshot atómico): 108.689 artículos, 225.797 revisiones, 112.859 eventos, 37.105 velas y 13.810 analysis_runs.

HTTP/WS tras la corrección del lector (`model-registry-http-ws-final2-20261020.json`, 31,242 s):

| Endpoint | Intentos / 200 / errores | p50 / p95 / p99, ms |
| --- | --- | --- |
| ready | 6 / 6 / 0 | 3 / 40 / 40 |
| admin/agent | 6 / 6 / 0 | 8 / 83 / 83 |
| intel/news | 5 / 5 / 0 | 1822 / 1976 / 1976 |

Diez WS abiertos; cero cierres inesperados, errores o heartbeat timeouts; un cliente pausó lecturas cinco segundos. Los diez cierres 1005 del servidor corresponden al cierre solicitado por la sonda, con closeFrameReceived y anomalous=false. Muestra demasiado pequeña para SLO o percentiles de carga prolongada. La prueba previa conservada tuvo un timeout de admin; la nueva usa el mismo deadline de sonda de 12 s, sin ampliarlo para aprobar.

Chromium contra `/admin` real pasó (`model-registry-real-admin-final2-20261020/result.json`): **9/9 opciones habilitadas, GPT seleccionado**, sin consultas a AI enrichments, pageerrors o HTML ejecutable del modelo. No acredita LAN/proxy.

El smoke GPT/OpenCode real pasó (`terminal-real-R62eao/result.json`, 17:18:09–17:20:10 UTC): brief validado/persistido shadow y oculto públicamente, MCP autenticado, chat device/CSRF, respuesta citada durable y SSE, cancelación y cierre propio. Es un corpus aislado con inferencia real; no confundirlo con una nueva publicación sobre el corpus principal. En el arranque principal no hubo publicación nueva: quedó un turno GPT en curso; un run Qwen previo terminó con `AGENT_OPENCODE_TURN_FAILED`, confirmado en OpenCode como error **aborted/interrupted**. No prueba una incompatibilidad GPT. Se conserva su diagnóstico redactado y no se reescribió su identidad.

Recursos: backend hasta 1.187.258.368 bytes RSS y WAL hasta 4.532.032 bytes en las muestras. Una muestra de heartbeat del escritor llegó a 22.194 ms. No hubo expiración ni recuperación; el retraso y la memoria necesitan ensayo más largo y no equivalen a estabilidad. El ensayo breve no permite determinar fuga, techo de memoria o frescura de todas las fuentes.

Se envió SIGTERM sólo a nuestro PID 132950 a las 17:35:05 UTC. Cerró a las **17:35:29.541 UTC, cleanupErrors=0**; desaparecieron backend, broker, launcher/binario OpenCode, MCP y worker. Puertos 3000/4096/4097 cerrados; llama.cpp en 8080 conservado y GPT OSS 20B residente confirmado. El observador terminó; la copia aislada tiene su comprobación separada.

## Comandos ejecutados de esta continuación

Desde `/home/fedora/ogid/backend`, salvo indicación:

```bash
npm test
npm run build
npm audit --omit=dev --audit-level=high
node --test tests/eventIndex.test.js tests/modelCatalog.test.js
OGID_PLAYWRIGHT_MODULE=/home/fedora/.npm/_npx/d537ee5ee2a13f03/node_modules/playwright/index.mjs node scripts/agent-admin-browser.js http://127.0.0.1:3000 ../.agent-validation/model-registry-real-admin-final2-20261020
node scripts/agent-shadow-observe.js ../.agent-validation/model-registry-observe-final-20261020 0.1
node scripts/agent-registry-check.js /srv/bitcoin/ogid/validation/20261020-model-registry/candidate-018.sqlite ../.agent-validation/model-registry-representative-adaptive-20261020.json
```

Preflight final de sólo lectura: 18 migraciones sin discrepancia de checksum, OpenCode 2.0.31 y GPT residente con contexto 131.072, un slot, n_predict=-1; backend no disponible es esperado después de cerrar el ensayo. El preflight no acredita por sí solo inferencia ni promoción.

Suite final backend: **910/910**, 85.105 ms, sin skips; build/check correctos, audit producción cero vulnerabilidades. Adaptador MCP: **29/29**, check e inventory correctos (81 rutas/90 operaciones). Las pruebas de localhost/nativo se repitieron en host tras restricciones del sandbox; los fallos de entorno se conservan separados. Un intento intermedio de usar iterate()+escrituras en la misma conexión falló por conexión ocupada: se corrigió a get() por fila antes de escribir y la regresión pasó; no se desactivó la prueba. No hubo actualización de dependencias; npm ci y la baseline anterior constan en validation.md.

Smoke/modelos, desde backend:

```bash
node scripts/agent-terminal-smoke.js --resident-model
node scripts/agent-model-catalog.js --validate-all --write-catalog --output=../.agent-validation/model-catalog-all-20261020.json
node scripts/agent-model-catalog.js --validate-model=qwen38-q5 --validate-model=qwen38-uncensored --write-catalog --output=../.agent-validation/model-catalog-remaining-20261020.json
```

El smoke requiere el flag --resident-model y el modelo ya residente/verificado; sin ese flag rechaza la ejecución y no acredita inferencia real. No repetir la carga de todos los modelos como preflight: sus fallos OOM se documentaron arriba. No se fijan nuevos SLO retrospectivos para declarar aprobado el ensayo.

## Pendientes para promoción

- **Bloqueantes de promoción a visible:** vigilancia representativa de 24 h con el artefacto final, progreso y publicaciones nuevas del corpus real; evaluar calidad de respuestas por tarea/instrumento y recuperación en carga sostenida. La revisión general profunda pendiente de proveedores/coordinadores sigue en audit.md; esta continuación no se presenta como auditoría semántica de todo el repositorio.
- **Importantes:** resolver capacidad/presets de los dos modelos que fallan memoria antes de calificarlos como aptos; investigar memoria, heartbeat y SQL frío observados; finalizar el índice principal en el siguiente arranque y comprobar cobertura/frescura, sin forzar reemplazos manuales. La falta de publicación nueva en el corte principal no queda resuelta por el smoke aislado.
- **Posteriores:** afinar estimación de avance/tiempo restante y medir fairness entre selección de modelo, chat y fondo durante inferencias largas. La cola es serial y respeta el trabajo ya admitido, sin preempción; prioridad pendiente no garantiza latencia inmediata.

No se toca producción fuera del arranque temporal autorizado. El operador puede iniciar ahora su vigilancia con npm start y una carpeta nueva del observador, siguiendo runbook.md. No hace falta modificar manualmente SQLite ni reactivar AI legacy.

## Resultado del histórico aislado y reanudación

`model-registry-representative-adaptive-20261020.json`: **passed**, 17:35:43.784–17:42:27.330 UTC (6 min 43,546 s). Reanudó en cursor **24.080**, misma generación `a2678227-6e77-4fdd-8ad7-a3ab9b15098f`, tras dos interrupciones deliberadas anteriores de nuestros drivers. Esta última pasada recorrió otros **88.211** eventos y selló un total de **112.291/112.291**. Publicó el puntero activo sólo al terminar. Los 1.399 eventos con impacto para los instrumentos actuales no son un recorte de los restantes: todos se recorrieron y se preservan reglas de identidad/impacto e históricos. Las regresiones verifican también revisiones/nuevos eventos detrás del cursor y generación parcial invisible.

1383 páginas medidas: ejecución p50 **192 ms**, p95 **425 ms**, p99 **771 ms**, máximo **975 ms**. Cola p95 115 ms, máximo 1158 ms. El presupuesto de 250 ms cede al terminar un evento; no promete que disco/commit siempre terminen en 250 ms. Se mantuvo el watchdog de 30 s. Con comandos pipeline-stage concurrentes, 399 muestras tuvieron failed=0 y estado ready; heartbeat máximo **6285 ms**, RSS máximo **591.167.488 bytes**. FK sobre event_index_links vacío, sameGenerationResumed=true y closedState=closed. No fue adquisición de red en esta copia ni ensayo continuo de 30 min; el tiempo desde el primer begin incluye pausas y otros arranques.

La base principal no fue modificada por este driver. Tras cerrar el backend real, ownership vacío; el turno GPT quedó incomplete/ABORT_ERR con interruptAcknowledged=true para recuperación segura. Cinco publicaciones históricas, cero job IDs publicados por duplicado y cero publicaciones enlazadas a snapshots sin manifest.sealed. Ese corte sin publicación nueva no demuestra por sí solo idempotencia en todos los fallos de publicación.

Resumen estructurado y referencias: [model-registry-results.json](model-registry-results.json). Se conserva la copia previa 017 intacta. Las validaciones y sus procesos propios han terminado; no se deja un backend u observador ejecutándose.
