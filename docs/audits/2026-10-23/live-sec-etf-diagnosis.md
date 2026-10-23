# Diagnóstico del arranque del 23/10: SEC, ETF y cierre durante la inspección

Rama: `feat/agentic-intelligence`. Horas en Europe/Madrid (CEST, UTC+2).
Alcance autorizado: observar, diagnosticar y guardar soluciones para después;
sin parches, cambios de configuración, adquisiciones forzadas ni reinicios.
Los documentos del plan se utilizan como referencia de arquitectura y aceptación,
no como autorización para implementar durante esta inspección.

## Resultado principal y efecto de la inspección

**El backend cerró automáticamente durante esta revisión. La consulta de diagnóstico
`GET /api/admin/history`, realizada por el asistente, desencadenó el fallo.**
No se envió ninguna señal de parada ni se invocó una operación administrativa de
escritura, pero esa lectura ejecutó trabajo síncrono no acotado en el escritor.
La petición se eligió para conocer el estado de los históricos; inspeccionar su
implementación completa antes de consultarla habría permitido evitar el disparador.

El cierre no se atribuye a SEC ni a la publicación rechazada de ASML. La guardia de
ejecución del escritor venció a las **18:34:15.609** con
`STORAGE_OUTCOME_UNKNOWN / STORAGE_EXECUTION_TIMEOUT`. El proceso registró
`server_stopped` a las **18:34:16.882**, seguido de `shutdown_failed` secundario.
No se ha reiniciado ningún componente ni reanudado el observador.

Antes de ese cierre se comprobó lo siguiente:

- SEC procesaba fuentes y recuperaba algunas; no había una única fuente detenida
  bloqueando todo el ciclo. Persistían varios timeouts por fuente.
- Los cinco ETF tenían precios observados y velas diarias recientes. Faltaba
  recuperar sus velas intradía después de arrancar fuera de la sesión europea.
- EUNL y EQQQ tenían además huecos diarios que anulaban los indicadores técnicos.
- ASML falló porque el modelo cambió **un carácter** de un ID de evidencia en la
  única reparación. El rechazo estricto fue correcto.
- Se detectó un problema semántico adicional: EQQQ publicó «fuerza relativa de 21»
  citando el número de muestras requerido por el indicador, cuyo valor real era null.

## Evidencia y método

- Log original: `.agent-validation/shadow-backend-20261023-180853.log`.
- Observador original: `.agent-validation/shadow-24h-20261023-180919/`.
- Capturas privadas y reproducción offline:
  `.agent-validation/live-diagnosis-20261023/`.
- Backend observado: PID `110819`, inicio `18:08:53.688`, commit de checkout al
  arrancar `0fc9da2a5525678a660b5ab9939f2a2f4fed320d`, árbol modificado.
  Identidad de artefacto:
  `79b040caf951e684251cddda0c8a928fda9b6a373b85328574f3c84f2d3502ec`.
- A las 18:32:25: readiness 200, almacenamiento ready, lectores readonly/query_only,
  cero recuperaciones de lectores y ninguna reconciliación pendiente. La salud
  general era degraded. Esto no acredita estabilidad sostenida.
- El backend había aplicado **019** a la base operativa en este arranque. La base
  era `/srv/bitcoin/ogid/db/ogid.sqlite`; el montaje comprobado después era ext4 rw.
  La limitación de solo lectura descrita en el informe de implementación anterior
  ya no describía este arranque.
- El conector OGID no tenía túnel disponible; se usaron GET locales, concurrencia
  máxima dos y requestId de diagnóstico. No se hicieron peticiones externas a
  SEC/Yahoo ni se forzaron cálculos o ingestas mediante POST.
- La consulta de SQLite comenzó **18:34:31**, después del cierre. Usó `mode=ro`,
  `query_only`, WAL normal y consultas con presupuesto; nunca `immutable=1`.
  La búsqueda global de un ID se interrumpió por su presupuesto de ocho segundos;
  no se usa como evidencia de ausencia. La comparación definitiva utiliza las
  filas del snapshot exacto.
