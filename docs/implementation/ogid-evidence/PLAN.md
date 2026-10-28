# OGID: implementación por entregas

Versión 7, 28/10/2026: A–D integradas; lote D/0.2 local sobre c19ac4b, IA off, reconciliación y cierre verificables. [CIERRE-D02.md](CIERRE-D02.md) distingue fixtures, host y bloqueos. E/F no iniciadas. Fuente: [diagnóstico](../../OGID-diagnostico-direccion-y-plan-2026-10-25.md). Entrada de reanudación: [ESTADO.md](ESTADO.md).

## Dirección y alcance autorizado

Evolucionar hacia situaciones, afirmaciones y evidencias trazables conservando RSS, archivo, mercados, SQLite, dashboard y MCP. A/B/C y el cierre de instalaciones/enriquecimiento del 26/10 están publicados. **D inicial se publicó en df50aae**, con pruebas y backend/UI/MCP reales; mantenimiento/correlador y ajuste **124050a** completan el código publicado. La sesión vigente autoriza L0–L3 de D/0.2, incluidas operación corta y pausa local; excluye publicación, merge, despliegue, promoción, E/F y observación formal de 24 h. La espera E/S se reproduce con IA off; aceptación global abierta.

Secuencia acordada: **D → E → F → validación final**, con pruebas durante cada entrega. Antes de ampliar E, se recomienda un lote D/0.2 focalizado en espera de E/S, persistencia de mercado y reanudación tras D3. El backlog está drenado y el rechazo de tamaño del correlador no se reproduce en D2/D3; no tratarlos como defectos actuales sin evidencia nueva. Es una continuación de integración, no reiniciar el plan. La recuperación ya terminó; el usuario mantiene el backup manual y autorizó migraciones aditivas directas sin condicionar cada lote a otro backup/integridad previa. No retomar copias/forense. Arranque, publicación y promoción conservan su autorización específica; los prompts históricos son referencias.

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
| D | Situaciones/bandeja, cursor durable y replay integrados; puesta al día bajo adquisición comprobada D3; estabilidad pendiente | Ráfagas >500, reinicio/ACK perdido, correcciones y cero duplicación por clave; cambiado y ocurrido son ventanas distintas |
| E | Piloto Ucrania/Mar Negro y mar Rojo con admisión gradual | Acceso/cobertura reales, precisión temporal/geográfica, duplicación/latencia medidas; RU/UK con evaluación propia |
| F | Analista asistido, cronologías e impactos | Puerta semántica por tarea; citas/rutas numéricas; correcciones propagadas; probability null sin modelo evaluado |

## Interfaces y pruebas

Añadir metadatos opcionales de transporte, descubrimiento, publisher/origen, resolución, idioma, método, estado de clasificación y alcance textual; ausencia histórica significa desconocido. Mantener contratos de alertas y envelopes. Nuevas lecturas de B–F se incorporan en su lote con permisos, cursores estables y presupuestos de bytes.

Pruebas: AP/Japan/Capitol; RSS source; cinco idiomas; negación/futuro/opinión; identidad sin URL; orden y revisión de metadatos; permisos de contenido; snapshots/paginación concurrentes; replay, ACK perdido y recuperación; modo sin IA; transporte MCP real; móvil/teclado/foco/scroll. Regresiones dirigidas primero; después backend/MCP check/test/build/inventario/audit y git diff --check según alcance. Resultados históricos no son pruebas actuales.

## Puertas y reversión

Núcleo e IA se aceptan por separado. **D/0.2 conserva IA off**; reactivar shadow requiere alcance posterior. Una observación de 24 h requiere candidato identificado, muestras y continuidad; cambiar artefactos abre otra cohorte. Un reinicio prueba recuperación, no continuidad. Medir objetivos de latencia con carga/hardware declarados; no elevar límites para obtener verde.

