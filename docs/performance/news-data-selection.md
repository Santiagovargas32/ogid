# Noticias mostradas, corpus de análisis y bases SQLite

Revisión del 13 de octubre de 2026 sobre main `312dbf3`, con cambios en `fix/live-news-100-and-data-audit`. Se inspeccionaron las bases mediante conexiones de sólo lectura. No se movieron datos ni se cambió `STORAGE_DB_PATH`.

## Live News Feed: límite configurable, 100 por defecto

`NEWS_DISPLAY_LIMIT=100` define la selección del backend y es el nuevo valor predeterminado de `server.js` y `.env.example`. El `.env` del operador ya contenía 100 y se conservó. Una configuración explícita como 12 o 40 conserva ese límite. `resolveLiveNewsLimit()`, en `frontend/js/newsFeedModel.js`, obtiene el límite publicado en `meta.sourceMeta.corpus.displayLimit` (SQL) o `meta.sourceMeta.selectionConfig.displayLimit` (JSON); también admite `meta.newsRead.displayLimit`. `DEFAULT_LIVE_NEWS_LIMIT=100` se usa sólo si no existe metadata válida. El feed vivo admite como máximo 200 artículos. Los filtros pueden producir menos; el contador representa el total de artículos cargados que cumplen esos filtros, no el tamaño del archivo SQL.

El dashboard solicita `/api/intel/news?countries=ALL&limit=<límite configurado>` para ALL, o los países seleccionados, y usa ese mismo límite como tamaño de página. El backend también aplica el límite: sin parámetro usa la configuración; con un valor mayor devuelve como máximo el configurado; con un valor menor respeta el solicitado. Esta protección funciona en SQL y JSON y se publica en `meta.newsRead.displayLimit` y `meta.newsRead.limit`. Las consultas explícitas al archivo con `includeOlder=1` conservan su límite/paginación independiente.

La respuesta SQL se conserva mientras coincidan país, revisión del corpus, día y límite. Una actualización de mercado/pipeline no la sustituye por el conjunto reducido de StateManager. Cambiar el límite invalida la caché, ajusta la paginación y rechaza respuestas tardías del límite anterior, aunque la revisión del corpus sea la misma. El pipeline JSON también usa `config.news.displayLimit` en la selección publicada; su límite de análisis sigue siendo independiente.

Validación final con Node 22.23.3: sintaxis correcta, 701 tests backend, 23 tests MCP e inventario de 73 rutas/82 operaciones. Las regresiones prueban límites explícitos de 12, 40 y 100, peticiones sin límite o por encima/debajo del configurado, cambio de límite con respuesta tardía y acceso al histórico sin ese recorte. La prueba HTTP también cubre JSON. Dos repeticiones de Chromium con bases SQL temporales/RSS local verificaron configuraciones de 40 y 100: petición, respuesta HTTP y filas visibles respetan cada límite, incluso tras publicar un estado reducido a 10 noticias y una actualización de pipeline. No hubo errores de página en esas repeticiones. [Evidencia numérica](p0-evidence/live-news-display-limit.json).

El primer intento de navegador, ejecutado mientras corría la suite backend, agotó 30 segundos esperando filas y WS conectado. No se capturó un diagnóstico de página en ese intento, por lo que no se atribuye su causa. No volvió a reproducirse en las dos repeticiones posteriores con diagnóstico; no se incrementó el timeout. Estos ensayos aislados no certifican un soak de producción. Se usa ALL; los filtros por país pueden producir legítimamente menos noticias.

Estos cambios se cargarán al recargar el dashboard; los valores de configuración del backend se leen al arrancarlo. No se reinició el servicio del operador.

## Qué noticias llegan a cada cálculo

Mostrar 100 no implica analizar todo el histórico. Son controles diferentes. El operador tiene `NEWS_ANALYZE_LIMIT=80`, `NEWS_CANDIDATE_WINDOW_HOURS=36` y `AWARENESS_MODE=visible`.

`SqlNewsCorpus.read()` abre una transacción de lectura y escanea por el índice de publicación. El comienzo es el más antiguo entre `ahora - ventana` y la medianoche actual de `Europe/Madrid`: siempre permite construir el riesgo diario. La proyección posterior filtra la ventana específica del consumidor. Las lecturas no hidratan todo el archivo.

Se rechazan artículos sin título/URL utilizable, URLs no HTTP(S), datos synthetic/fallback/seeded y fuentes/dominios excluidos por las allowlists. Se normalizan identidades/países y se deduplica título normalizado más día de publicación. Los artículos se particionan en geopolíticos y financieros; los híbridos pueden pertenecer a ambos. Las proyecciones excluyen texto completo y conservan metadata/procedencia permitida.