- `initial.json` conserva la muestra viva de las 18:32:25–26;
  `sources-followup.json`, la de las 18:33:42;
  `monitoring-2.json`, los rechazos de conexión de las 18:35:36;
  `db-initial.json` y `postmortem.json`, las lecturas posteriores al cierre;
  `failure-extract.json`, la cadena de cierre;
  `offline-checks.json`, las comprobaciones sin red ni backend.

## 1. SEC: degradación real con progreso parcial

### Lo observado

Las veinte fuentes dedicadas estaban habilitadas. A las **18:32:26**:
**9 healthy y 11 error / SOURCE_TIMEOUT**. Las once eran:

| Fuente | Último intento | Próxima elegibilidad guardada |
|---|---|---|
| MSFT submissions | 18:27:08 | 18:32:09 |
| NVDA companyfacts | 18:30:12 | 18:35:19 |
| Alphabet submissions | 18:27:06 | 18:32:07 |
| ASML companyfacts | 18:27:05 | 18:32:06 |
| AMD submissions | 18:28:00 | 18:33:01 |
| ORCL submissions | 18:31:07 | 18:36:08 |
| ORCL companyfacts | 18:30:19 | 18:35:20 |
| LMT submissions | 18:28:01 | 18:33:02 |
| NOC companyfacts | 18:30:05 | 18:35:07 |
| GD submissions | 18:31:04 | 18:36:07 |
| GD companyfacts | 18:30:07 | 18:35:12 |

El siguiente ciclo recuperó **MSFT submissions a las 18:33:13.579** y
**AMD submissions a las 18:33:15.533**, por la ejecución programada existente.
A las 18:33:42 había **11 healthy y 9 error**; ASML companyfacts y Alphabet
submissions habían vuelto a fallar y tenían nuevos plazos de backoff.
El agente seguía activo, con tick de 60 s y hasta cuatro fuentes por ciclo.

`research.sec` permanece degraded mientras alguna fuente seleccionada conserva
un fallo. Es coherente con esos datos: el éxito de MSFT no recupera ORCL.
No se observaron HTTP_403, HTTP_429 ni SEC_USER_AGENT_REQUIRED en estas fuentes.
La rama de cooldown global para 403/429 existe, pero no explica esta incidencia.

### Causa conocida y límite de evidencia

`OfficialSourceService` usa fetch con presupuesto de 15 s, lectura de cuerpo
acotada y conservación de datos previos. Guarda un único `failureCode` y un
backoff fijo de cinco minutos para fallos distintos de 403/429.

`SOURCE_TIMEOUT` identifica una **familia**: puede corresponder al aborto del
presupuesto propio o a un código de transporte como `UND_ERR_CONNECT_TIMEOUT`.
La reproducción offline confirma ambas traducciones. El estado actual no guarda
fase de conexión/cabeceras/cuerpo, duración ni cadena causal saneada. Por ello no
se puede determinar qué salto de red o fase falló, ni atribuirlo a cuota, TLS,
DNS, bloqueo de SEC o avería del disco. El trabajo síncrono del escritor también
puede retrasar callbacks, pero no se ha demostrado que causara estos timeouts.

### Solución posterior propuesta

1. Conservar la clasificación pública y añadir, por intento y fuente, identificador,
   inicio/fin, duración monotónica, fase, bytes, status HTTP, código causal saneado
   y origen del timeout. Guardar por separado último fallo y último éxito.
2. Mantener single-flight, límites, identifying User-Agent y Retry-After. Usar
   backoff exponencial acotado con jitter por fuente, con justicia entre fuentes
   elegibles; un ciclo sin fuentes elegibles no acredita recuperación.
3. Mostrar la próxima elegibilidad mínima y las fuentes pendientes en SEC. El
   `nextEligibleAt:null` agregado actual no explica la espera de las fuentes.
4. Sacar adquisición y parseo pesado del hilo escritor: aprovechar el flujo de
   adquisición/RPC existente y persistir resultados validados en unidades acotadas.
   Conservar un solo escritor y el commit de estado/hechos consistente.
