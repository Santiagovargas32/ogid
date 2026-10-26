# Entrega D — punto de entrada después de C

Estado: preparado para implementar cuando el usuario continúe D. Fuente: fase 4 del [diagnóstico](../../OGID-diagnostico-direccion-y-plan-2026-10-25.md). Consultar primero [ESTADO.md](ESTADO.md), el diff y las decisiones vigentes. No repetir A/B/C ni volver a copias de 0.2.

## Base que recibe D

El esquema efectivo de la base indicada en `.env` ya es **025**: 023–025 se aplicaron directamente el 26/10/2026 a las 17:54:52 UTC, por autorización expresa sin backup ni test previo. No editar migraciones aplicadas. Siguiente número libre: **026**. La recuperación posterior está cerrada: .env selecciona ogid-repaired-20261026-183735.sqlite, validada globalmente y sin pérdida de filas; el archivo original dañado permanece intacto. Consultar RECUPERACION.md. El usuario mantiene el backup manual. No volver a la ruta original dañada ni repetir recuperación como precondición de D.

C publicada: `40a027d`, CI 40404890887 correcta; la anterior B era `9a3aa2f`. El punto 2 posterior está cerrado; cifras y versiones efectivas en ESTADO.md. Conservar también `renewalId` en StorageManager y su regresión de 0.2. La publicación C se completó por conector; consultar su recibo y GitHub. No se ha desplegado el backend. Resultados de pruebas y posibles diferencias posteriores están en ESTADO.

| Superficie existente | Uso correcto en D |
|---|---|
| `storage/newsComparisons.js` | Entrada de cambios y consultas de cobertura/afirmaciones; no son incidentes verificados |
| `news_comparison_changes` | Secuencia monotónica durable, escrita dentro del commit de ingestión/revisión; incluye artículo/revisión/grupo anterior y nuevo, o revisión manual y grupos afectados, con decisión original, revisor, motivo y referencias accesibles en changes |
| `news_comparison_publication_versions`, `news_comparison_claims` | Hechos derivados inmutables de una revisión exacta; evidencia enlazada con `article_revisions` |
| `news_comparison_assignments`, `news_comparison_group_versions` | Estado histórico a secuencia de corte; conservar asignaciones anteriores al split/merge/corrección |
| `news_comparison_members`, `news_comparison_publications` | Proyecciones actuales; no usarlas para reconstruir una entrada histórica |
| `news_comparison_reviews`, `news_comparison_claim_links` | Motivo, revisor, referencias, idempotencia y apoyo/contradicción/contexto atribuidos al operador |
| `storage/agentRepository.js::alertSync()` | Sustituir el sondeo de últimas 500 filas por procesamiento incremental; mantener lectura de bandeja y revisiones actuales |
| `services/agent/maintenance.js` | Coordinación y temporizador deterministas ya separados de inferencia; extender sin otro scheduler |
| `services/research/eventLedger.js` | Contexto y eventos analíticos existentes; no reutilizar sus IDs como incidentes físicos |
| `geopolitical_alerts`, `geopolitical_alert_revisions`, `geopolitical_alert_state` | Mantener compatibilidad, ACK y estados de lectura del usuario durante la transición |

## Contrato de entrada de C

`news.comparison.changes` / `GET /api/news/comparisons/changes` admite `sinceSequence`, `cursor`, `limit` y `maxBytes`. Devuelve `items`, `asOfSequence`, `hasMore`, `nextCursor`, `nextSinceSequence`. Todas las páginas de un cursor fijan el mismo techo. Usar los mismos filtros; `nextSinceSequence` avanza hasta el último elemento entregado, nunca al techo si quedan páginas. Las altas posteriores al techo aparecen al abrir la siguiente ronda. La secuencia puede tener huecos: no exigir números contiguos.

Las lecturas públicas son readonly. Este cursor **no persiste un consumidor ni confirma entrega**. El consumidor interno D debe guardar su posición junto a sus efectos, sin llamar HTTP desde el escritor. Leer referencias/metadatos acotados antes de payloads. Al aplicar una entrada de publicación, consultar su `articleId + articleRevision` y las asignaciones/grupos a `change_sequence <= sequence`; no el artículo actual que puede estar corregido después.

