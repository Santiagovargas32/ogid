# OGID: implementación por entregas

Versión 4: C publicada; cierre del punto 2 autorizado el 26/10/2026. Fuente: [diagnóstico](../../OGID-diagnostico-direccion-y-plan-2026-10-25.md). Entrada de reanudación: [ESTADO.md](ESTADO.md).

## Dirección y alcance autorizado

Evolucionar hacia situaciones, afirmaciones y evidencias trazables conservando RSS, archivo, mercados, SQLite, dashboard y MCP. A/B/C están implementadas y publicadas en commits separados; C=40a027d, CI correcta. El **punto 2 está cerrado**: instalaciones compatibles actualizadas y enriquecimiento A/B/C completo antes de D/E/F. D recibe el handoff ENTREGA-D.md y se ejecutará con alcance propio. La recuperación ya está cerrada; el usuario asume backup manual y autoriza las migraciones necesarias directamente sobre .env sin condición de backup/test previo. No retomar copias/forense. Arranque de servidor, despliegue y promoción visible conservan su alcance operativo. Los prompts históricos son referencias.

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

Lecturas públicas de catálogo/detalle de evaluaciones y cobertura con presupuestos, filtros/cortes y paginación estable. Tarjetas consultan catálogo coalescido, sin incrustar evaluaciones actuales en hechos/snapshots históricos. Página Fuentes con metodología y detalle accesibles. B se publicó en su commit independiente tras esas pruebas/contratos/inventario.

Cierre técnico de B documentado en ESTADO. Matriz inicial e instrucciones de importación en [FUENTES.md](FUENTES.md). No hay dataset político incorporado. La reversión conserva 024 y su conocimiento en el guard de migraciones; no ejecutar un checkout anterior que sólo conozca 023 sobre un esquema 024. Mantener los registros y correcciones append-only.

## Estado operativo y secuencia vigente

La recuperación exacta terminó y .env selecciona ogid-repaired-20261026-183735.sqlite, esquema 025. Original dañado preservado; no reactivarlo ni reiniciar copias de 0.2. Los procedimientos históricos se conservan como referencia en HISTORICO-CONTINUIDAD.md y RECUPERACION.md, no como precondición de desarrollo.

C publicada: 40a027d; CI correcta; código verificado 1071/1071 backend y 32/32 MCP en su corte. El punto 2 está cerrado: instalaciones backend/MCP actualizadas (0 discrepancias, auditorías 0), 146.475 noticias enriquecidas y conservación verificada con el escritor actual. No es otro proveedor ni requiere inferencia. ESTADO.md conserva el resultado y la siguiente acción.

Con punto 2 cerrado, la siguiente implementación es D.1 desde ENTREGA-D.md: cursor y efectos/outbox transaccionales, stream awareness y dominio de incidentes/situaciones; después D.3, E y F. Aplicar pruebas integradas con cada entrega. Las 24 h y la evaluación semántica IA se hacen sobre el candidato final identificado, con puertas separadas. No abrirlas mientras sus artefactos sigan cambiando.

El consumidor D debe distinguir indexación de noticias antiguas de incidentes nuevos: el backfill crea entradas históricas reales en news_comparison_changes. Su cursor de lectura C no es un ACK durable del consumidor. Próxima migración disponible 026; no editar las ya aplicadas.