5. No añadir fuentes SEC a ETF por heurística. ASML.AS, SPCX y CRWV aparecían sin
   mapeo SEC; verificar identidad legal/CIK antes de ampliar el catálogo. La
   posible asociación de ASML.AS al emisor de ASML exige un vínculo verificado.

Pruebas futuras: timeout de conexión y cuerpo separados, cancelación, JSON inválido,
403/429 con Retry-After, fuente sana junto a fuente fallida, recuperación por la
misma fuente, ciclo sin elegibles y commit tardío sin pérdida de hechos previos.

## 2. ETF: faltan velas intradía, no todos los datos

### Cobertura contrastada

Los cinco ETF están seleccionados y incluidos en los 19 instrumentos hot. Los
precios Yahoo observados del 23/10 estaban disponibles y no marcados stale.
Las velas diarias de todos ellos llegaban al **23/10 17:30** y habían sido
adquiridas a las 18:14. La cobertura intradía seguía en el 22/10:

| Instrumento | Velas diarias guardadas | Velas 5 min guardadas | Último cierre local 5 min |
|---|---:|---:|---|
| VWCE.DE | 607 | 1.947 | 22/10 11:55:00 |
| VUAA.DE | 460 | 1.809 | 22/10 11:51:09 |
| SXR8.DE | 607 | 1.940 | 22/10 11:55:45 |
| EUNL.DE | 607 | 1.950 | 22/10 11:55:16 |
| EQQQ.MI | 601 | 1.059 | 22/10 11:52:41 |

ASML.AS presentaba el mismo retraso europeo. Esto descarta una exclusión general
por `assetType=etf`. SEC aporta hechos corporativos y no suministra estas velas.

### Cadena causal confirmada

`IntradayCandleService.#run()` filtra por sesión abierta **antes** de consultar
la cobertura persistida y preparar bootstrap/incremental. El backend arrancó a
las 18:08, después de las 17:30 europeas. Los ETF y ASML.AS quedaron en
`session_closed`, sin ningún intento intradía durante este arranque. El código
no distingue adquisición en directo de recuperación de sesiones ya cerradas.

La reproducción offline con la identidad real de EUNL y el reloj de las 18:24
devuelve `market-closed`, **cero lecturas del store y cero llamadas al proveedor**.
También reproduce `localCandleCount:0 / lastClosedCandleAt:null` en las métricas,
aunque SQLite tenga 1.950 velas: son valores iniciales sin hidratar, no ausencia
demostrada de historia local.

Conditions utiliza la serie base 5 min y sus rollups cerrados, no reemplaza esa
serie con precios o velas diarias. Por eso la ventana tiene 0 de las 2 velas
cerradas mínimas y prevalece `stale_local_data` sobre `market_closed`. Las dos
velas son un mínimo de disponibilidad de esa ventana; no bastan para todos los
indicadores ni para emitir una dirección del agente.

La próxima apertura mostrada, 26/10 a las 09:00, corresponde al calendario
configurado, incluido el cambio horario. No se ha contrastado aquí con un
calendario oficial completo de excepciones.

### Segundo bloqueo: huecos diarios

El snapshot congelado de EUNL tiene 500 velas diarias, cierre del 23/10 y
`stale:false`, pero detecta huecos en **24/10/2025 y 06/03/2026**. EQQQ detecta
además 26/11/2024, 11/12/2024, 29/07/2025 y 02/09/2025. El calendario figura
parcial. Son huecos según el calendario del motor; no se ha demostrado aquí
si cada fecha tuvo negociación y datos disponibles en origen.

`calculateTechnicalIndicators()` invalida todos los indicadores si detecta un
hueco en la serie suministrada. `TechnicalContextService` conserva esa protección.
El job histórico puede estar completed porque terminó sus ventanas, y su
`goalMet` comprueba cantidad de barras, sin exigir continuidad. Además, la
actualización diaria pide dos barras y deja de pedir cuando existe el cierre
esperado: no repara estos huecos antiguos.

