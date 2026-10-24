# Corrección del bloqueo del escritor del 23/10/2026

Implementación local posterior al incremento. Se conservan `.env`, base
operativa, migraciones 001–020, evidencia anterior y configuración del modelo.
No se arranca el backend operativo ni el observer, ni se publica código.

## Qué ocurrió

Fuentes: `.agent-validation/shadow-backend-20261023-205944.log` y
`.agent-validation/shadow-24h-20261023-210330/samples.jsonl`.
Las horas siguientes están en UTC (Madrid: UTC+2).

| Hora | Evidencia observada |
| --- | --- |
| 18:59:44 | Inicio de la instancia del operador. |
| 19:10:42,544 | Se envía `domain.indexPage`; al fallar aún no tiene ACK de inicio. |
| 19:10:49,778 | Último heartbeat de telemetría del escritor y último progreso confirmado del RSS: 940 de 1.094 artículos procesados. |
| 19:11:00,322 | Se envía la renovación durable del agente; tampoco recibe ACK de inicio. |
| 19:11:43,543 | Observer: heartbeat del escritor con 53.765 ms de antigüedad. Los lectores siguen respondiendo; los HTTP 200 no acreditan disponibilidad del escritor. |
| 19:12:05,324 | Tras 35 s de espera de despacho y la guardia adicional de 30 s, falla cerrado con `STORAGE_OUTCOME_UNKNOWN / STORAGE_DISPATCH_TIMEOUT`. |
| 19:12:25,210 | Se terminan los servicios; quedan persistencias sin confirmar y un error derivado `STORAGE_NOT_READY` en cleanup. |

El `shutdown_failed` es posterior al fallo primario. Los 234 s acumulados del
RSS tampoco prueban por sí mismos un exceso de su timeout de 180 s: su watchdog
se renueva únicamente al confirmar progreso durable. Fue la falta de respuesta
del escritor a la renovación la que activó el cierre.

Los logs muestran varios SQL lentos anteriores (incluida una lectura de 11,61 s),
pero **no contienen la sentencia exacta que quedó detenida**. El registro de SQL
lento se emitía después de terminar cada sentencia; una llamada que no retorna
no deja ese registro. No se atribuye el incidente a disco, DNS, SEC o modelo sin
esa evidencia.

## Defectos reproducidos y cambio

La integración añadía dos auditorías históricas de hasta 128 filas cada una en
la misma orden de mantenimiento, sin presupuesto de tiempo entre filas. El
bucle volvía a pedir otra página tras sólo 25 ms y podía competir con adquisición
y commits. El RSS limitaba sus lotes por filas/bytes, pero confirmaba diez filas
antes de ceder incluso cuando cada fila era lenta. Esas unidades amplificaban
la presión sobre el único escritor; no son una identificación retrospectiva de
la última llamada detenida.

| Cambio | Contrato conservado / prueba |
| --- | --- |
| `validatePage` y `validateProjectionPage` paran entre filas por tiempo, además de filas y bytes. Seleccionan referencias antes de cargar cada payload. | Cursor durable; no se pierden filas ni revisiones. Inyección de latencia verifica pausa y reanudación. |
| `BusinessRuntime.indexPage` ejecuta una fase por orden, con presupuesto máximo de 100 ms. | Rotación entre limpieza, velas y proyección; conserva el presupuesto corto explícito del índice. |
| `StorageManager` admite mantenimiento cuando el escritor está libre, detrás de adquisición/commits/control. Entre páginas espera al menos 1 s y nueve veces el tiempo consumido. | No cambia prioridades ni guardias del heartbeat. El estado expone espera, motivo y próxima elegibilidad. El backfill tarda más deliberadamente. |
| El archivo SQL ofrece páginas de ingestión adaptadas al tiempo, conservando atomicidad. | RSS procesa todas las filas; sólo reconoce las efectivamente confirmadas. Una página revertida no avanza progreso ni revisión en memoria. |
| Buffer compartido de 1.088 bytes con SQL saneado y fase de transacción. | El padre puede leerlo durante un bloqueo nativo y lo congela en la causa primaria. No contiene bindings, filas, secretos o contenido de proveedor. Prueba con bloqueo SQLite real y timeout abreviado sólo en el fixture. |
| El cierre drena todas las cancelaciones y registra las no confirmadas si storage ya falló. | Idempotencia y causa primaria conservadas; no declara cancelado un job sin ACK ni oculta otros errores de cleanup. |