Las revisiones manuales pueden afectar varias publicaciones: paginar las asignaciones exactas a la secuencia y guardar progreso si no caben en una unidad. El límite de 500 miembros de C es capacidad de un grupo/revisión interactiva, no un límite global de consumo. Los hints automáticos de relaciones sólo abarcan la página entregada; nunca usarlos como registro exhaustivo de apoyos o contradicciones.

C se alimenta en la transacción de `SqlNewsArchive.save()` y en el backfill editorial existente (`comparisons-v1`). Las consultas no disparan enriquecimiento ni inferencia. El estado de cierre del backfill está en ESTADO.md: las entradas históricas del journal deben identificarse como conocimiento recibido/indexado, sin simular ataques recientes.

## D.1 — cursor y emisiones transaccionales

Objetivo: reemplazar las consultas `ORDER BY ... LIMIT 500` de `alertSync()` por páginas durables de revisiones, tanto de noticias C como de awareness.

1. Añadir en 026 cursor por consumidor y stream, revisiones de dominio y outbox con claves únicas. Propuesta de identidad: `consumer + stream + sourceSequence + entityId + domainRevision + changeKind`; precisar los campos con el flujo final. Cursor, revisiones de dominio y outbox se confirman en la **misma transacción del escritor**.
2. Añadir journal de awareness en el punto donde se persiste `awareness_events` (hoy conserva el estado actual, no un historial equivalente a C). Registrar revisiones futuras atómicamente. Para lo anterior, backfill reanudable de referencias con límite superior congelado, sin inventar revisiones que nunca se guardaron. `news_comparison_changes` no cubre awareness.
3. Un tick procesa una página acotada y deja backlog visible para el siguiente. Partir de los límites actuales: hasta 100 referencias y 128 KiB, objetivo 50 ms; respetar guardias de ejecución/commit. Si una entrada exige más trabajo, guardar continuación durable, no saltarla ni avanzar el cursor completo antes de sus efectos.
4. Reinicio/retry/ACK perdido deben devolver el mismo resultado sin duplicar revisión ni emisión. Confirmación del procesamiento interno y ACK externo de entrega son estados diferentes. Reutilizar recibos, requestId y owner/fence si se usan jobs; no añadir un segundo escritor.
5. Exponer último procesado, techo, backlog, última actividad, error explícito y cobertura del backfill. No presentar backlog cero en un stream no inicializado como cobertura completa.

**Detalle crítico:** el mantenimiento actual decide si omite `alerts` por `inputs.news.revision`, awareness y research. C puede indexar una fila histórica sin modificar la revisión de noticias. Incorporar el watermark/backlog del journal en `dependencies`/`revisionFor('alerts')` o ejecutar el consumidor pendiente aunque los antiguos inputs no cambien. De lo contrario, el cursor puede quedar parado con trabajo pendiente.

Aceptación: más de 500 entradas, varias páginas y reinicio a mitad; no pérdidas ni duplicados. Inyección de fallo antes/después del commit, retry de requestId y ACK perdido. Una fila grande se representa por referencia/detalle paginado o estado bloqueado visible; nunca descartada.

## D.2 — incidentes, situaciones y evidencia

Introducir un dominio explícito de incidentes/situaciones con IDs durables propios, relaciones a afirmaciones y revisiones append-only. Un grupo C es **cobertura candidata**. No convertir `coverage-*`, hashes de titulares ni clusters del analista en identidad de suceso confirmado.

Datos mínimos por revisión: ID, estado de verificación, atribución, referencias a afirmaciones/revisiones elegibles, lugar con método/precisión, tiempo del hecho con base/precisión, incertidumbre y motivo del cambio. Separar `occurredAt`, `publishedAt`, `receivedAt`, `changedAt` y `availableAt`; usar null cuando no exista evidencia del tiempo del hecho. La fecha de publicación y las menciones de lugar no lo acreditan por sí solas.

Las modalidades negación, futuro, opinión, mixto y no soportado conservan su significado. Un reporte puede entrar en la bandeja sin verificar. Una declaración oficial es una afirmación atribuida, no verificación independiente de sus alegaciones. Dos editores distintos y dos IDs de origen conocidos tampoco prueban independencia sin evidencia del origen. Origen desconocido nunca cuenta como corroboración.

