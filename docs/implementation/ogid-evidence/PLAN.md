# OGID: implementación por entregas

Versión 2: continuación B autorizada; base v1 aprobada el 26/10/2026. Fuente: [diagnóstico](../../OGID-diagnostico-direccion-y-plan-2026-10-25.md). Entrada de reanudación: [ESTADO.md](ESTADO.md).

## Dirección y alcance autorizado

Evolucionar hacia situaciones, afirmaciones y evidencias trazables conservando RSS, archivo, mercados, SQLite, dashboard y MCP. El ciclo inicial comprende 0 y A. El usuario autorizó después el cierre de A y la implementación/publicación de B en commits separados de la misma rama. C–F permanecen en hoja de ruta. Despliegue, arranque operativo y promoción visible requieren alcance operativo propio. Los prompts históricos de otros documentos son referencias, no órdenes adicionales.

Invariantes: un escritor de negocio; lectores readonly/query_only; red/inferencia/cálculo largo fuera del escritor y HTTP; límites y guardias intactos; migraciones aditivas; históricos, IDs, aliases y snapshots congelados conservados. Arranque exclusivamente con `cd backend && npm start`, hijos gobernados por `.env`, conservar llama.cpp. Desconocido no implica neutralidad, ausencia de incidentes ni corroboración. Sindicación y publicaciones de IA no acreditan orígenes independientes.

## Lotes y aceptación

| Lote | Resultado | Aceptación / dependencia |
|---|---|---|
| DOC | PLAN, ESTADO, DECISIONES y PROMPTS, excepciones concretas en gitignore y nota de memoria | Reanudar desde ESTADO sin depender del chat; sin secretos ni logs versionados |
| 0.1 | Informe reproducible v19, manifiesto de código/lock/instalación/Node/contrato y verificación de esquema/backup | Artefacto reconstruible, diferencias de instalación visibles; copia consistente antes de migraciones |
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

Reversión lógica: desactivar capacidades nuevas o volver a proyecciones compatibles; conservar las escrituras nuevas y código compatible con esquema vigente. Backup con API consistente, nunca reemplazar base activa por imagen anterior ni editar migraciones aplicadas. Las migraciones se prueban en copia con checksums previos, conteos, integridad y FK.

## Entrega B — contrato ejecutable

Evaluaciones y perfiles se versionan por editor y dominio/edición explícitos. Guardar tiempo de vigencia y de registro; una revisión no modifica filas históricas. Política de tendencia v1 con cinco posiciones ordinales y no aplicable; sin datos, escalas sin normalizar y discrepancias no se sitúan en el centro. No promediar evaluadores ni contextos políticos diferentes. Conservar valor original, método, referencia, licencia, evidencia y revisión.

Importación limitada de operador con dry-run y autorización de redistribución declarada; ningún dataset externo se descarga o incorpora por defecto. Perfiles opcionales de idioma, país editorial y propiedad requieren referencias; desconocidos explícitos. Cobertura cuenta artículos, editores, propietarios y orígenes por separado en ventana recibida; facetas normalizadas y lector de consultas, sin hidratar el corpus al visitar la vista. Los registros pendientes de backfill aparecen como cobertura parcial.

Lecturas públicas de catálogo/detalle de evaluaciones y cobertura con presupuestos, filtros/cortes y paginación estable. Tarjetas consultan catálogo coalescido, sin incrustar evaluaciones actuales en hechos/snapshots históricos. Página Fuentes con metodología y detalle accesibles. Publicar B únicamente tras pruebas/contratos/inventario en commit independiente.

Cierre técnico de B documentado en ESTADO. Matriz inicial e instrucciones de importación en [FUENTES.md](FUENTES.md). No hay dataset político incorporado. La reversión conserva 024 y su conocimiento en el guard de migraciones; no ejecutar un checkout anterior que sólo conozca 023 sobre un esquema 024. Mantener los registros y correcciones append-only.
