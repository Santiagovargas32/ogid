# OGID: implementación por entregas

Versión 3: C y migraciones directas autorizadas; base v1 aprobada el 26/10/2026. Fuente: [diagnóstico](../../OGID-diagnostico-direccion-y-plan-2026-10-25.md). Entrada de reanudación: [ESTADO.md](ESTADO.md).

## Dirección y alcance autorizado

Evolucionar hacia situaciones, afirmaciones y evidencias trazables conservando RSS, archivo, mercados, SQLite, dashboard y MCP. El ciclo inicial comprende 0 y A. El usuario autorizó después el cierre de A y la implementación/publicación de B en commits separados de la misma rama. C está implementada y verificada en aislamiento, en el diff local; D recibe un handoff concreto en ENTREGA-D.md. E–F permanecen en hoja de ruta. El usuario autoriza migraciones directas a .env sin backup/integridad previa; suspende copias y recuperación, que hará manualmente. Despliegue, arranque operativo y promoción visible requieren alcance operativo propio. Los prompts históricos de otros documentos son referencias, no órdenes adicionales.

Invariantes: un escritor de negocio; lectores readonly/query_only; red/inferencia/cálculo largo fuera del escritor y HTTP; límites y guardias intactos; migraciones aditivas; históricos, IDs, aliases y snapshots congelados conservados. Arranque exclusivamente con `cd backend && npm start`, hijos gobernados por `.env`, conservar llama.cpp. Desconocido no implica neutralidad, ausencia de incidentes ni corroboración. Sindicación y publicaciones de IA no acreditan orígenes independientes.

## Lotes y aceptación

| Lote | Resultado | Aceptación / dependencia |
|---|---|---|
| DOC | PLAN, ESTADO, DECISIONES y PROMPTS, excepciones concretas en gitignore y nota de memoria | Reanudar desde ESTADO sin depender del chat; sin secretos ni logs versionados |
| 0.1 | Informe reproducible v19, manifiesto de código/lock/instalación/Node/contrato y verificación de esquema/backup | Artefacto reconstruible, diferencias de instalación visibles; esquema efectivo identificado; precondición de copia revocada para C por D27 |
| 0.2 | Reproducciones de status, snapshots, análisis y commits; consultas acotadas y reconciliación | Cambios medidos en copia; limitaciones reales mantienen cerrada puesta en servicio; no atribuir causalidad física sin evidencia |
| 0.3 | Mantenimiento determinista independiente de AGENT_MODE y navegador | Con modelo desconectado progresan adquisición y trabajo determinista; mismos temporizadores/coordinación |
| A.1 | Identidad editorial y metadatos por todo el flujo, enriquecimiento paginado reanudable | AP exacto; Google es descubrimiento; publisher candidato/desconocido explícito; ID/URL/alias/revisiones conservados |
| A.2 | Clasificación común Unicode EN/ES/FR/DE/PT, modalidad y suficiencia | Distinguir ataque/huelga, negación/futuro/opinión; idioma no soportado no equivale a low |
| A.3 | Orden compartido, tarjetas y revisiones de sync | Críticas: severidad/score/fecha/ID; recientes: fecha/severidad/score/ID. Metadatos no rejuvenecen contenido ni crean incidentes nuevos |
| B | Evaluaciones versionadas e importador, mini medidor accesible y cobertura | Etiquetas con procedencia; sin datos autorizados, sin evaluar; nunca heredar tendencia del descubridor |
| C | Comparación por entidades/tiempo/lugar/tipo, afirmaciones y contradicciones | Origen independiente acreditado; incertidumbre conservada; merge/split auditables |
| D | Situaciones y 24 h sobre bandeja existente, cursor durable y replay | Ráfagas >500, reinicio/ACK perdido, correcciones y cero duplicación por clave; cambiado y ocurrido son ventanas distintas |
| E | Piloto Ucrania/Mar Negro y mar Rojo con admisión gradual | Acceso/cobertura reales, precisión temporal/geográfica, duplicación/latencia medidas; RU/UK con evaluación propia |
| F | Analista asistido, cronologías e impactos | Puerta semántica por tarea; citas/rutas numéricas; correcciones propagadas; probability null sin modelo evaluado |

## Interfaces y pruebas

Añadir metadatos opcionales de transporte, descubrimiento, publisher/origen, resolución, idioma, método, estado de clasificación y alcance textual; ausencia histórica significa desconocido. Mantener contratos de alertas y envelopes. Nuevas lecturas de B–F se incorporan en su lote con permisos, cursores estables y presupuestos de bytes.

