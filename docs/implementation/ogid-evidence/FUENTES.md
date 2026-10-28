# Fuentes, perfiles, evaluaciones y cobertura — B/E

Actualizado el **28/10/2026**. Matriz diseñada el 26/10; piloto E pendiente. Estado en [ESTADO.md](ESTADO.md); últimas ejecuciones D2/D3 y cobertura conocida en [RESUMEN-ACTUAL-2026-10-28.md](RESUMEN-ACTUAL-2026-10-28.md). EJECUCION-D-2026-10-27 conserva la cohorte anterior PID 988930. Fuente de verdad del catálogo: `backend/services/news/newsSourceCatalog.js`; consultar `news.source-coverage` y `/sources.html` para las ventanas actuales. No constituye una auditoría de acceso ni cobertura operativa.

| Ámbito | Base configurada | Idiomas / perspectivas | Carencia que debe medir E |
|---|---|---|---|
| Ucrania / mar Negro | Consultas existentes Ukraine, Russia y Black Sea | Locale e idioma declarados por el catálogo; no acreditan idioma de cada ítem | Reporterías locales, RU/UK, agencias con origen directo, fuentes oficiales atribuidas, observatorios y latencia |
| Mar Rojo | Consultas existentes Red Sea y Yemen | Mismo límite del catálogo; no es diversidad editorial comprobada | Reporterías locales, árabe y otras lenguas según acceso, navegación/autoridades/organismos y origen de los reportes |
| Transversal | RSS editoriales y descubrimiento existentes | Cinco idiomas de clasificación A; otros explícitamente pendientes/no soportados | Ediciones y perspectivas documentadas, propiedad, política de acceso y salud por fuente |

Los recuentos de consultas e idiomas declarados se calculan desde el catálogo; los de publicaciones, editores, idiomas observados y menciones de países, desde facetas del archivo anterior a selección editorial. Las menciones no son coordenadas ni incidentes confirmados. Los países editoriales provienen sólo de perfiles con referencias y pueden atribuir un artículo a varios países. Las ventanas se refieren a recepción. El backfill sólo hace parcial la cobertura mientras siga pendiente; su estado vigente está en ESTADO.md. Completarlo no demuestra ausencia de sucesos ni cobertura periodística exhaustiva.

D3 incorporó 10.692 publicaciones nuevas para la base y ésta alcanzó 163.334 artículos; algunas incorporaciones tienen fecha de publicación antigua. No es cobertura completa de noticias nuevas ni una medición del piloto E. El baseline A/B/C está enriquecido; desconocidos de editor/idioma no se han recalculado para ese total.

Separar previstos/configurados, habilitados, consultados con éxito y sanos. B muestra los dos primeros y deja la salud operativa como no medida en esta vista. E deberá unir métricas del scheduler y muestras de adquisición para acreditar los otros dos; no asignar `healthy` por existir en el catálogo.

Evaluaciones políticas: ningún dataset real incorporado. Los dominios del registro identifican ediciones, no una posición. Propiedad, países e idiomas editoriales quedan desconocidos hasta importar perfiles documentados. Cadenas de origen desconocidas no se cuentan como independientes.

## Importación de operador

Usar `ogid_operator` con `operationId: news.source-assessments.import`, credencial de alcance `news:assessments:write` y el cuerpo descrito en el inventario generado API-MCP. El cuerpo requiere un `requestId` nuevo y `permission` con base (`self-authored`, `licensed` o `permission`), referencia y `redistributionAllowed: true`. Esa declaración no sustituye comprobar los derechos del dataset concreto.

Primero omitir `dryRun` o usar `true`. Revisar la previsualización y confirmar con otro `requestId`, los mismos registros y `dryRun: false`. No reutilizar el ID del preview: el recibo durable conserva el resultado asociado al cuerpo. Máximo 25 evaluaciones y 25 perfiles / 64 KiB; revisiones consecutivas e inmutables. Retirar o corregir mediante una revisión nueva, conservando la anterior. No se descargan las referencias durante la importación.

Cada evaluación conserva editor/edición exactos, evaluador, ámbito político, método/versionado, etiqueta original, mapeo y escala, fecha de evaluación, vigencia, evidencia y licencia. `external-unmapped` mantiene un valor sin posición; `political-five-v1` es ordinal y no se promedia. Una corrección vencida no revive la versión sustituida. `asOf` corta vigencia, `knownAt` conocimiento registrado; por defecto ambos coinciden.

