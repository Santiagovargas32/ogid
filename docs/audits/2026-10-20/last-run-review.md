# Revisión de la ejecución de las 15:22–15:31 CEST

Revisión solicitada únicamente para diagnóstico. Código y datos del proyecto real, base `/srv/bitcoin/ogid/db/ogid.sqlite`, esquema 017. Sin cambios de código, .env, catálogo, trabajos ni base; sin arranques, reinicios, inferencia o carga de modelos. Sólo GET locales sin autoload, SQLite readonly/query_only, /proc, lectura de ficheros y documentación. Fecha 20/10/2026; todas las horas de esta nota son **CEST (UTC+2)**. El log conserva UTC.

Se leyó íntegramente `shadow-backend-20261020-152234.log`: 1627 líneas, 1623 registros JSON, 550,169 s entre primer y último registro. También las diez muestras y resumen de `shadow-24h-20261020-152249`. Análisis redactado por firmas, contextos y correlaciones en [last-run-log-analysis.json](last-run-log-analysis.json); métricas seleccionadas en [last-run-review.json](last-run-review.json). Los originales no se modifican.

## Por qué terminó

La causa primaria es un **timeout de ejecución de domain.registry en el escritor**, no el mensaje final shutdown_failed. Cronología del log:

| Hora CEST | Línea | Evidencia |
| --- | --- | --- |
| 15:22:35 | inicio | Primer registro; PID backend 103030 según observador. |
| 15:23:42 | 23 | server_started. |
| 15:31:13 | 1606, campo queuedAt | domain.registry encolado 13:31:13.064Z; al vencer constan 30000 ms ejecutando y 30010 ms totales. |
| 15:31:17 | 1584 | DELETE FROM event_instruments tarda 1284 ms en writer/thread 1. |
| 15:31:43 | 1606–1607 | storage_worker_failed STORAGE_OUTCOME_UNKNOWN / STORAGE_EXECUTION_TIMEOUT; shutdown_signal_received storage-worker-failed. No SIGINT/SIGTERM de usuario en este cierre. |
| 15:31:43 | 1610–1623 | Solicitudes pendientes fallan y dos escrituras de pipeline reciben STORAGE_NOT_READY al estar el escritor failed. Son efectos derivados. |
| 15:31:45 | 1626–1627 | server_stopped cleanupErrors=2; shutdown_failed STORAGE_NOT_READY. No equivale a cierre limpio. |

`backend/storage/businessRuntime.js:48–63`: registry registra instrumentos, compara el fingerprint del universo y, si cambia, borra **todo** event_instruments y recalcula los impactos leyendo todo events, dentro de una sola transacción immediate. El DELETE registrado confirma la entrada en esa rama; el bucle síncrono puede monopolizar el escritor y superar el watchdog. `StorageManager.expire/fail` termina al worker cuando una escritura iniciada queda incierta; server.run inicia cierre si el afectado es el writer. La última orden completada analysis.persist que aparece como telemetría no es la orden que venció.

Después de arrancar, el punto de llamada de producción es `marketController.updateWatchlist:253`; el otro punto de llamada está en el arranque ya finalizado. Por ello la actualización del registro desde watchlist es la atribución por flujo de código. Falta una entrada PUT completada y no se registran cuerpos para probar qué acción concreta del navegador la inició. No atribuir este bloqueo al modelo, SEC o al lector analysis. El fingerprint persistido sigue siendo el anterior; no se ha repetido la reconstrucción sobre la base para reproducir destructivamente el cierre.

Prioridad bloqueante: hacer esa actualización acotada/recuperable y evitar reconstrucciones idénticas sin perder vínculos, cobertura ni atomicidad observable. Aumentar el timeout o ignorar el fallo del writer no corrige el mecanismo. También revisar el cierre cuando el writer ya falló. No se ha implementado ese cambio en esta revisión de diagnóstico.

## OHLCV y Awareness

**OHLCV:** `frontend/js/api.js` aplica 12000 ms por defecto y traduce el aborto a «La petición excedió su tiempo de espera». El mensaje prueba que el navegador agotó su plazo, no que SQLite devolviera un error OHLCV. El log tiene dos GET /api/market/candles terminados en 200 a las 15:30:37 y 15:30:39, 254,81 y 169,42 ms. No hay una respuesta OHLCV de 12 s identificada. El logger sólo escribe al evento response.finish: una petición abortada puede faltar. Había competencia real y SQL lento, pero sin HAR/consola del navegador no se puede identificar la petición que expiró ni concluir que fue la reconstrucción posterior.