Pruebas: AP/Japan/Capitol; RSS source; cinco idiomas; negación/futuro/opinión; identidad sin URL; orden y revisión de metadatos; permisos de contenido; snapshots/paginación concurrentes; replay, ACK perdido y recuperación; modo sin IA; transporte MCP real; móvil/teclado/foco/scroll. Regresiones dirigidas primero; después backend/MCP check/test/build/inventario/audit y git diff --check según alcance. Resultados históricos no son pruebas actuales.

## Puertas y reversión

Núcleo e IA se aceptan por separado. Mantener shadow. Una observación de 24 h requiere candidato identificado, muestras y continuidad; cambiar artefactos abre otra cohorte. Un reinicio prueba recuperación, no continuidad. Medir objetivos de latencia con carga/hardware declarados; no elevar límites para obtener verde.

Reversión lógica: desactivar capacidades nuevas o volver a proyecciones compatibles; conservar las escrituras nuevas y código compatible con esquema vigente. No reemplazar base activa por imagen anterior ni editar migraciones aplicadas. Para C se aplican directamente por autorización del usuario; la verificación de comportamiento posterior usa fixtures. El usuario realizará el backup y controles operativos manualmente.

## Entrega B — contrato ejecutable

Evaluaciones y perfiles se versionan por editor y dominio/edición explícitos. Guardar tiempo de vigencia y de registro; una revisión no modifica filas históricas. Política de tendencia v1 con cinco posiciones ordinales y no aplicable; sin datos, escalas sin normalizar y discrepancias no se sitúan en el centro. No promediar evaluadores ni contextos políticos diferentes. Conservar valor original, método, referencia, licencia, evidencia y revisión.

Importación limitada de operador con dry-run y autorización de redistribución declarada; ningún dataset externo se descarga o incorpora por defecto. Perfiles opcionales de idioma, país editorial y propiedad requieren referencias; desconocidos explícitos. Cobertura cuenta artículos, editores, propietarios y orígenes por separado en ventana recibida; facetas normalizadas y lector de consultas, sin hidratar el corpus al visitar la vista. Los registros pendientes de backfill aparecen como cobertura parcial.

Lecturas públicas de catálogo/detalle de evaluaciones y cobertura con presupuestos, filtros/cortes y paginación estable. Tarjetas consultan catálogo coalescido, sin incrustar evaluaciones actuales en hechos/snapshots históricos. Página Fuentes con metodología y detalle accesibles. Publicar B únicamente tras pruebas/contratos/inventario en commit independiente.

Cierre técnico de B documentado en ESTADO. Matriz inicial e instrucciones de importación en [FUENTES.md](FUENTES.md). No hay dataset político incorporado. La reversión conserva 024 y su conocimiento en el guard de migraciones; no ejecutar un checkout anterior que sólo conozca 023 sobre un esquema 024. Mantener los registros y correcciones append-only.

## Procedimiento histórico de 0.2 — suspendido por D27

Las siguientes acciones de copia/recuperación no constituyen trabajo vigente ni precondición para C/D.

1. Comprobar acceso efectivo y WAL/bloqueos con una base temporal en el destino. El sandbox puede presentar ro aunque la ejecución autorizada fuera de él acceda al HDD; registrar la vía efectiva sin remontar volúmenes.
2. Crear el backup consistente actual, verificar integridad/FK, esquema/checksums y hash. Conservar baseline 022 sin migrar. Un EIO o una copia parcial impiden pasar al siguiente hito; no descartar páginas para obtener una imagen aparentemente válida.
3. Crear otra copia de trabajo, probar 022→024 y comparar checksums previos, conteos, muestras de originales/revisiones e integridad/FK. El esquema operativo permanece intacto.
4. Reproducir status/planes SQL, snapshots, trabajos analíticos y commits. Separar métricas de lectura de las de cola/commit/checkpoint y declarar hardware, caché, ventana, concurrencia e I/O coexistente. Usar writer único y lectores de consulta en las pruebas con runtime aislado; bloquear adquisición/inferencia externas.
5. Verificar las reconciliaciones de heartbeat y reanudación por owner/fence y recibo durable. Clasificar por separado errores semánticos, lease, lector y escritor; una latencia no demuestra su causa física.

Durante una copia o verificación se pueden preparar scripts, consultas, cohortes y documentación de estos hitos. Las mediciones de latencia que coincidan con I/O masiva deben declararlo y no compararse como ensayos sin contención. No repetir suites cerradas sin cambio o fallo y no iniciar otra entrega por el mero transcurso de una espera. La situación concreta y el siguiente paso están en ESTADO.

