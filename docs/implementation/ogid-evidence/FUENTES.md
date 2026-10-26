# Matriz inicial de fuentes y cobertura — B

Fecha de diseño: 26/10/2026. Fuente de verdad del catálogo: `backend/services/news/newsSourceCatalog.js`; consultar `news.source-coverage` y `/sources.html` para las ventanas actuales. No constituye una auditoría de acceso ni cobertura operativa.

| Ámbito | Base configurada | Idiomas / perspectivas | Carencia que debe medir E |
|---|---|---|---|
| Ucrania / mar Negro | Consultas existentes Ukraine, Russia y Black Sea | Locale e idioma declarados por el catálogo; no acreditan idioma de cada ítem | Reporterías locales, RU/UK, agencias con origen directo, fuentes oficiales atribuidas, observatorios y latencia |
| Mar Rojo | Consultas existentes Red Sea y Yemen | Mismo límite del catálogo; no es diversidad editorial comprobada | Reporterías locales, árabe y otras lenguas según acceso, navegación/autoridades/organismos y origen de los reportes |
| Transversal | RSS editoriales y descubrimiento existentes | Cinco idiomas de clasificación A; otros explícitamente pendientes/no soportados | Ediciones y perspectivas documentadas, propiedad, política de acceso y salud por fuente |

Los recuentos de consultas e idiomas declarados se calculan desde el catálogo; los de publicaciones, editores, idiomas observados y menciones de países, desde facetas del archivo anterior a selección editorial. Las menciones no son coordenadas ni incidentes confirmados. Los países editoriales provienen sólo de perfiles con referencias y pueden atribuir un artículo a varios países. Las ventanas se refieren a recepción. El backfill sólo hace parcial la cobertura mientras siga pendiente; su estado vigente está en ESTADO.md. Completarlo no demuestra ausencia de sucesos ni cobertura periodística exhaustiva.

Separar previstos/configurados, habilitados, consultados con éxito y sanos. B muestra los dos primeros y deja la salud operativa como no medida en esta vista. E deberá unir métricas del scheduler y muestras de adquisición para acreditar los otros dos; no asignar `healthy` por existir en el catálogo.

Evaluaciones políticas: ningún dataset real incorporado. Los dominios del registro identifican ediciones, no una posición. Propiedad, países e idiomas editoriales quedan desconocidos hasta importar perfiles documentados. Cadenas de origen desconocidas no se cuentan como independientes.

## Importación de operador

Usar `ogid_operator` con `operationId: news.source-assessments.import`, credencial de alcance `news:assessments:write` y el cuerpo descrito en el inventario generado API-MCP. El cuerpo requiere un `requestId` nuevo y `permission` con base (`self-authored`, `licensed` o `permission`), referencia y `redistributionAllowed: true`. Esa declaración no sustituye comprobar los derechos del dataset concreto.

Primero omitir `dryRun` o usar `true`. Revisar la previsualización y confirmar con otro `requestId`, los mismos registros y `dryRun: false`. No reutilizar el ID del preview: el recibo durable conserva el resultado asociado al cuerpo. Máximo 25 evaluaciones y 25 perfiles / 64 KiB; revisiones consecutivas e inmutables. Retirar o corregir mediante una revisión nueva, conservando la anterior. No se descargan las referencias durante la importación.

Cada evaluación conserva editor/edición exactos, evaluador, ámbito político, método/versionado, etiqueta original, mapeo y escala, fecha de evaluación, vigencia, evidencia y licencia. `external-unmapped` mantiene un valor sin posición; `political-five-v1` es ordinal y no se promedia. Una corrección vencida no revive la versión sustituida. `asOf` corta vigencia, `knownAt` conocimiento registrado; por defecto ambos coinciden.

`news.source-assessments` devuelve resúmenes; `view=records` pagina todas las evaluaciones efectivas con referencias. Continuar con el cursor y los mismos filtros. `news.source-assessment` permite consultar una revisión concreta. La página Fuentes muestra procedencia, contexto y condiciones declaradas; los metadatos de tendencia se consultan aparte y no reescriben artículos ni snapshots históricos.
