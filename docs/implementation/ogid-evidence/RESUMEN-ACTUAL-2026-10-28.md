# OGID — resumen de producto, fallos y continuidad al 28/10/2026

Corte autónomo para preparar un prompt o plan focalizado. Entrada vigente: [ESTADO.md](ESTADO.md); dirección: [diagnóstico del 25/10](../../OGID-diagnostico-direccion-y-plan-2026-10-25.md) y [PLAN v6](PLAN.md). Los prompts documentales son referencias; la sesión fija qué ejecutar.

**A–D están implementadas e integradas con backend, SQLite, dashboard y MCP. D3 demostró puesta al día bajo adquisición y añadió 10.692 publicaciones. El backend terminó detenido por espera de E/S durante commit. E/F y aceptación final pendientes.** Código y pruebas correctos no equivalen a estabilidad ni utilidad IA aceptadas.

## Identidad y funcionamiento actual

- Rama `feat/agentic-intelligence`, código **[124050a932d6895cfc2e6ff73284d7c4e7c22fcb](https://github.com/Santiagovargas32/ogid/commit/124050a932d6895cfc2e6ff73284d7c4e7c22fcb)** sobre c5c1ea0. D inicial df50aae; mantenimiento 4bf31a6 y correlador compacto c5c1ea0. Este resumen pertenece al commit documental posterior.
- D3 ejecutó archivos modificados sobre c5c1ea0 antes de crear el SHA de cierre. ArtifactHash observado y coincidente: **`0f825dcc7aad4a103fc90a7ff9864784d75476a5fe2b321435bc38613545a86c`**. El nuevo commit no significa que D3 arrancara con ese SHA publicado.
- Contrato **1.12.0**, **98 rutas / 107 operaciones**; esquema **029**, siguiente disponible 030. No hay nuevas migraciones, dependencias, configuración ni límites más altos en este ajuste.
- Base de .env: `/home/fedora/.local/share/ogid/db/ogid-repaired-20261026-183735.sqlite`, Btrfs `/dev/sda3[/home]`. Recuperación exacta del 26/10 cerrada, original dañado preservado. Node 22.23.3; backend matched / 0 discrepancias contrastado el 28/10. Instalaciones backend/MCP cerradas en fd165224, sin nuevos locks aquí.
- Backend D3 PID 1047352 detenido automáticamente; PID ausente, puerto libre y 0 owners al revisar. No se arrancó/reanudó durante este cierre. La base responde a consultas readonly; esto no demuestra integridad global nueva ni recuperación de todos los comandos en vuelo.

Al ejecutar `cd backend && npm start`, la adquisición puede funcionar sin navegador: archiva/normaliza noticias, resuelve identidad si hay evidencia, clasifica, actualiza facetas/comparaciones/journals y consume cambios en situaciones/evidencias. Mercado, señales y analítica usan sus flujos actuales. El arranque disponible **no garantiza estabilidad de toda la noche**, como mostró D3. El conector MCP necesita el backend disponible.

## Entregas integradas y pendientes

| Entrega | Integrado | Pendiente real |
|---|---|---|
| 0 · Base operativa | Identidad, instalaciones, mantenimiento determinista, un escritor/lectores de consulta y recuperación exacta | **0.2: E/S/latencias, persistencia bajo presión, reanudación tras D3 y aceptación operativa** |
| A · Noticias | Identidad/procedencia separadas; aliases/dominios exactos; EN/ES/FR/DE/PT, modalidad, orden/tarjetas/sync y enriquecimiento baseline | Editores/texto desconocidos cuando falta evidencia; nutrir con permisos. RU/UK con evaluación propia |
| B · Fuentes | Evaluaciones/perfiles versionados, importador de operador, medidor/facetas/cobertura, `/sources.html` | Dataset/perfiles documentados. Último corte 27/10: 0/0, no recalculado en D3. Identificar Reuters no calcula su tendencia. Salud/cobertura efectiva en E |
| C · Comparaciones | Agrupación heurística, afirmaciones extractivas atribuidas, merge/split/origen/relaciones con referencias; `/comparisons.html` | Evaluación editorial ampliada; grupo/sindicación no confirma independencia ni ocurrencia |
| D · Situaciones | Journals, cursores, efectos/outbox atómicos, replay/idempotencia, correcciones, alertas heredadas, API/MCP/UI `/situations.html` | **Backlog drenado en D3**; falta estabilidad y reanudación tras fallo. No implementar D otra vez |
| E · Piloto/fuentes | Matriz y ámbitos definidos: Ucrania/mar Negro y mar Rojo | Registro/perfiles/enriquecimiento permitido y salud/cobertura operativa; fechas/geografía/origen/duplicación/latencia y RU/UK evaluados |
| F · Analista/impactos | Runtime/módulos previos disponibles, IA shadow | Síntesis/cronologías/impactos sobre situaciones/evidencia elegible, citas/números/correcciones y evaluación por tarea |
| Final | Pruebas progresivas y smoke anteriores UI/MCP/backend | Integración/rendimiento/recuperación y **24 h continuas del candidato final**; puerta semántica IA separada |

La recuperación, instalación y enriquecimiento del 26/10 están cerrados. Las antiguas **8+1 discrepancias** eran locks nuevos con instalaciones preservadas durante shadow; no dependencias faltantes hoy. Baseline **146.475/146.475** enriquecido conservando identidad/fechas/contentRevision/snapshots. No repetirlo por crecer la base. Sus desconocidos de editor/idioma no son recuentos actuales ni fallos que permitan inventar datos. Un método nuevo se aplicará por páginas cuando corresponda.

## Ajustes de código cerrados desde el último estado documental

- **4bf31a6:** independiza el progreso determinista del consumidor de la pasada analítica pesada, reutilizando coordinación/temporizador.
- **c5c1ea0:** transforma corpus en mediciones completas por señal/país antes de transportar al escritor. D2/D3 no registran el antiguo STORAGE_COMMAND_TOO_LARGE y acreditan persistencia de señales.
- **124050a:** páginas D admitidas como commits acotados aunque RSS espere red; pausa de 100–1.000 ms con backlog, sin otro scheduler. Descubridor principal estable y procedencias preservadas, evitando revisiones por alternar rutas conocidas.
- Nuevas fuentes no elegibles avanzan sin hidratar cuerpos históricos; las correcciones de miembros conservan invalidación. Payloads leídos globalmente por rowid, orden editorial restaurado desde el corte separado.
- Checkpoints RSS agrupados dentro de límites existentes; estados reemplazables serializados/coalescidos, hechos append-only conservados, inputs congelados. Un solo retry de expiración inequívoca de cola con el mismo recibo; resultados inciertos siguen fallando.
- Cierre drena el ciclo aceptado y no inicia el sucesor RSS pendiente. Tiene prueba de comportamiento; **D3 falló por escritor y no acredita un cierre limpio**.

## D2 y D3: evidencia separada

**D2**, observador del 27/10 **16:24:41–17:24:44 UTC**: backlog **16.417 → 27.684**, 1.721 revisiones procesadas frente a 12.988 producidas. Tras cierre solicitado: 30.509 pendientes, timeouts y error de limpieza. Motivó el ajuste; no describe el backlog actual.

**D3**, proceso del **27/10 18:59:00.044** al **28/10 18:15:31.100 UTC**, unas **23 h 16 min**; listo a las 18:59:49.427. Observador sólo **19:00:03.250–20:00:02.960 del 27/10**, 61 muestras. Health/ready 61/61; agente y situaciones 60/61 cada uno, un timeout cada uno. Misma identidad, 0 cambios de backend y 0 recuperaciones de lectores en esa hora. El observador completó su hora; el backend siguió aparte.

News empezó **172.696/203.229**, distancia **30.533**; primera muestra al día **19:03:14.734**, 203.552/203.552. Al final de hora **208.238/208.238**: **35.542 revisiones procesadas** frente a **5.009 producidas**. Una revisión/publicación/evidencia no es un incidente.

Toda D3 incorporó **10.692** publicaciones nuevas para la base, algunas con publicación antigua; no son necesariamente noticias de esa noche ni cobertura exhaustiva. Tramo durable nuevo: **9.905** revisiones/outbox y **5.323** registros de evidencia, sin referencias de dominio ausentes, claves de emisión duplicadas ni new-report sin evidencia en las comprobaciones. Incluye contexto/metadatos/historia, no 9.905 incidentes.

UI: peticiones reales servidas, incluido bootstrap <100 ms en siete solicitudes y una agregación de noticias ~10,7 s. No valida visualmente foco/scroll/móvil otra vez ni acredita un SLO; esas pruebas se hicieron en D inicial.

### Base tras el cierre — consultas readonly 28/10, 18:33–18:36 UTC

| Dato | Resultado |
|---|---|
| Artículos / revisiones | **163.334 / 535.538** |
| Publicaciones C | **163.334** |
| News procesado/disponible | **240.462/240.462** |
| Awareness procesado/disponible | **3.813/3.813** |
| Dominio / outbox | **24.649/24.649** |
| Alertas heredadas | **176** |
| Buckets de señales | **11.748**, snapshot 18:12:03.906 UTC |

Cursores sin continuación/error. Awareness procesado pero excluido por política; no prueba cobertura de incidentes. Backlog cero se refiere a journals confirmados, no al RSS/mercado en vuelo. No se realizó copia, migración, replay ni integridad global nueva durante la revisión.

### Pruebas técnicas disponibles

Backend **1.110/1.110**, MCP **33/33**, build/check e inventario **98/107** correctos. Regresiones de exclusiones/correcciones, RSS esperando red, cola/temporizador, coalescing/append-only/recibos, orden/deduplicación y cierre. Fixtures previos: ráfagas >500, reinicio, ACK perdido, rollback y continuación.

Con **5.407** filas reales readonly, proyecciones completas iguales al lector previo; ejecuciones alternadas templadas con tiempos totales comparables (~6,1–6,4 s). Caché/E/S externa sin controlar: no afirmar 10× ni SLO. No se repiten suites por documentar/publicar lo mismo. CI nueva se consulta por SHA, sin heredar el resultado remoto de D inicial.

## Fallos abiertos y sus límites

| Prioridad | Evidencia | Pendiente |
|---|---|---|
| P0 | Escritor en **btrfs_sync_log**, lectores en **blk_mq_get_tag**, transacción de **85,538 s** en fase commit; PSI full avg10 ≈71 % | Localizar/mitigar esperas de almacenamiento y presión de app; no hay culpable físico exacto establecido |
| P0 | Análisis falla **18:14:54.903**, consultas **18:15:02.752**; escritor **18:15:18.007 UTC**, STORAGE_OUTCOME_UNKNOWN / STORAGE_DISPATCH_TIMEOUT | Heartbeat despachado expirado, sin recibo durable localizado; STORAGE_NOT_READY posterior es consecuencia |
| P0 | Dos fases sin confirmar: persistence.history-cancellation y persistence.pipeline | Reconciliar efectos/recibos. No son dos noticias perdidas; cleanupErrors vacío no hace limpio el cierre |
| P1 | **12** eventos market_observations_persist_failed / STORAGE_QUEUE_TIMEOUT en tres episodios anteriores | Verificar recuperación de cada observación; distintos de snapshots coalescidos. No replay ciego de resultados inciertos |
| P1 | RSS en vuelo y un intento IA running con lease vencido | Recuperación real con owner/fence; el registro no acredita un proceso activo |
| P1 | Máximos registrados: SQL **19.131 ms**, commit **18.301 ms**, checkpoint **21.590 ms** | Son eventos logueados, no percentiles globales; el commit bloqueado final no fue un commit lento completado |
| Puerta IA | Errores de números/evidencia/instrumento/formato, progreso/modelo y preparación | Conservar guardias y reparación única; evaluar utilidad/precisión por tarea |

La base continúa en Btrfs, con unos 33 GiB disponibles al revisar. El checksum del 26/10 se reparó; **esta espera no demuestra que haya reaparecido esa corrupción**. Tampoco se acreditó OOM como causa D3. No sustituir la corrección por backups/recuperaciones genéricos ni por subir timeouts o cambiar FULL.

IA deduplicada por **job/fence del arranque**: **197 = 34 completed + 160 failed + 2 incomplete + 1 sin cierre**. Publicaciones shadow: 26 instrument_outlook, 4 global_intelligence_brief, 2 geopolitical_alert_assessment y 2 market_outlook_global. Los dos incomplete fueron preparación de snapshot; el último sin cierre necesita reconciliación. No sumar llamadas del broker ni histórico global; aprobación de estructura/evidencia no equivale a revisión semántica.

## Orden recomendado para el próximo alcance

1. **D/0.2 focalizado en E/S y persistencia**, usando D3: correlacionar confirmaciones/checkpoints y trabajo repetido con esperas del host; reducir escrituras/proyecciones redundantes mediante coordinación existente, sin perder datos/cobertura/durabilidad. No rehacer el correlador ni drenar de nuevo como tarea inicial.
2. **Reanudación y carga reales:** owner/fence/lease, RSS, observaciones de mercado, fases sin confirmar; recibos/efectos/cursor/outbox y cierre ordenado. No inferir recuperación del mero arranque ni repetir escrituras inciertas sin reconciliación. Pruebas dirigidas a cambios, sin repetir suites por rutina.
3. **E → F con pruebas progresivas.** E: fuentes/perfiles/enriquecimiento permitido y cobertura del piloto. F: síntesis/cronologías/impactos con evidencia elegible. B conserva sin evaluar sin dataset; no bloquea E. Probabilidades sólo con modelo evaluado.
4. **Final:** contratos/UI, ráfagas, reinicio, ACK perdido, correcciones/rendimiento integrados y 24 h continuas del candidato final sin cambiar artefactos; IA semántica aparte. D3 y su hora de observador no lo satisfacen; no exigir 24 h formales antes de cada pequeña entrega.

El próximo prompt debe acotar un lote de 1–2 con entradas D3/código, hipótesis, superficies, aceptación bajo carga, recuperación/cierre y condición para seguir E. Este texto no autoriza implementarlo durante el cierre documental ni añade un plan alternativo al diagnóstico.

## Restricciones y referencias para continuar

- Arranque sólo `cd backend && npm start`; hijos broker/OpenCode/worker según .env, conservar llama.cpp, sin systemd.
- Un escritor y lectores readonly/query_only; FULL, límites, fences, leases, validación y reparación única. Migraciones sólo aditivas desde 030 si hacen falta, no editar 001–029.
- IDs, fechas, revisiones, aliases, snapshots y datos ajenos preservados. Sindicación no prueba independencia; publicación/afirmación/situación/ocurrencia son diferentes. Desconocidos explícitos.
- No reabrir copias/recuperación como precondición. No arrancar, desplegar, fusionar ni promover por inferencia. Publicación autorizada mediante conector GitHub; datos/secretos fuera del repo.
- Estado vigente en ESTADO/PLAN/DECISIONES/PROMPTS/CIERRE-FINAL; EJECUCION-D-2026-10-27 es PID 988930, anterior a D2/D3.

Evidencias privadas: `.implementation-evidence/2026-10-27/D2/review.json`, `D2-fix/result.json`, `D2-fix/benchmark-final-comparison.json`; `.implementation-evidence/2026-10-28/D3-review/{review,observation,backend-events,database,reconciliation-readonly,host-storage,http}.json`.

Fuentes D3: `.agent-validation/shadow-1h-D3-20261027-195640/{summary.json,samples.jsonl,situations.jsonl}` y `.agent-validation/shadow-backend-D3-20261027-195640.log`, **109.052.176 bytes**, SHA256 **`352169eb9bd0cb12cf612db87aa764f3a17d738335aa384b9a9724118f423e7f`**. Nombres con hora local, ventanas anteriores UTC. No publicar logs, bases, credenciales, modelos, node_modules ni artefactos privados.
