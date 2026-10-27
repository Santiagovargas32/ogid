# OGID: implementación por entregas

Versión 5, 27/10/2026: A–D implementadas y publicadas; última ejecución D y cierre documentados. Estado operativo y siguientes acciones en ESTADO.md. Fuente: [diagnóstico](../../OGID-diagnostico-direccion-y-plan-2026-10-25.md). Entrada de reanudación: [ESTADO.md](ESTADO.md).

## Dirección y alcance autorizado

Evolucionar hacia situaciones, afirmaciones y evidencias trazables conservando RSS, archivo, mercados, SQLite, dashboard y MCP. A/B/C y el cierre de instalaciones/enriquecimiento del 26/10 están publicados. **D está implementada y publicada en df50aae**, con pruebas y arranque/UI/MCP reales; no es un handoff pendiente. Su capacidad con adquisición concurrente y la aceptación global siguen abiertas. La sesión vigente autoriza actualizar documentación, no empezar E/F ni arreglar código por inferencia.

Secuencia acordada: **D → E → F → validación final**, con pruebas durante cada entrega. Antes de ampliar el piloto E, se recomienda un lote operativo acotado D/0.2 para el backlog del consumidor y los rechazos del correlador observados. Es una continuación de integración, no reiniciar el plan. La recuperación ya terminó; el usuario mantiene el backup manual y autorizó migraciones aditivas directas sin condicionar cada lote a otro backup/integridad previa. No retomar copias/forense. Arranque, publicación y promoción conservan su autorización específica; los prompts históricos son referencias.

Invariantes: un escritor de negocio; lectores readonly/query_only; red/inferencia/cálculo largo fuera del escritor y HTTP; límites y guardias intactos; migraciones aditivas; históricos, IDs, aliases y snapshots congelados conservados. Arranque exclusivamente con `cd backend && npm start`, hijos gobernados por `.env`, conservar llama.cpp. Desconocido no implica neutralidad, ausencia de incidentes ni corroboración. Sindicación y publicaciones de IA no acreditan orígenes independientes.

## Lotes y aceptación

| Lote | Resultado | Aceptación / dependencia |
|---|---|---|
| DOC | PLAN, ESTADO, DECISIONES y PROMPTS, excepciones concretas en gitignore y nota de memoria | Reanudar desde ESTADO sin depender del chat; sin secretos ni logs versionados |
| 0.1 | Informe reproducible v19, manifiesto de código/lock/instalación/Node/contrato y verificación de esquema/backup | Artefacto reconstruible, diferencias de instalación visibles; esquema efectivo identificado; precondición de copia revocada para C por D27 |
| 0.2 | Reproducciones de status, snapshots, análisis y commits; consultas acotadas y reconciliación | Reproducciones y mediciones con cohortes declaradas; limitaciones reales mantienen cerrada puesta en servicio; no atribuir causalidad física sin evidencia |
| 0.3 | Mantenimiento determinista independiente de AGENT_MODE y navegador | Con modelo desconectado progresan adquisición y trabajo determinista; mismos temporizadores/coordinación |
| A.1 | Identidad editorial y metadatos por todo el flujo, enriquecimiento paginado reanudable | AP exacto; Google es descubrimiento; publisher candidato/desconocido explícito; ID/URL/alias/revisiones conservados |
| A.2 | Clasificación común Unicode EN/ES/FR/DE/PT, modalidad y suficiencia | Distinguir ataque/huelga, negación/futuro/opinión; idioma no soportado no equivale a low |
| A.3 | Orden compartido, tarjetas y revisiones de sync | Críticas: severidad/score/fecha/ID; recientes: fecha/severidad/score/ID. Metadatos no rejuvenecen contenido ni crean incidentes nuevos |
| B | Evaluaciones versionadas e importador, mini medidor accesible y cobertura | Etiquetas con procedencia; sin datos autorizados, sin evaluar; nunca heredar tendencia del descubridor |
| C | Comparación heurística por referencias, tiempo/lugar/tipo; afirmaciones extractivas y relaciones atribuidas | Sindicación e IDs de origen no acreditan independencia; incertidumbre conservada y merge/split auditables |
| D | Situaciones/bandeja, cursor durable y replay implementados; capacidad operativa pendiente | Ráfagas >500, reinicio/ACK perdido, correcciones y cero duplicación por clave; cambiado y ocurrido son ventanas distintas |
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

Lecturas públicas de catálogo/detalle de evaluaciones y cobertura con presupuestos, filtros/cortes y paginación estable. Tarjetas consultan catálogo coalescido, sin incrustar evaluaciones actuales en hechos/snapshots históricos. Página Fuentes con metodología y detalle accesibles. B se publicó en su commit independiente tras esas pruebas/contratos/inventario.

Cierre técnico de B documentado en ESTADO. Matriz inicial e instrucciones de importación en [FUENTES.md](FUENTES.md). No hay dataset político incorporado. La reversión conserva 024 y su conocimiento en el guard de migraciones; no ejecutar un checkout anterior que sólo conozca 023 sobre un esquema 024. Mantener los registros y correcciones append-only.

## Estado operativo y secuencia vigente

Base reparada seleccionada por .env, **esquema efectivo 029**; 001–029 inmutables y siguiente número libre 030. Original dañado preservado; no reactivarlo. Código **df50aae**, contrato **1.12.0**, 98 rutas/107 operaciones. D se describe en [CIERRE-D.md](CIERRE-D.md); [ENTREGA-D.md](ENTREGA-D.md) es su diseño previo, conservado como referencia.

La última ejecución PID 988930 está cerrada: un SIGTERM al principal, sin errores de limpieza ni persistencia sin confirmar. Hay **backlog durable D** y costes/rechazos reales; leer [EJECUCION-D-2026-10-27.md](EJECUCION-D-2026-10-27.md) y no reutilizar el «sin pendientes» del smoke anterior. Las cifras de 146.475 noticias enriquecidas y desconocidos del punto 2 son un baseline fechado, no el tamaño actual.

Próximos bloques: integración D/0.2 acotada cuando se autorice código; **E** con registro/perfiles/enriquecimiento permitido y piloto Ucrania/Mar Negro + mar Rojo; **F** con síntesis/cronologías/impactos sobre evidencia elegible. Evaluaciones políticas B requieren registros documentados y permisos; adquirir noticias no las calcula automáticamente. La ausencia de dataset conserva «sin evaluar» y no bloquea E.

Pruebas progresivas por entrega y 24 h continuas sólo sobre el candidato final identificado; IA shadow hasta superar su puerta semántica separada. El observador D tuvo 71 muestras (~1 h 10 min 40 s) y terminó interrumpido. No se ha satisfecho la puerta formal.
