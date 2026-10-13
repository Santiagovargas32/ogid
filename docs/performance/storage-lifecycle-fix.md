# Corrección del ciclo de vida del storage

Trabajo local del 13 de octubre de 2026 en `fix/storage-lifecycle-persistence`.
Se conserva la configuración privada y el histórico SQL. No se reinicia la base
vacía ni se importa otra base sobre ella.

## Diagnóstico

`STORAGE_NOT_READY` significa que se pidió una operación a un gestor que ya no
estaba listo. El error de `advanced-snapshot` también puede proceder del RPC que
guarda su resultado en el escritor principal. Por eso tener HTTP 200 en
`provider-status` o `sync` no demuestra que la persistencia esté disponible.

El fragmento del incidente del 13 de octubre no contiene el primer fallo del
worker. Los logs conservados corresponden al 9–10 de octubre y muestran
`STORAGE_OUTCOME_UNKNOWN` por deadlines de escritura anteriores; no permiten
atribuir ese mismo disparador al incidente nuevo. La inspección encontró etapas
de noticias en `running`, sin un proceso activo, y la última proyección SQL
confirmada era anterior a los errores.

Se confirmaron estos defectos de implementación:

- `PipelinePersistence.failure` retenía para siempre el primer error. Una nueva
  escritura correcta no recuperaba `flush()` y bloqueaba ciclos posteriores.
- Un error de un flush abortaba `stop()` antes de cerrar SQLite y sus workers.
- El cierre del proceso imponía 30 segundos aunque `.env` configuraba 180. En la
  prueba real el drenaje necesitó unos 35 segundos.
- Un fallo del escritor dejaba al análisis esperando un RPC que no podía terminar;
  un fallo del análisis no se notificaba al propietario del gestor principal.
- Dos llamadas concurrentes a `start()` podían observar el escritor listo antes
  de que terminara de arrancar el worker de análisis.
- `news.getFeed` y `news.getLiveFeed`, incluidas sus lecturas del archivo histórico,
  ejecutaban selección y clasificación en el escritor. Esto competía con la
  persistencia y podía hacer que una lectura agotara el deadline del escritor.

La pérdida de persistencia explica `news.normalize.persistence: blocked`; la
parada o reinicio del backend explica la reconexión WebSocket. No se ha observado
un defecto nuevo del protocolo WebSocket en esta validación.

## Ajuste dentro de la arquitectura actual

Se mantiene un escritor SQLite y un worker de análisis en modo `query_only`.
Las tres lecturas CPU de noticias (`getProjection`, `getFeed`, `getLiveFeed`) se
envían al análisis; adquisición, importaciones y guardados siguen en el escritor.
Los fallos del análisis se notifican al propietario sin terminar por la fuerza
las escrituras aceptadas. El ejecutable del backend inicia su cierre controlado.
Si muere el escritor, se rechaza también el análisis que dependía de él.

La persistencia registra el último resultado por etapa o registro. Un guardado
correcto recupera únicamente esa clave; no oculta errores de otras etapas ni
permite que una respuesta antigua sustituya un resultado nuevo. `flush()` espera
todas las escrituras aceptadas antes de informar los fallos pendientes.

El servidor comprueba ambos workers y drena los guardados iniciales antes de
escuchar HTTP. El cierre recoge errores, continúa liberando todos los recursos y
respeta el tiempo configurado. El error sigue siendo observable. Los rechazos
`STORAGE_NOT_READY` incluyen el código previo y el worker implicado en sus
diagnósticos. No se reintentan automáticamente escrituras de resultado incierto.

Los comandos `storage:status` y `storage:inspect` cargan el mismo `.env` que el
servidor y resuelven rutas relativas desde `backend`. Admiten una ruta explícita
y rechazan bases inexistentes. El mantenimiento no inicia otro worker de negocio.
`storage:inspect` conserva su conexión de sólo lectura; `storage:status status`
y `checkpoint` abren el worker de infraestructura y pueden aplicar las
migraciones existentes. `verify` hace el escaneo completo en un proceso de
mantenimiento de sólo lectura, sin el deadline de las peticiones del backend,
y devuelve un código de salida no cero si detecta errores de integridad.

## Base conservada

Ruta activa: `/srv/bitcoin/ogid/db/ogid.sqlite`. Se verificó una copia consistente,
incluidos los commits del WAL, en:

`backend/data/storage-backups/pre-storage-fix-20261013.sqlite`

El backup tiene 60.568 artículos, 92.063 revisiones de artículos, 55.230 eventos y
26.332 velas. `integrity_check` dio `ok` y `foreign_key_check` no encontró errores.
No se borran `-wal`/`-shm` a mano, históricos, contextos ni cuotas. El arranque usa
la recuperación existente de etapas interrumpidas y los nuevos ciclos actualizan
las etapas que realmente completan. Se conserva la evidencia histórica de fallos.

El volumen `/srv/bitcoin` es `ntfs3`. La prueba temporal `storage:volume-check`
pasó WAL, lectores concurrentes, exclusión de escritores, recuperación de commits,
rollback de una transacción interrumpida e integridad. Esa prueba no simula una
pérdida de alimentación.