## Incidente de integridad del origen durante 0.2

El kernel identifica un checksum Btrfs fallido dentro del archivo SQLite activo; el destino HDD pasó pruebas temporales. Este incidente impide aceptar un backup actual y no se corrige alterando permisos, leases o límites. No atribuir automáticamente al SSD una avería ni relacionarlo con el OOM de llama-server sin pruebas.

La preparación de recuperación conserva tres fuentes distintas: original sin modificar, respaldo histórico con su fecha/cobertura, e imagen parcial de análisis con mapa de páginas desconocidas. La imagen parcial nunca es baseline, copia migrable ni evidencia de aceptación operativa. Las validaciones pendientes y sus procesos/logs se registran en ESTADO.

Antes de una recuperación utilizable: identificar el objeto afectado. Si sólo hay estructura derivada de índices, reconstruirla únicamente en otra copia y demostrar conservación de tablas, IDs, rowids referenciados, revisiones y contenido. Si afecta a filas u overflow, investigar redundancia documental/archivo y cuantificar todo lo no recuperable; no sustituirlo por ceros o por datos antiguos como si fueran actuales. Un informe de pérdida/ambigüedad mantiene cerrada la sustitución operativa y requiere una decisión explícita del usuario. Una restauración o puesta en servicio no queda autorizada por crear imágenes de diagnóstico.

Mientras se verifican los datos se pueden completar hitos independientes de 0.2, como trazabilidad de reconciliaciones. El cambio local de renewalId es observable y evaluado por separado; no convierte en demostrada una correlación histórica que no quedó registrada. Nuevos cambios de código requieren nueva identidad de candidato antes de cualquier observación continua.

## Cambio de alcance vigente para C

El usuario autoriza C y aplicar las migraciones necesarias sobre la base referenciada en .env sin backup ni integridad previa como condición. Suspender el trabajo de copias/recuperación. Preservar datos, writer único y migraciones aditivas. El diagnóstico de corrupción queda como limitación conocida, no como condición para detener el desarrollo de C. Verificar comportamiento de código después de aplicar el esquema; no presentar legibilidad parcial como integridad global. D se prepara en documentos y no se considera implementada por disponer del cursor de C.


## Cierre técnico C y entrada D

C incorpora grupos de cobertura candidata, afirmaciones extractivas trazables, relaciones revisadas y merge/split/origen auditables. No se redefine EventLedger ni los clusters como incidentes verificados. Contrato 1.11.0; cinco operaciones; 025 aplicada directamente a la base configurada. Los casos de aceptación y resultados reales se concentran en ESTADO.md.

D comienza en [ENTREGA-D.md](ENTREGA-D.md). Reutilizar el registro `news_comparison_changes` con corte estable, asignaciones/versiones históricas y el escritor/mantenimiento/bandeja existentes. Pendientes: cursor del consumidor y avance transaccional, revisión durable de awareness, dominio de incidentes/situaciones, emisión idempotente y correcciones. No confundir el cursor de lectura C con un checkpoint/ACK de D. Próxima migración disponible: 026.


## Estado después de recuperar la base

Recuperación exacta y selección operativa completadas, sin pérdida de registros; fuente y pruebas en [RECUPERACION.md](RECUPERACION.md). .env selecciona la base reparada con esquema 025. Los procedimientos históricos de copias/forense quedan cerrados y no son el siguiente paso. Backend detenido, dependencias operativas sin alinear, backfill de A/B/C pendiente y puertas operativa/IA abiertas. La ruta hasta cerrar todas las entregas está en [CIERRE-FINAL.md](CIERRE-FINAL.md); siguiente lote de producto D.1.


## Cierre C y orden de la siguiente ejecución

Cierre y publicación C autorizados y verificados según [CIERRE-C.md](CIERRE-C.md), con backend completo 1071/1071, MCP 32/32 y auditorías correctas. Se incluye renovación de diagnósticos previa y documentación de recuperación; no configuración, bases ni artefactos privados. El piloto real hizo rollback: no implica históricos poblados.

No ejecutar 2–4 como tres bloques completos antes de nuevas funciones. Hacer primero el lote operativo acotado del punto 2 (instalaciones alineadas y enriquecimiento con cursor), aplicar el punto 3 a cada entrega, desarrollar D/E/F y cerrar el punto 4 sobre el candidato final. El adaptador MCP está activo y necesita reconexión coordinada para npm ci. Detalle de procedencia/versiones y aceptación: CIERRE-FINAL.md.
