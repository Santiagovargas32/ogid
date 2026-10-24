# Incremento local: históricos seguros, cifras tipadas y recuperación de mercado

Fecha: 23/10/2026, Europe/Madrid. Base: `feat/agentic-intelligence`,
`fcd1ca599cbcd0ce5c63d398d7921108cf7cb321`.

Seguimiento: la ejecución operativa posterior falló el 23/10 a las 19:12 UTC.
La causa observada, corrección y nueva evidencia están en
[writer-stall-correction.md](writer-stall-correction.md). Las suites siguientes
documentan la entrega inicial; no acreditan continuidad operativa.

Entrega local del prompt del 23/10. Se conserva la modificación previa de
`.gitignore`. No se modifica `.env`, llama.cpp ni la base operativa. No se hace
push, merge, despliegue ni promoción. Las únicas instancias arrancadas son los
fixtures efímeros autorizados; no se ejecuta el observer ni el backend operativo.

## Matriz de implementación

| Requisito | Implementación | Evidencia de comportamiento |
| --- | --- | --- |
| P0: enumeración administrativa | `AdminHistoryProjection`: SQL sobre proyecciones, conteos por identidad, cursores por revisión, páginas limitadas antes del payload y presupuesto de bytes. Cobertura costosa pasa a detalle explícito. | `adminHistory.test.js`, harness de 140.000 eventos y suites SQL existentes. |
| Routing y efectos | `storageOperationContract` compartido por contratos, clasificación y routing. Admin, sources, history y datasets usan queries; consultas técnicas que persisten resultados conservan su naturaleza de cálculo. El worker queries rechaza mutaciones. | Descriptores, cancelación de un consumidor coalescido, pruebas de aislamiento/reconciliación y reconstrucciones del lector en el harness. |
| Proyecciones coherentes | Correspondencia por revisión/identidad/payload verificada en mantenimiento paginado. Los commits posteriores mantienen la coherencia. Conteos desconocidos permanecen null mientras se verifica una base anterior. | Backfill reanudable en el mantenimiento existente; prueba de desacuerdo sin falsear ceros. |
| Cifras semánticas | `numeric-semantics-v2`, prompt v1.7 y `typed-numeric-facts-v2`. Allowlists por indicador/hoja, roles y unidades; contexto metodológico separado. Semántica congelada en el snapshot y rechazo final en servidor. | `numericSemantics.test.js`: warmup 21, null, factores, unidades, valores exactos, prosa sin respaldo y paths no admitidos. |
| Reparación ASML | Catálogo canónico por dominio, paginado y con continuaciones. Mantiene consulta real, IDs exactos y una reparación compartida. | ID canónico `...ce6a0114` frente a `...ce8a0114`; JSON inválido seguido de ID alterado termina sin publicación. Suites conservan reparación válida y publicación única. |
| Catch-up | `HistoricalAcquisitionService` conserva ventanas durables y ACK por intento. Intraday hidrata cobertura antes de sesión, admite dos trabajos por ciclo y verifica continuidad local antes de descargar. | `marketCatchup.test.js`: arranque tardío, deuda, reinicio de sábado sin nuevas descargas y persistencia diferida. |
| Barras e historia | Rejilla/sesión/OHLCV/cierre, procedencia chart saneada y ledger derivado de validación. Se conservan originales. Reparación diaria dirigida desde el ciclo existente. | Colas no alineadas, sesiones diarias incompletas/no oficiales, cobertura horaria desde apertura US a las 09:30, rollups desde 5 min y comprobación de huecos/calendarios. |
| Series y último cierre | `resolveClosedSeries` compartido por técnica e indicadores, con los agregadores usados por Conditions; dependencias de maintenance incluyen revisión base. `anchor=last-close` es explícito en Conditions y contexto técnico; live sigue siendo el valor predeterminado. | Mismo camino de rollup, exclusión de observaciones no acreditadas y vista de cierre de fin de semana conservada durante la apertura siguiente, sin look-ahead. Agregados sólo con cortes comparables; siguen siendo necesarias dos barras mínimas para Conditions. |
| SEC | HTTP/parseo en `SourceAcquisition`, sin handles SQL. Escritor valida identidad/configuración del intento y confirma hechos/estado atómicamente. Intentos acotados, causas/fases, backoff y elegibilidad por fuente. | `sourceAcquisition.test.js` y `secSourceAgent.test.js`: cuerpo/cabeceras/transporte, cancelación, rollback y ejecutor real contra transporte local de fixture. |
| Advanced | Scope, fase, revisiones, queuedAt y edad de espera separados del resultado durable. Calidad ausente se muestra unknown, con motivo, en lugar de inventar fallback. | Suites de snapshots/coordinación/Advanced y frontend. Se conserva el resultado anterior durante refresh. |

## Persistencia y compatibilidad