Merge/split de C debe conservar sus revisiones/aliases y actualizar dependencias sin perder IDs ni ACK existentes. Añadir decisiones de asociación de dominio propias si hacen falta; la unión de cobertura no obliga a unir incidentes. Las correcciones invalidan o degradan afirmaciones derivadas, síntesis y emisiones dependientes, conservando el estado previo consultable. La intensidad/relevancia editorial no es probabilidad de ocurrencia.

Aceptación: corrección, negación y retractación actualizan el mismo historial; una noticia antigua recién indexada no crea un ataque nuevo. Sindicación de cinco copias conserva un origen. Mantener desconocido cuando no existe evidencia suficiente, sin geocodificar desde el país editorial.

## D.3 — contratos y bandeja

Evolucionar las rutas actuales de alertas, preservando IDs, ACK, envelopes y revisiones durante la transición. Añadir lecturas compactas de situaciones/incidentes, detalle de evidencia y paginación estable por secuencia. Mantener la separación de permisos read/operator y los budgets API/MCP. Actualizar contrato y generador de API-MCP, no el inventario a mano.

La bandeja distinguirá «cambió» de «ocurrió», reporte nuevo de corrección y prioridad editorial de estado factual. Mostrar origen, modalidad y desconocidos con acceso a publicaciones/afirmaciones; conservar foco, scroll y sincronización compacta. D no necesita inferencia ni navegador abierto para progresar. No promover IA visible ni borrar las alertas heredadas para simplificar la transición.

## Verificación y cierre de D

| Caso | Evidencia requerida |
|---|---|
| Ráfaga >500 | Todas las revisiones de noticias y awareness consumidas por páginas, cursor durable y claves de emisión únicas |
| Reinicio y ACK perdido | Reanudación del último commit, resultado idempotente, estados de lectura preservados |
| Correcciones concurrentes | Evidencia exacta por revisión, invalidación propagada y cursores estables |
| Fecha antigua / publicación desconocida | Cambia el conocimiento; no inventa ocurrido reciente ni fecha de hecho |
| Origen y modalidades | Sindicación y desconocidos sin corroboración; opinión/futuro/negación sin ataque ocurrido |
| IA off / frontend cerrado | Mantenimiento y consumo deterministas progresan con estados de calidad visibles |
| Compatibilidad | API/MCP real, permisos, paginación/bytes, rutas heredadas y UI accesible |
| Esquema | Migración aditiva posterior a 025; versiones/checksums anteriores conservados y ninguna sustitución de base |

Hacer pruebas proporcionales después del cambio y reutilizar las suites cerradas de C si sus superficies no cambian. Actualizar ESTADO por unidad con comandos/resultados reales y fallos pendientes. Registrar qué está implementado, verificado en aislamiento y aceptado operativamente. D no cierra por sí sola la observación continua 24 h ni la puerta semántica IA. E/F siguen siendo entregas posteriores.

Reversión: pausar el nuevo consumidor/proyección de dominio sin eliminar cursores, outbox, revisiones ni escrituras. Mantener código que conozca 026 y la compatibilidad de alertas. No ejecutar un checkout anterior que desconozca el esquema efectivo.

## Handoff después del punto 2

Backfill comparaciones-v1 completo: 146.475 publicaciones, 179.795 afirmaciones atribuidas y journal hasta 146.475; facetas y comparaciones actuales sin pendientes. No existe aún consumidor D. Procesar todas las entradas con bootstrap histórico; no inicializar el cursor al máximo para descartar el backlog ni emitir incidentes recientes por changed_at de la indexación. Las publicaciones conservan sus fechas/contentRevision. 141.959 editores y 34.161 idiomas de clasificación siguen desconocidos; 2.671 clasificaciones son no soportadas. Esos estados no impiden consumir evidencias con incertidumbre explícita.

Dependencias instaladas y locks alineados, 0 vulnerabilidades: no repetir instalación/backfill como precondición de D sin cambios. Candidato completo 1074/1074 backend y 32/32 MCP; referencias privadas point-2. 0.2 conserva latencias largas documentadas y debe abordarse como medición/corrección operativa, sin volver a copias ni presentar D o 24 h como cerradas. Siguiente migración 026.