La publicación shadow de EUNL de las **18:24:08.526** es una abstención durable
del job `6e9fd7ee-45df-4891-ab2a-9e4ec665f29d`, con snapshot sellado
`2af33cfc-1aca-492d-9935-def56f56f08f`. El agente sí procesó el ETF; no contó
con indicadores elegibles para afirmar una dirección.

### Solución posterior propuesta

1. Separar elegibilidad de sesión en vivo y recuperación histórica. Permitir un
   catch-up acotado de sesiones ya cerradas, también al arrancar después del
   cierre, con watermark durable, solape idempotente y límites del proveedor.
   Reutilizar scheduler, cola Yahoo, justicia y cancelación actuales.
2. Hidratar la cobertura local de todos los seleccionados antes de asignar estado;
   expresar sesión, deuda de adquisición y calidad como propiedades separadas.
3. Detectar sesiones/barra cerrada faltantes y reparar mediante los trabajos
   históricos existentes. Contrastar primero calendario, procedencia y respuesta
   original. No interpolar, inventar velas o borrar historia para obtener continuidad.
4. Separar finalización del job, cantidad objetivo y continuidad/eligibilidad del
   resultado. Definir después validez por ventana de dependencia de cada indicador;
   los recursivos requieren semilla y tramo continuo válidos. No quitar la guardia
   global sin sustituirla por garantías equivalentes y pruebas de reproducibilidad.
5. Unificar el acceso técnico a rollups 15 min/1 h derivados de 5 min con la
   arquitectura ya usada por Conditions. Hoy `TechnicalContextService.get()`
   consulta directamente ese intervalo: EUNL tenía 0 velas 15 min/1 h y EQQQ
   consultaba 1 h antigua del 14/10, aunque exista historia base 5 min.
6. Auditar timestamps fuera de la rejilla: la última barra EUNL guardada abre a
   las 11:50:16 y EQQQ a las 11:47:41. Son filas persistidas, no intervalos
   regulares completos acreditados. Conservar su procedencia y revisar la cola
   parcial de Yahoo antes de admitirla como barra cerrada; no redondearla a ciegas.

Pruebas futuras: arranque después del cierre y en fin de semana, cambio horario,
sesiones EU/US mezcladas, recuperación única e idempotente, huecos reales frente
a cierres oficiales, colas parciales, rollups reproducibles y frescura por sesión.

## 3. ASML: formato inválido y reparación con ID alterado

Operación exacta: job `51018584-4e5b-42b4-8afa-77c79b6ef9cf`, fence 1,
task `instrument_outlook`, ámbito ASML, snapshot
`b7c77494-60cc-4a10-9044-cbed0d14b82e`.

- Primera propuesta: `AGENT_INVALID_JSON`.
- Única reparación: `AGENT_UNKNOWN_EVIDENCE / not-in-snapshot`.
- ID presente: `analysis-57c2ae8822e3dbba6f814d7c636bd937ce6a0114`.
- ID enviado: `analysis-57c2ae8822e3dbba6f814d7c636bd937ce8a0114`.
- Difieren en un carácter, `6` → `8`. El lookup exacto debe rechazarlo.
- Rechazo HTTP a las 18:19:24.551; run failed a las 18:19:25.167.
  No hubo publicación durable de ese job. EUNL/EQQQ son otras operaciones y
  no constituyen recuperación de ASML.

Solución posterior: conservar parseo completo, una reparación compartida y
lookup exacto. Incluir IDs canónicos acotados en el contexto de reparación,
vinculados al mismo snapshot, o referencias de selección resueltas
determinísticamente contra el catálogo congelado mediante contrato versionado.
No aplicar coincidencia aproximada a IDs ni fabricar una segunda reparación.
Mantener OpenCode 2.0.31 y la declaración textual/grammar-not-applied.

Añadir fixture con este ID alterado después de un JSON inicial inválido: dos
propuestas inválidas, cero publicaciones. Una referencia exacta y elegible
debe seguir publicando una sola vez.

## 4. Hallazgo semántico en EQQQ

La publicación shadow de las 18:28:30.656 dice «fuerza relativa de 21» y cita
`warmup.relativeStrength = 21`. **21 es el requisito de muestras**, no la
medición. `indicators.relativeStrength.value` es null por `gaps_detected`.
EUNL también incluyó `warmup.sma200` y `warmup.rsi14` en technicalFacts, aunque
su resumen no los presentó como indicadores medidos.