La selección geopolítica requiere países detectados y ordena con `compareNews`: severidad, fecha e identidad. Sólo si ese comparador devuelve cero utiliza `analysisScore`; por tanto el score no reordena normalmente artículos de identidades distintas. Ese score pondera relevancia para países vigilados 35%, intensidad de conflicto 25%, recencia 20%, fiabilidad de fuente 10% y novedad 10%. Retiene como máximo `NEWS_ANALYZE_LIMIT`. La selección financiera tiene su propio tope: clasifica dominio/evento, importancia de la fuente y vínculos a instrumentos; combina importancia 85% y recencia 15%, y ordena según prioridad financiera. La unión elimina IDs duplicados.

| Consumidor | Ventana / entradas | Límites efectivos |
| --- | --- | --- |
| Live News Feed | Candidatos geopolíticos del día local, países seleccionados, diversidad de fuentes/titulares | Hasta NEWS_DISPLAY_LIMIT (100 por defecto, máximo 200); no limita el histórico almacenado |
| Riesgo diario por país | Todos los candidatos geopolíticos válidos del día encontrados en el escaneo | Se acumula antes del recorte de análisis/display; no se limita a 80 o 100 |
| Impacto / predicciones del ciclo | Corpus de mercado del ciclo de noticias (por defecto 36 h) más artículos Awareness visibles | Corpus SQL: hasta 80 geopolíticos + 80 financieros antes de deduplicar; Awareness puede añadir entradas |
| Advanced Intelligence v2 | Por defecto 24 h; SQL prepara 48 h para incluir la ventana previa de comparación. Une corpus geopolítico y agregado SQL, filtra fecha/país y deduplica | Recibe la selección acotada SQL, no todos los artículos de esas 48 h. `maxEvents` no limita el scoring en la implementación actual: normaliza todos los eventos del corpus recibido |
| Market Conditions v1.2 | 15, 60, 240 o 1440 minutos; 240 por defecto. SQL prepara al menos 1 h; después se aplica la ventana exacta | Unión geopolítica/financiera acotada + Awareness de fuentes activas y visibles, con deduplicación por URL/fingerprint y filtros de país/fecha |

Advanced añade entidades, inestabilidad, anomalías y comparación de términos con la ventana anterior. Las anomalías leen agregados históricos de señales con baseline de 7 o 30 días; ese baseline no equivale a cargar 7/30 días de artículos sin recortes. Conditions combina noticias con quotes, velas, indicadores técnicos y acoplamientos noticia/precio de los instrumentos seleccionados.

Las respuestas de `/api/intel/advanced-snapshot` y `/api/market/conditions` contienen `data.newsCoverage`: `scannedCount`, `eligibleCount`, `geopoliticalCandidateCount`, `financialCandidateCount`, `analysisCount`, `marketAnalysisCount`, `analyzeLimit` y `analysisTruncated`. Si `analysisTruncated=true`, el cálculo no recibió todas las noticias elegibles. `corpus.scoringUsesCompleteWindow` de Advanced describe los eventos de su corpus recibido; no acredita cobertura completa del archivo SQL.

Referencias de implementación: `backend/storage/sqlNewsCorpus.js`, `backend/storage/businessRuntime.js`, `backend/services/news/newsSelectionService.js`, `backend/services/news/financialNewsService.js`, `backend/services/intel/advancedIntelligenceService.js` y `backend/services/market/marketConditionsService.js`.

## Base configurada y contenido de /srv

La ruta configurada es `STORAGE_DB_PATH=data/sqlite/ogid.sqlite`. `storageConfig()` la resuelve contra el directorio backend, por lo que corresponde a **`/home/fedora/ogid/backend/data/sqlite/ogid.sqlite`**. No es un enlace a /srv. El proceso inspeccionado anteriormente declaró esa ruta. Durante esta revisión el puerto 3000 dejó de responder y el host ya no tenía un listener en ese puerto; se puede confirmar la base de un nuevo proceso consultando `/api/health`, con autorización administrativa cuando sea necesaria para mostrar la ruta.

Conteos observados, no una certificación de equivalencia o integridad:

