# Base en /srv y observador de almacenamiento

Estado comprobado el 14 de octubre de 2026: la misma ruta está montada sobre
**ext4** tras la migración documentada en `storage-lifecycle-fix.md`; las referencias
a ntfs3 más abajo corresponden a la inspección del 13 de octubre anterior a ella.
La corrección de `STORAGE_COMMAND_TOO_LARGE` y el nuevo panel de operaciones
están explicados en [market-worker-command-budget.md](market-worker-command-budget.md).

El 13 de octubre de 2026 se cambió únicamente la ruta de la configuración local del operador a `/srv/bitcoin/ogid/db/ogid.sqlite`. `STORAGE_ENABLED=1` y `STORAGE_BUSINESS_ENABLED=1` ya estaban activos. El archivo `.env` es privado y no se versiona. El servidor estaba detenido y no se arrancó durante esta tarea.

## Configuración y próximo arranque

```dotenv
STORAGE_ENABLED=1
STORAGE_BUSINESS_ENABLED=1
STORAGE_DB_PATH=/srv/bitcoin/ogid/db/ogid.sqlite
```

El worker principal leerá y persistirá en esa base al arrancar con esta configuración. El worker de análisis usa la misma ruta en modo de sólo lectura y delega sus escrituras al principal. El cambio de ruta no combina los históricos de bases diferentes.

La base elegida se abrió en sólo lectura: `import.ready=true`, WAL y migraciones 001–007. El código actual añadirá la migración 008 al arrancar. Crear primero un backup consistente en un archivo nuevo; la herramienta rechaza sobrescribir un backup existente y valida integridad/FK:

```sh
npm --prefix /home/fedora/ogid/backend run storage:backup -- /srv/bitcoin/ogid/db/ogid.sqlite /srv/bitcoin/ogid/backup-antes-arranque.sqlite
npm --prefix /home/fedora/ogid/backend start
```

`/srv/bitcoin` está montado con ntfs3. Abrir la base y leer sus tablas no certifica recuperación ante pérdida de alimentación ni las garantías del volumen; la prueba `storage:volume-check` sigue disponible para un ensayo explícito. No se modificaron las bases ni se ejecutó una migración/backup en esta tarea.

## Error ENOENT y watch

`npm --prefix backend` es relativo al directorio actual. Ejecutado desde `/home/fedora` busca `/home/fedora/backend/package.json`. Usar la ruta absoluta funciona desde cualquier directorio:

```sh
npm --prefix /home/fedora/ogid/backend run storage:inspect -- /srv/bitcoin/ogid/db/ogid.sqlite --watch
```

El observador es de sólo lectura, actualiza conteos/checkpoints/últimas ejecuciones y deltas cada cinco segundos y termina con Ctrl+C. Los deltas pueden ser cero mientras el backend esté detenido. El tamaño del archivo y del WAL se sigue mostrando.

Se encontró un segundo problema medido: sumar los bytes de todos los payloads research tardó 176.467 ms en esta base; contar por colección sin leer payloads tardó 2.475 ms. El observador y la telemetría periódica ahora omiten ese agregado, devuelven `researchBytesSampled=false` y `bytes=null`, preservando conteos y estados. No se aumentaron los timeouts ni se alteró la retención. Para solicitar explícitamente los tamaños completos:

```sh
npm --prefix /home/fedora/ogid/backend run storage:inspect -- /srv/bitcoin/ogid/db/ogid.sqlite --full
```

La medición completa puede tardar en un volumen con acceso lento. Se verificaron dos muestras del watch desde `/home/fedora`; la primera llegó en 545 ms con caché caliente. Ese resultado no es un benchmark comparable de caché fría ni una garantía de latencia del volumen.

Conteos observados: 55.717 artículos, 84.957 revisiones de artículos, 49.456 eventos, 19 jobs research, 24.682 velas y 2.360 observaciones de quotes. Sintaxis correcta; 703 tests backend y 23 MCP aprobados. Las regresiones comprueban conteos que reflejan nuevas filas, bytes desconocidos frente a cero y tamaños UTF-8 correctos al solicitar la medición completa.

Para ver filas, además de los conteos del observador:

```sh
sqlite3 -readonly /srv/bitcoin/ogid/db/ogid.sqlite 'SELECT published_at,title FROM articles ORDER BY published_at DESC LIMIT 10;'
```

Después del arranque, comprobar `/api/health`: con permiso administrativo, `storage.databasePath` debe ser `/srv/bitcoin/ogid/db/ogid.sqlite` y `businessStorage` debe indicar sqlite. `STORAGE_ENABLED=1` sin `STORAGE_BUSINESS_ENABLED=1` no activa los repositorios de negocio SQL.