La reproducción offline confirma que el catálogo numérico anuncia esa ruta y
el comprobador numérico la admite porque el número coincide exactamente. Se
cumple identidad numérica, pero falta tipado de su significado.

Solución posterior: separar observaciones/indicadores de parámetros/requisitos
en el catálogo, con rol, unidad y elegibilidad. Los technicalFacts destinados a
afirmaciones de mercado deben aceptar solo observaciones y valores elegibles;
los parámetros deben tener un contrato y redacción propios. Añadir fixtures que
rechacen usar `warmup.*`, sampleSize o periodos como medición y conserven la
abstención con observaciones válidas. Mantener la promoción visible bloqueada.

## 5. P0: una lectura administrativa derriba el escritor

### Secuencia correlacionada

| Hora | Evidencia |
|---|---|
| 18:33:42.067 | Se encola admin.history, requestId `readonly-diagnosis-sources-followup`. |
| 18:33:45.607 | Comienza a ejecutar en el escritor, como calculation, no pureRead. |
| 18:33:54 aprox. | El cliente de diagnóstico agota su timeout de 12 s; el trabajo sigue. |
| 18:34:01.931 | Log SQL: `SELECT entity_id FROM research_rows WHERE collection=?`, 16.324 ms, thread 1 readOnly=false. |
| 18:34:15.609 | Expiran 30 s de ejecución; fallo del escritor y cierre automático. |
| 18:34:16.882 | `server_stopped`. |
| 18:34:27.205 | Observador confirma conexiones rechazadas. |
| 18:35:36 | Segunda consulta de monitorización confirma el rechazo. |

`BusinessRuntime.adminHistory()` empieza con
`Object.values(store.state.events)`. `SqlResearchStore` enumera toda la colección
y vuelve a leer/deserializar payloads por clave en ownKeys, descriptor y get.
La telemetría previa contabilizaba aproximadamente 136.822 eventos. Se
materializa el corpus antes de limitar la lista visible a cien casos legacy.
El cálculo de cobertura histórica añade consultas por instrumento y job.

La operación no está en el enrutamiento de lectores de `StorageManager`, ni en
`isPureRead()`. Una consulta HTTP GET queda clasificada como cálculo del escritor;
el timeout se trata como resultado durable incierto y termina el worker. La
guardia actuó según su contrato; faltaba aislar y acotar esta lectura. La mejora
del heartbeat no puede interrumpir una sentencia SQLite síncrona ni esa enumeración.

La causa primaria identificada es esa llamada admin.history. Los posteriores
503 de heartbeat, claim y persistencia son consecuencias. En la evidencia de
cierre quedan RSS con progreso confirmado 260/919, admin.history y un heartbeat
despachado sin confirmar. No se interpreta esto como pérdida de todas las filas
ni se han repetido comandos para averiguar su resultado.

### Solución posterior prioritaria

1. Sustituir la enumeración de objetos por SQL sobre proyecciones/tablas existentes:
   conteos por identity_version y página limitada de legacy; usar el índice
   `events_by_identity`. Si el conteo agregado aún es costoso, mantener una
   proyección durable/contadores consistentes con el commit.
2. Enrutar admin.history a `queries` readonly/query_only y registrarlo como lectura
   pura mediante un contrato compartido de operación, sin writebacks implícitos.
   Revisar otras lecturas administrativas y de sources/history por el mismo patrón.
3. Proyectar cobertura, jobs y datasets con revisiones y páginas acotadas, con
   caché/ETag previo al trabajo caro. Reutilizar la proyección administrativa
   prevista en el plan, no añadir otro scheduler.
4. Preservar cancelación de consumidores y presupuestos. La expiración de un
   lector debe aislar/reconstruir ese lector, sin declarar incierta una mutación
   inexistente. Las escrituras realmente aceptadas mantienen reconciliación y
   cierre seguro si no llega ACK.