Los límites de 5/30 s, el cierre ante incertidumbre, la concurrencia de proveedores,
la cobertura y el único escritor WAL/FULL se mantienen. No se añade una migración,
otro escritor ni un scheduler de adquisición.

Un presupuesto cooperativo sólo se comprueba entre unidades: **no puede
interrumpir una llamada nativa de SQLite o un fsync que no retorna**. Si eso vuelve
a suceder, permanece el cierre seguro; el nuevo diagnóstico permitirá distinguir
la sentencia y fase de transacción de la telemetría anterior.

## Verificación

Evidencia nueva: `.agent-validation/writer-stall-fix-20261023/`.

- Reproducción anterior: cuatro casos fallaban antes del cambio; los cuatro
  pasan después. Se añaden otras cuatro regresiones de atomicidad, admisión,
  bloqueo nativo y saneamiento del diagnóstico.
- La primera pasada completa detectó que se había ignorado el presupuesto
  explícito de 1 ms de una prueba del índice. Se corrigió para aceptar el límite
  más estricto; no se cambió su aserción.
- Prueba combinada final:
  `.agent-validation/writer-contention-20261023-fix-2/result.json`.
  140.000 eventos, 4.096 velas pendientes de auditoría y 18 feeds HTTP locales.
  Se archivaron **los 1.260 artículos** entregados, aunque el preview RSS contiene
  menos elementos por su deduplicación habitual. Hubo **107 renovaciones
  durables** y 107 commits auxiliares; p95 del heartbeat **44,26 ms**, máximo
  **80,90 ms**. Escritor y ambos lectores quedaron ready, sin operaciones inciertas;
  avanzaron ambos cursores de auditoría. El backfill completo no es un requisito
  de esta prueba de continuidad bajo carga.
- El primer intento combinado usó registros de instrumentos diferentes en la
  preparación y el worker: activó una reconstrucción del índice y no alcanzó las
  fases de auditoría dentro de la ventana. Sus artículos y heartbeats sí se
  confirmaron; `acceptance=false` se conserva. Sólo el segundo cuenta como
  aceptación de todas las fases previstas.

| Verificación final | Resultado |
| --- | --- |
| Backend `npm test` | **996/996**, cero fallos, cancelaciones u omisiones; 94,09 s. |
| Backend `npm run check` | Correcto; incluye sintaxis de backend y frontend. |
| MCP check / tests / inventory | Correcto; **29/29**, 82 rutas / 91 operaciones. |
| `git diff --check` | Correcto. |

Los logs completos, reproducción y resultados están en `verification.json` y
los ficheros de la carpeta de evidencia indicada.
Son pruebas aisladas, no una medición del disco `/srv`, del modelo real o de
24 horas de servicio.

## Siguiente arranque del operador

Usar el backup consistente y el procedimiento del
[runbook del incremento](local-increment-implementation.md#runbook-posterior-a-cargo-del-operador).
El arranque sigue siendo exclusivamente `cd backend && npm start`.
No hace falta modificar `.env` ni reaplicar o borrar la migración 020.

El mantenimiento retomará sus cursores con menor presión de I/O. Iniciar el
observer en una **ruta nueva**; conservar la pasada fallida como evidencia.
Revisar antigüedad del heartbeat del escritor, latencias durables, espera del
mantenimiento y causa primaria, además del HTTP. Si vuelve a fallar, consultar
`primaryCause.sqlActivity` / `storage.worker.sqlActivity` antes de atribuir una
causa o repetir una mutación cuyo resultado sea incierto.

La validación anterior del incremento cubría lecturas administrativas y fixtures;
no acreditaba este escenario de backfill histórico concurrente sobre la base del
operador. La continuidad operativa sigue pendiente de una nueva ejecución.