`news.source-assessments` devuelve resúmenes; `view=records` pagina todas las evaluaciones efectivas con referencias. Continuar con el cursor y los mismos filtros. `news.source-assessment` permite consultar una revisión concreta. La página Fuentes muestra procedencia, contexto y condiciones declaradas; los metadatos de tendencia se consultan aparte y no reescriben artículos ni snapshots históricos.


## Qué se actualiza automáticamente y qué requiere datos explícitos

El código de adquisición normaliza y archiva noticias, resuelve el editor mediante registro/aliases exactos/dominios/metadata admitida cuando hay evidencia suficiente, clasifica el artículo y actualiza facetas/comparaciones/journal. D consume cambios y conserva evidencias, situaciones candidatas y revisiones. **No hay un disparador de evaluación política por cantidad de noticias ni un analizador automático de tendencia del medio implementado.** La IA shadow actual tampoco alimenta este registro de ratings.

En el corte readonly **27/10/2026 13:32:33 UTC**, `news_source_assessments=0` y `news_publisher_profiles=0`; esos recuentos no se recalcularon en la revisión D3. Por ello identificar Reuters y edición reuters.com conserva «sin evaluar», propietario/países/idiomas desconocidos. «23publicaciones» en una vista era un recuento de su ventana de recepción, no tamaño de muestra mínimo ni evaluación lanzada. Estos datos no impiden adquirir noticias ni mostrar sus identidades/clasificaciones.

- **Identidad del editor/edición:** la edición de esta versión es el dominio explícito del registro; no equivale a edición geográfica o idioma inferidos. Reconocer el dominio permite asociar registros, no atribuir una posición política.
- **Perfil documentado:** propietario/grupo, países editoriales e idiomas del medio con referencias y fecha de revisión. Se importa separado del rating; el idioma de artículos observados y las menciones de países no rellenan estos campos por sí solos.
- **Evaluación:** externa con uso permitido o elaboración propia documentada. Conserva evaluador, ámbito político, metodología/versiones, etiqueta original/mapeo/escala, evidencia, licencia y fechas. No se incorpora ningún proveedor de ratings por defecto ni se descargan/validan automáticamente sus referencias.

## Cómo aparece una tendencia y qué significan los filtros

1. Preparar evaluación/perfil documentados para editor/edición exactos y registrar permiso de uso declarado. Un operador con `news:assessments:write` envía la importación de hasta 25 evaluaciones / 25 perfiles, máximo 64 KiB.
2. Ejecutar previsualización (`dryRun:true`, por defecto), revisar el resultado y confirmar con **otro requestId** y `dryRun:false`. Revisiones consecutivas e inmutables; una nueva versión corrige/retira sin reescribir la anterior. El importador valida estructura/fechas/referencias y conserva la declaración de derechos; no certifica jurídicamente la licencia ni la corrección del juicio.
3. Refrescar la lectura en Fuentes o la caché de tarjetas. La consulta no analiza noticias ni llama al modelo. Un catálogo antiguo de chat puede requerir refrescar su conexión para ver `news.source-assessments.import`.

Filtros efectivos: publisher/edition y politicalScope si se pide, vigencia `validFrom <= asOf < validUntil` (sin final es abierta), registro conocido `recordedAt <= knownAt`, última revisión efectiva y estado publicado para el resumen de tendencia. `view=records` conserva también la procedencia de una retirada efectiva. Los cursores fijan los cortes y el techo de revisiones; no mezclar filtros entre páginas.

«Corte de vigencia y conocimiento» fecha la consulta reproducible; **no es la hora de ejecutar una evaluación**. «No hay evaluaciones autorizadas para este corte y filtro» indica ausencia de registros efectivos, no evaluación en cola. «Autorizadas» remite a la importación y uso declarados; no representa certificación automática de neutralidad/veracidad. Para un perfil, verifiedAt y recordedAt también condicionan qué se conoce en ese corte.

Sin datos se muestra sin evaluar; con evaluadores en desacuerdo, contextos diferentes, etiqueta no aplicable, escala sin equivalencia o lectura parcial se conserva ese estado. No promediar ni ubicar lo desconocido en el centro. Una tendencia del medio no evalúa cada artículo ni prueba los hechos que afirma. Esta política corresponde a `source-assessments-v1` y al importador implementado; automatizar un cálculo político sería otra función que necesita metodología y evaluación propias.