## Arranque habitual

Desde `/home/fedora/ogid`, con las dependencias ya instaladas y Node compatible
con `backend/package.json` (la validación utilizó Node 22.23.3):

```sh
npm --prefix backend run storage:inspect
npm --prefix backend run storage:status -- verify
npm --prefix backend start
```

La configuración local existente es:

```dotenv
PORT=3000
STORAGE_ENABLED=1
STORAGE_BUSINESS_ENABLED=1
STORAGE_DB_PATH=/srv/bitcoin/ogid/db/ogid.sqlite
STORAGE_TIMEOUT_MS=30000
STORAGE_QUEUE_TIMEOUT_MS=90000
STORAGE_SHUTDOWN_TIMEOUT_MS=180000
STORAGE_REQUIRE_IMPORT=0
```

No hace falta ejecutar `storage:migrate`: esta base ya tiene las ocho migraciones.
Ese comando sirve para una importación explícita a una candidata nueva, no para
reparar el ciclo de vida de esta base existente. Montar `/srv/bitcoin` antes de
arrancar y ejecutar una sola instancia escritora del backend contra esta ruta.
`npm start` carga `.env`; `DISABLE_BACKGROUND_REFRESH=1`, usado en una de las
pruebas, no debe exportarse en la terminal del arranque habitual.

Abrir `http://localhost:3000` y comprobar desde otra terminal:

```sh
curl -fsS http://127.0.0.1:3000/api/health/ready
curl -fsS http://127.0.0.1:3000/api/health
```

Readiness debe devolver 200; ambos workers deben indicar `ready` y
`businessStorage` debe ser `sqlite`. La ruta completa se muestra con los permisos
administrativos existentes. Un proveedor sin datos o con cuota agotada puede
degradar su pipeline aunque SQLite y el transporte funcionen.

Para observar SQL sin arrancar otro backend:

```sh
npm --prefix backend run storage:inspect -- --watch
```

Detener con Ctrl+C y esperar `server_stopped`. Si aparece un fallo fatal, conservar
el primer `storage_worker_failed` con `code` y `command`; reiniciar después de que
termine el cierre, sin eliminar archivos SQLite ni repetir escrituras inciertas.
Las integraciones que instancien `StorageManager` directamente deben atender su
evento `failed` y cerrar el gestor; el ejecutable del backend ya lo hace.

## Validación

- 714 pruebas aprobadas y comprobación de sintaxis; regresiones de arranque concurrente,
  fallo de cada worker, recuperación de persistencia, respuestas fuera de orden,
  drenaje tras error y enrutamiento de feeds al lector.
- Tres ciclos concurrentes sobre una copia temporal del histórico real: 100
  noticias visibles, ambos workers listos, sin fallos e integridad correcta.
- Ejecución con configuración real: readiness y advanced-snapshot 200, 87
  mensajes WebSocket y cierre intencionado 1001 `server-shutdown`. El proceso
  drenó sus tareas y terminó con `cleanupErrors: 0`.
- Sondeo final con refrescos externos desactivados temporalmente: cuatro muestras
  concurrentes de readiness, advanced-snapshot y los dos feeds, todas 200; ambos
  workers listos, ningún bloqueo ni error, CPU de lectura fuera del escritor,
  11 mensajes WebSocket, cierre 1001 y salida de proceso 0.
- Integridad de la base original: `ok`, sin errores de claves foráneas. Su escaneo
  completo en NTFS superó el deadline normal de comandos; la verificación de
  mantenimiento se separó de ese deadline y terminó correctamente.

Las pruebas comprueban esta corrección y el estado actual; no son un ensayo de
estabilidad de 24 horas ni identifican el disparador inicial omitido en los logs.

## Cambio de formato solicitado después de la corrección

El usuario pidió mantener el almacenamiento fuera del disco del sistema y
cambiar `/srv/bitcoin` a ext4. Se identificó `/dev/sdb1` (1.000.203.091.968 bytes),
UUID NTFS `1C5A49F95A49CFE6`; `/dev/sda` contiene el sistema y no se modifica.
El disco local es Btrfs. Se copian y verifican todos los 83 archivos del volumen,
6.317.707.488 bytes, en `backend/data/storage-volume-migration/20261013/volume`.

El procedimiento local `format-volume.sh` de esa preparación comprueba dispositivo,
UUID, tamaño, montaje, inventario y checksums antes de borrar. Exige confirmación
en la terminal, conserva fstab y lo actualiza por UUID, crea ext4 y restaura la
base en su misma ruta. Todos los archivos previos quedan archivados en el volumen
dedicado a OGID. La copia local se conserva hasta validar la app sobre ext4.

El formateo queda pendiente de ejecutar con autenticación administrativa en la
terminal del usuario: `sudo -n true` devolvió que hace falta contraseña. El
procedimiento está preparado; no se ha modificado el formato ni fstab.
Ext4 es una opción nativa para Linux; el rendimiento debe comprobarse con esta
carga y este dispositivo, como advierte la
[documentación del kernel](https://docs.kernel.org/admin-guide/ext4.html).