5. Mantener aviso 5 s y guardia 30 s. No resolver el problema subiendo timeouts.
   Asegurar cleanup idempotente aun con almacenamiento failed, conservando causa
   inicial y comandos sin confirmar.

Prueba de regresión necesaria sobre copia consistente de tamaño representativo:
consultar históricos con adquisición y heartbeats concurrentes, cancelar un
consumidor y verificar escritor disponible, cero materialización completa,
presupuesto de respuesta, lector recuperable y cero efectos de escritura.
**No repetir este endpoint en la base viva antes de corregirlo.**

## 6. Advanced: queued/fallback no demuestra bloqueo por SEC

El coordinador avanzado conserva un resultado durable y admite refrescos por
revisión/TTL. `queued` describe el trabajo de cálculo, no una cola de SEC.
Los resultados guardados capturados continuaron generándose a las **18:29:09**
y **18:33:08** para dos scopes. No había jobs advanced activos en la consulta
posterior al cierre. Los filtros exactos de la captura del usuario no quedaron
fijados: no se afirma que ambos scopes sean esa misma vista.

`sqlite · fallback (selected-news-pipeline)` procede de
`snapshot.meta.dataQuality.news.mode`; el servicio avanzado usa fallback si ese
metadato falta. No significa fallback de disco ni constituye un diagnóstico SEC.
En las representaciones capturadas también aparecen live y stale por scope.
La salud pipeline y la calidad/frescura del contenido deben conservarse separadas.

Solución posterior: mostrar jobId, scope, revisión, fase y tiempo de espera del
refresco, y la causa de calidad del corpus. Calcular la calidad del resultado con
la procedencia congelada adecuada; no heredar un fallback ambiguo de contexto
incompleto. No cambiar los contadores del corpus para ocultar esta diferencia.

## 7. Orden de implementación y aceptación pendiente

| Prioridad | Cambio futuro | Encaje en el plan |
|---|---|---|
| P0 | Acotar/proyectar admin.history y aislarlo del escritor; cleanup | Almacenamiento; C/D/H; evaluación 10.5/10.7/10.9 |
| P1 | Catch-up fuera de sesión, cobertura hidratada y rollups técnicos | Datos congelados, disponibilidad y diagnóstico C/H |
| P1 | Reparar huecos con calendario verificado y cobertura durable | Adquisición existente; preservar historia y calidad |
| P1 | Rol semántico de rutas numéricas; warmup no es medición | A, contratos y revisión semántica |
| P2 | Contexto canónico de IDs en la reparación única | A, fixtures ASML |
| P2 | Intentos SEC con causa/fase/backoff y cobertura por fuente | C/H |
| P2 | Explicar refresh/quality avanzado por scope y revisión | D/H |

No se aplicó ninguno de estos cambios. Las únicas escrituras de esta revisión
son documentos, capturas privadas y scripts de diagnóstico; se conserva `.env`,
la aplicación y los datos. No se ejecutaron suites, modelo real, SEC forzado ni
otra observación larga. Las tres comprobaciones offline verifican comportamientos
concretos y no certifican estabilidad.

Al cierre quedaron cinco runs iniciados en este arranque: dos failed, dos completed
y SPCX validating sin finishedAt. Hubo dos publicaciones nuevas, ambas shadow,
EUNL y EQQQ. La recuperación futura debe consultar owner/fence y registros durables
antes de resolver SPCX; no repetir inferencia o publicación de forma ciega.

La copia del resumen del observador tiene 26 muestras: tres sin readiness durante
arranque y una con conexión rechazada después. `state=interrupted`,
`completedObservation=false`, `continuousBackendObservation=false`.
El backend duró aproximadamente **25 min 23 s**, no 24 horas. La inspección de
procesos posterior no encontró backend ni observador. No se han arrancado.

Antes de una nueva prueba continua, el P0 debe reproducirse y verificarse sobre
una copia consistente con WAL, y completarse la revisión semántica. Conservar
shadow, escritor único, WAL/FULL, lectores readonly/query_only, fencing, snapshots
sellados, llama.cpp y el arranque exclusivo mediante `cd backend && npm start`.