| Base | Artículos / revisiones | Eventos | Velas | Quotes históricas | Estado |
| --- | --- | --- | --- | --- | --- |
| `/home/fedora/ogid/backend/data/sqlite/ogid.sqlite` | 46.514 / 64.218 | 51.791 | 9.519 | 30 | Base configurada, esquema con 008; `import.ready` ausente |
| `/srv/bitcoin/ogid/db/ogid.sqlite` | 55.717 / 84.957 | 49.456 | 24.682 | 2.360 | Base anterior, sin `pipeline_stage_state` de 008; `import.ready=true` |
| `/srv/bitcoin/ogid/ogidnew.sqlite` | 33.334 / 33.334 | 20.000 | 24.891 | 2.170 | Candidata importada, `import.ready=true` |
| `/srv/bitcoin/ogid/backup.sqlite` | 33.334 / 33.334 | 20.000 | 24.891 | 2.170 | Backup de la candidata; los conteos coinciden |

La candidata y su backup contienen además 19 jobs research. La base configurada no contiene esos jobs. Las bases tienen historias diferentes: no basta cambiar la ruta para considerarlas conciliadas. `import.ready` ausente tampoco acredita una importación histórica íntegra. No se eliminaron originales, candidatos ni backups. El primer intento de inspección de la base anterior encontró `no such table: pipeline_stage_state`; se verificó que le falta 008, sin atribuirlo a corrupción.

`/srv/bitcoin` está montado desde `/dev/sdb1` con **ntfs3**. La inspección no prueba bloqueo/WAL/recuperación de ese volumen. La herramienta `storage:volume-check` permite un ensayo explícito antes de decidir un cambio de ruta; no se ejecutó durante esta revisión de sólo lectura.

## Persistencia y acceso

HTTP/API/MCP usan adaptadores que envían comandos parametrizados a StorageManager. El worker principal ejecuta escrituras y transacciones SQLite con WAL, `synchronous=FULL` y foreign keys; la cola está acotada. El worker de análisis usa `query_only=ON` y delega las escrituras derivadas al principal. Lecturas de corpus usan snapshots transaccionales independientes y cachés por revisión/ventana.

Ingestión guarda antes de seleccionar. `articles` conserva el estado actual, `article_revisions` las revisiones y `article_sources` la procedencia; tablas de países/instrumentos/topics mantienen relaciones. `research_rows` guarda filas incrementales por colección y proyecta eventos en `events`/`evidence`. `candles` y `candle_revisions` conservan OHLCV; `quote_observations` conserva precios archivados conforme a la política de persistencia, no necesariamente cada tick mostrado. `runtime_snapshots`, `runtime_meta`, `pipeline_runs`, `pipeline_checkpoints` y `pipeline_stage_state` guardan recuperación/progreso. Los hechos históricos SQL no se podan automáticamente; cursores/snapshots temporales sí caducan.

Las velas interactivas pueden persistirse de forma asíncrona. Hay un problema conocido de review: un job histórico puede avanzar antes del commit de esas velas. También siguen pendientes el error transitorio retenido por `PipelinePersistence.flush()` y la validación de revisión de noticias al aplicar una proyección de mercado. Esta entrega corrige el feed, no esos tres problemas.

Para ver conteos, últimas etapas y deltas cada cinco segundos, desde el repositorio:

```sh
npm --prefix backend run storage:inspect -- /home/fedora/ogid/backend/data/sqlite/ogid.sqlite --watch
```

Para consultar datos con la CLI SQLite instalada, siempre en sólo lectura:

```sh
sqlite3 -readonly /home/fedora/ogid/backend/data/sqlite/ogid.sqlite
```

```sql
.tables
.headers on
.mode column
SELECT article_id, published_at, title FROM articles ORDER BY published_at DESC LIMIT 20;
SELECT collection, COUNT(*) AS records FROM research_rows GROUP BY collection;
SELECT pipeline_id, updated_at, revision FROM pipeline_checkpoints ORDER BY updated_at DESC;
SELECT stage_id, status, updated_at FROM pipeline_stage_state ORDER BY updated_at DESC;
SELECT article_id, source_id, provenance_json FROM article_sources LIMIT 5;
```

Por HTTP, cuando el backend esté activo: `/api/intel/news?countries=ALL&limit=100` para la selección actual; `/api/news/search` con filtros y cursor para el archivo; `/api/intel/advanced-snapshot?windowHours=24` y `/api/market/conditions?windowMin=240` para cobertura y cálculos. Las rutas conservan sus permisos y la política de contenido original.

No copiar sólo el archivo `.sqlite` de un escritor activo: un commit puede seguir en `-wal`. Usar `storage:backup`, que crea y verifica un backup SQLite consistente. No borrar `-wal`/`-shm` de una base activa.