Reversión lógica: desactivar capacidades nuevas o volver a proyecciones compatibles; conservar las escrituras nuevas y código compatible con esquema vigente. No reemplazar base activa por imagen anterior ni editar migraciones aplicadas. Para C se aplican directamente por autorización del usuario; la verificación de comportamiento posterior usa fixtures. El usuario realizará el backup y controles operativos manualmente.

## Entrega B — contrato ejecutable

Evaluaciones y perfiles se versionan por editor y dominio/edición explícitos. Guardar tiempo de vigencia y de registro; una revisión no modifica filas históricas. Política de tendencia v1 con cinco posiciones ordinales y no aplicable; sin datos, escalas sin normalizar y discrepancias no se sitúan en el centro. No promediar evaluadores ni contextos políticos diferentes. Conservar valor original, método, referencia, licencia, evidencia y revisión.

Importación limitada de operador con dry-run y autorización de redistribución declarada; ningún dataset externo se descarga o incorpora por defecto. Perfiles opcionales de idioma, país editorial y propiedad requieren referencias; desconocidos explícitos. Cobertura cuenta artículos, editores, propietarios y orígenes por separado en ventana recibida; facetas normalizadas y lector de consultas, sin hidratar el corpus al visitar la vista. Los registros pendientes de backfill aparecen como cobertura parcial.

Lecturas públicas de catálogo/detalle de evaluaciones y cobertura con presupuestos, filtros/cortes y paginación estable. Tarjetas consultan catálogo coalescido, sin incrustar evaluaciones actuales en hechos/snapshots históricos. Página Fuentes con metodología y detalle accesibles. B se publicó en su commit independiente tras esas pruebas/contratos/inventario.

Cierre técnico de B documentado en ESTADO. Matriz inicial e instrucciones de importación en [FUENTES.md](FUENTES.md). No hay dataset político incorporado. La reversión conserva 024 y su conocimiento en el guard de migraciones; no ejecutar un checkout anterior que sólo conozca 023 sobre un esquema 024. Mantener los registros y correcciones append-only.

## Checkpoint operativo D3 y secuencia histórica anterior a D/0.2

Base reparada seleccionada por .env, **esquema efectivo 029**; 001–029 inmutables y siguiente número libre 030. Original dañado preservado; no reactivarlo. Código actual **124050a** sobre mantenimiento 4bf31a6 y correlador c5c1ea0; D inicial **df50aae**, contrato **1.12.0**, 98 rutas/107 operaciones. D se describe en [CIERRE-D.md](CIERRE-D.md); [ENTREGA-D.md](ENTREGA-D.md) es su diseño previo, conservado como referencia.

La última ejecución **D3 PID 1047352** acabó automáticamente el 28/10 a las 18:15:31 UTC por espera del escritor en commit/Btrfs, con dos fases de persistencia sin confirmar. Cursores posteriores **240.462/240.462 news y 3.813/3.813 awareness**. Base con **163.334** artículos. D inicial/PID 988930 en [EJECUCION-D-2026-10-27.md](EJECUCION-D-2026-10-27.md) es un corte histórico; D2/D3 y límites están en el resumen del 28/10. Las 146.475 noticias enriquecidas y desconocidos del punto 2 siguen siendo un baseline, no recuentos actuales.

Próximos bloques: E/S/persistencia/reanudación D/0.2 cuando se autorice código; **E** con registro/perfiles/enriquecimiento permitido y piloto Ucrania/Mar Negro + mar Rojo; **F** con síntesis/cronologías/impactos sobre evidencia elegible. Evaluaciones políticas B requieren registros documentados y permisos; adquirir noticias no las calcula automáticamente. La ausencia de dataset conserva «sin evaluar» y no bloquea E.

Pruebas progresivas por entrega y 24 h continuas sólo sobre el candidato final identificado; IA shadow hasta superar su puerta semántica separada. El observador inicial D tuvo 71 muestras y terminó interrumpido. D3 completó 61 muestras/una hora; el backend continuó unas 23 h 16 min y acabó con error. Ninguna de esas ventanas satisface la puerta formal.