**Awareness:** el total 945 es quality.total, distinto de las listas recibidas/renderizadas. syncCompact (awareness.js:570) actualiza revisión, total, modo y fuentes sin cargar tarjetas. La lista llega por el snapshot dedicado o WS. Además, mergeAwarenessPayload (awarenessModel.js:240) rechaza un snapshot completo cuya revisión sea menor que la revisión compacta, aunque las listas locales sigan vacías. Reproducción con la función real: compacto visible rev8970/total945 → cero tarjetas; completo rev8969 con un evento → sigue vacío; completo rev8970 → aparece el evento. Es una reproducción con fixture, no captura del navegador del operador.

En el log sólo hay un GET /api/intel/awareness-snapshot completado: 15:30:17, 200, 231,95 ms. Encaja con que el contador aparezca antes que las tarjetas y se recuperen tras otra actualización; no prueba cuál de retraso, aborto o carrera de revisión ocurrió en esa pantalla. No se ha leído ni alterado localStorage del usuario. «Modo visible» corresponde a Awareness determinista; el agente seguía shadow, no es filtración de publicaciones experimentales.

## llama.cpp y el modelo del agente

El cambio a GPT está aplicado en **llama.cpp**: el preset gpt-oss-20b tiene load-on-startup=true; el modelo está residente, contexto 131072, un slot y n_predict=-1, build b10741-9d817213a. qwen3-coder está descargado. No se hizo inferencia, autoload ni cambio de modelo durante esta inspección.

La cronología descarta que ese nuevo proceso GPT explique la caída anterior: models.ini cambió a las 15:38:06, router llama.cpp inició a las 15:38:27 y el hijo GPT a las 15:38:28; .env se guardó a las 15:39:50, después del cierre de OGID a las 15:31:45.

Hay un desajuste **pendiente antes del siguiente arranque**:

- .env actual: AGENT_BACKGROUND_MODEL=llamacpp/gpt-oss-20b.
- backend/data/agent-runtime/models.json: sólo qwen3-coder validado y default Qwen.
- Selección durable agent-control en SQLite: backgroundModel=llamacpp/qwen3-coder, paused=false.
- Los cuatro runs de la ejecución fallida tienen model=llamacpp/qwen3-coder; tres failed y el último persiste running porque murió el escritor. Eso no es un proceso vivo. Publicaciones permanecen cinco, todas shadow.

server.js restaura el modelo guardado si sigue validado; por tanto cambiar sólo .env/llama **no demuestra que el agente vaya a usar GPT**. No marcar GPT ready copiando la prueba de Qwen: faltan validar su contrato de herramientas/stream/cancelación/salida y seleccionar el modelo de forma coherente mediante el control existente. Las ejecuciones previas deben mantener su identidad y pasar por reconciliación; no reescribir sus modelos ni borrar jobs.

## SEC y estado final

Estado persistido de 20 fuentes SEC: 16 healthy y cuatro submissions con SOURCE_TRANSPORT_ERROR (AAPL, Alphabet, NOC, Oracle), intentadas durante este arranque. Tienen éxitos anteriores. Esto explica una degradación parcial independiente; no hay evidencia aquí para afirmar 403/429, DNS o proxy. No se ejecutaron nuevas peticiones SEC ni se cambió backoff.

El observador quedó interrupted a los 540819 ms (~9,0 min), diez muestras, ninguna recuperación de lectores. RSS backend máximo muestreado 1093971968 bytes; WAL máximo 22437552. No es un ensayo de 24 horas ni acredita estabilidad. HTTP completadas 1539; cinco 5xx (5/1539), ligados al cierre, además de rechazos de validación del agente que no son caídas del backend.

A la inspección no había backend/broker/OpenCode/worker OGID activo; sólo llama.cpp nuevo. Se conserva todo el estado. **No iniciar todavía otra aceptación de 24 h como si este incidente estuviera resuelto**: están pendientes la reconstrucción del registro, hidratación de Awareness y alineación/validación de GPT. No se ha ejecutado integrity_check ni certificado recuperación de la base tras esta caída; las lecturas readonly y checksums de 17 migraciones sí fueron satisfactorios.