- Migración **020**: ledger vacío de validaciones e índices administrativos. No
  modifica 001–019 ni recorre velas durante la migración. Se verifica desde
  backups WAL de fixtures 009, 018 y 019, conservando filas y checksums.
- Verificación/reparación de proyecciones y validación histórica se ejecutan en
  páginas por el mantenimiento existente, después del arranque. No se añade otro
  scheduler ni escritor. Los cursores y estados son durables.
- Un escritor WAL/FULL, lectores readonly/query_only, snapshots sellados,
  owner/fence, IDs idempotentes y guardias de 5/30 s se conservan. Una cancelación
  de consumidor no pretende interrumpir SQLite síncrono.
- API/MCP **1.7.0**, 82 rutas/91 operaciones. Históricos y datasets añaden
  paginación sin retirar los arrays existentes. Se conservan bootstrap compacto,
  sync v2, reservas, ETag privado y carga por interés.
- Las publicaciones históricas no se reescriben. Nuevas publicaciones v1.7 exigen
  unidades; los contratos numéricos/métodos no reconocidos no habilitan señales.
  La guardia de prosa es conservadora y no sustituye la revisión semántica del
  modelo real.

## Política de mercado y límites de evidencia

Yahoo permanece en 4.0.2 y comparte cliente/cola. `.DE` y `.AS` utilizan 15 min
de retraso publicado; `.MI`, 20 min; se añade una gracia interna configurable
de dos minutos. Otros casos usan una política interna conservadora, identificada
como tal. No es una garantía de entrega ni una cuota oficial de proveedor.

Se conservan los límites locales de rango corto de 30/31 días y el solape de
15 minutos. Los jobs no certifican continuidad por MAX(closeTime), respuesta HTTP
o memoria. La cobertura avanza tras persistencia confirmada y verificación de la
ventana. Vacíos/parciales conservan deuda y backoff; deuda fuera de la ventana
local queda visible. Las ventanas ya verificadas no provocan nuevas descargas.

Se amplía el calendario contrastado de venues europeos a 2024–2026. Excepciones
sin hora confirmada siguen siendo parciales. La sesión regular no se extiende a
retail ni se mezclan datasets CSV/Yahoo. Permanece la guardia global de huecos;
no se cambian semillas ni se interpola historia. La reparación real de los
instrumentos del operador ocurrirá cuando éste arranque su backend.

Fuentes contrastadas:

- [Yahoo: mercados y retrasos](https://help.yahoo.com/kb/finance/article-exchanges-data-delays-sln2310.html).
- [Xetra 2024](https://cashmarket.deutsche-boerse.com/resource/blob/3559262/98ebe1fde231df56c9f116bc766533b2/data/xetra-trading-calendar-2024.pdf),
  [Xetra 2025](https://www.cashmarket.deutsche-boerse.com/resource/blob/4064968/4079a2d5a9fec324905942b807b398ed/data/xetra-trading-calendar-2025.pdf)
  y [sesión final de 2025](https://live.deutsche-boerse.com/en/handeln/trading-calendar).
- [Euronext: calendarios 2024–2026](https://www.euronext.com/en/trading/trading-hours-holidays).
- [Xetra: distinción retail/regular](https://www.cashmarket.deutsche-boerse.com/cash-en/Stay-Informed/circulars-newsletters/deutsche-boerse-circulars/Introduction-of-the-Extended-Xetra-Retail-Service-early-and-late-trading-Planned-changes-to-the-trading-process-valid-from-1-December-2025-4793480).
- [SEC: acceso justo](https://www.sec.gov/about/developer-resources).

El camino revisado no añade API facturada, compras ni fallback de pago. Eso no
acredita gratuidad contractual, retención garantizada o capacidad ilimitada.

## Validación local

La evidencia actual se guarda en
`.agent-validation/local-increment-verification-20261023/`. No se reutilizan los
informes históricos 959/959 como aceptación actual. Los tests que necesitan
loopback se ejecutan con la autorización para instancias efímeras; el intento
MCP dentro del sandbox no pudo abrir sockets y no cuenta como regresión válida.

| Comprobación final | Resultado |
| --- | --- |
| Backend `npm run check` | Correcto; incluye sintaxis de backend y `frontend/js`. |
| Backend `npm test` | **988/988**, cero fallos/cancelaciones/omisiones; 93,68 s. |
| MCP `npm run check` y `npm test` | Correcto, **29/29**. |
| MCP `npm run inventory:check` | Correcto, **82 rutas / 91 operaciones**. |
| Frontend afectado | Modelo de Conditions, ciclo de vida de Advanced y comprobaciones estáticas dentro de la suite. Sin prueba manual en navegador. |
| `git diff --check` | Correcto. |
| Migraciones anteriores | 001–019 sin cambios; migración 020 probada sólo en fixtures. |

La nueva comprobación diaria hizo fallar inicialmente dos fixtures de caché que
usaban fines de semana o cierres de 24 horas para acciones estadounidenses. Se
corrigieron los fixtures a sesiones oficiales, manteniendo las aserciones de
invalidación, número de muestras y cero HTTP. `backend-before-fixture-correction.log`
conserva esa ejecución; `backend-final.log` contiene la pasada 988/988.

Harness volumétrico final:
`.agent-validation/admin-history-volume-20261023-implementation-6/result.json`.
140.000 eventos, payloads de 1/4/16 KiB, N=50 por cohorte. Frío significa lector
recién reconstruido y listo; no se vacía la caché del SO. Caliente significa una
segunda petición inmediata con los mismos parámetros; los commits concurrentes
pueden invalidar la revisión entre ambas. Endpoint HTTP real de fixture,
fuentes simuladas, sin modelo ni acceso a producción.

| Cohorte | p95 | Máximo |
| --- | ---: | ---: |
| Fría | 23,28 ms | 1.281,79 ms |
| Caliente | 17,16 ms | 19,64 ms |

Se confirmaron 347 adquisiciones simuladas con su commit real e idempotente de
velas y 398 heartbeats (p95 89,72 ms, máximo 270,31 ms). El escritor siguió ready
durante 50 reconstrucciones inyectadas del lector. Cero RPC a proveedores desde
la lectura administrativa, ejecutada en readonly/query_only. Respuesta de
24.481 bytes; RSS máxima del proceso 342.843.392 bytes; event loop p95 10,66 ms,
máximo 26,35 ms. El informe conserva plataforma, CPU, memoria, filesystem y
planes SQL.
No es una medición del montaje `/srv`, de la LAN ni de proveedores/modelo reales.

Los dos primeros intentos del harness fallaron en su preparación (job aún sujeto
a debounce y nombre incorrecto de una métrica). El tercero pasó, pero el cuarto
detectó un máximo frío de **6.454,45 ms**, fuera del límite de 5 s. El plan SQL
mostró ordenación global por rowid sobre el índice de identidad. Se corrigió con
cursor compuesto `(identity_version,rowid)` en el índice existente, limitando
referencias antes de acceder al payload. La quinta ejecución pasó y la sexta
añadió ingestión real de velas del transporte simulado. No se elevaron límites.
Se conservan logs/resultados de estos intentos; sólo la sexta es la aceptación
final con adquisición concurrente. Todos sus fixtures SQLite se cerraron y
retiraron.

## Runbook posterior, a cargo del operador

1. Revisar el diff y guardar un backup consistente con el helper existente antes
   de arrancar sobre datos operativos. Una base con WAL se copia mediante Online
   Backup API, no copiando sólo el fichero principal. Sustituir las rutas por la
   base configurada y un destino nuevo en el volumen elegido; por ejemplo:

   ```bash
   cd /home/fedora/ogid/backend
   npm run storage:backup -- /srv/bitcoin/ogid/db/ogid.sqlite /RUTA/DE/BACKUP/ogid-before-020.sqlite
   ```

   El helper comprueba integridad y claves foráneas del backup. No se ha ejecutado
   sobre la base operativa en esta entrega.
2. Arrancar exclusivamente con `cd backend && npm start`. Ese arranque aplicará
   020 en la base del operador. Mantener shadow y llama.cpp; no arrancar broker,
   OpenCode o worker por separado.
3. Revisar progreso de proyecciones/validaciones y deuda por instrumento. Durante
   la comprobación histórica, desconocido/null no significa cero ni pérdida.
   Contrastar sesiones y reparación real antes/después; los fixtures no afirman
   haber reparado EUNL/EQQQ en la base operativa.
4. En otra terminal, desde backend, ejecutar cuando corresponda:

   ```bash
   npm run agent:observe -- ../.agent-validation/shadow-increment-NUEVA-RUTA 24
   ```

   La ruta debe ser nueva. Este comando no se ha ejecutado en esta entrega.
5. Correlacionar PID/startedAt/build, job/run/fence y snapshot. Distinguir
   recuperación de lector, disponibilidad y continuidad. Completar 24 horas del
   observer no acredita estabilidad si hubo caída o huecos.
6. Revisar publicaciones reales y la primera propuesta/reparación por separado.
   Ante una operación incierta, consultar estado durable y owner/fence antes de
   reintentar. No reejecutar SPCX ni inferencias/publicaciones a ciegas.

Rollback lógico: volver el selector a «En vivo» y pausar el agente con sus
controles existentes si hace falta contener una regresión. Mantener la migración
020 y las guardias P0 en cualquier build
de recuperación; un checkout anterior sin 020 rechazará el esquema por estar
adelantado. Conservar datos/publicaciones y reanudar mantenimiento por cursor. No borrar
migraciones, tablas ni sustituir la base como forma de revertir funcionalidad.

La observación continua de 24 horas, el rendimiento del disco operativo y la
revisión semántica del modelo real siguen siendo puertas pendientes. No se
declaran superadas ni habilitan modo visible por pasar suites o este harness.
