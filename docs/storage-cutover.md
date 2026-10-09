# Activación manual de SQLite y worker

Guía del corte inicial, preparada el 9 de octubre de 2026. El usuario ha activado el servicio SQL posteriormente. Para aplicar la revisión del incidente sin repetir la importación, seguir [storage-troubleshooting.md](storage-troubleshooting.md). El agente no ha iniciado ni reiniciado el servicio; los ensayos de escritura usaron bases candidatas y puertos temporales.

## Qué hay que iniciar

Sólo `ogid.service` y `ogid-logrotate.timer`. SQLite es embebido: el worker y la cola arrancan dentro de Node; no hay daemon SQL, Redis ni otro puerto. El MCP existente conserva sus operaciones REST y permisos. El dashboard sigue en `http://192.168.1.50:3000/`.

Requisitos comprobados en esta máquina: Node 22.23.3, dependencias instaladas, montaje `/srv/bitcoin`, `.env` existente y `Linger=yes`. Si se usa otra instalación, ejecutar `npm ci --omit=dev` en `backend/` con Node 22–26 antes del corte. `better-sqlite3` necesita un binario compatible con la versión de Node; no actualizar Node y el almacenamiento al mismo tiempo.

Los comandos siguientes son para una terminal del **anfitrión Fedora**, como `fedora`. Desde VS Code Flatpak usar una terminal del anfitrión o `flatpak-spawn --host` para lanzar los comandos.

## 1. Detener y conservar la versión anterior

```sh
cd /home/fedora/ogid
systemctl --user stop ogid.service
systemctl --user is-active ogid.service
```

Debe mostrar `inactive`; ese comando devuelve código 3 en ese estado. Un `stop` explícito impide el reinicio automático de systemd. No continuar si queda otro backend de OGID escribiendo estos datos o escuchando en el puerto 3000.

Crear una copia con el proceso detenido, incluyendo los archivos auxiliares de la base anterior:

```sh
mountpoint -q /srv/bitcoin
ogid_backup_dir="/srv/bitcoin/ogid/backups/pre-sql-$(date +%Y%m%d-%H%M%S)"
mkdir -m 700 -p "$ogid_backup_dir"
cp -a backend/data "$ogid_backup_dir/legacy-data"
if test -d /srv/bitcoin/ogid/db; then
  cp -a /srv/bitcoin/ogid/db "$ogid_backup_dir/db-before"
fi
cp -a "$HOME/.config/systemd/user/ogid.service" "$ogid_backup_dir/ogid.service.before"
printf '%s\n' "$ogid_backup_dir"
```

Guardar la ruta impresa. Los JSON originales se conservan también en el proyecto: el importador sólo los lee. Si `.env` dirige algún store a una ubicación externa a `backend/data`, incluir esa ubicación en la copia. `.env`, credenciales y catálogos no se sustituyen.

## 2. Importar y verificar

```sh
cd /home/fedora/ogid/backend
npm run storage:migrate -- --db /srv/bitcoin/ogid/db/ogid.sqlite
npm run storage:status -- verify /srv/bitcoin/ogid/db/ogid.sqlite
npm run storage:status -- status /srv/bitcoin/ogid/db/ogid.sqlite
```

Continuar sólo si la importación termina correctamente, `integrity_check=ok`, `foreignKeys=[]` y aparecen siete migraciones. El importador conserva IDs, procedencia, ajustes/datasets y revisiones disponibles. Reconcilia instrumentos verificados, noticias, eventos/evidencias, trabajos, alertas/cambios/checkpoints, velas, cotizaciones y los estados/auditorías de pipelines. Registra manifiestos SHA-256 por archivo y marca la importación lista al terminar la verificación.

Los ensayos con datos reales tardaron entre 26 y 85 segundos, según el cache del disco, y alcanzaron unos 800–836 MiB de RSS durante la importación; no es la memoria habitual del HTTP. La duración del corte dependerá de los datos presentes y de la carga del disco.

Si falla, dejar OGID detenido y corregir la causa. Un reintento sobre las mismas fuentes continúa sin duplicar los archivos confirmados. Si cambian fuentes ya confirmadas durante una importación parcial, se rechaza su checksum; preparar otro candidato desde la copia coherente, en vez de forzar la aceptación. Después de una importación completa, repetir el comando devuelve el resultado guardado: no vuelve a mezclar JSON con nuevas escrituras SQL.

## 3. Preparar las unidades, sin arrancar

```sh
cd /home/fedora/ogid
sh deploy/systemd/install.sh
systemctl --user cat ogid.service
```

El instalador copia y valida las unidades, ejecuta `daemon-reload` y las habilita **sin `--now`**. No inicia ni reinicia OGID. La unidad selecciona:

```text
STORAGE_ENABLED=1
STORAGE_BUSINESS_ENABLED=1
STORAGE_REQUIRE_IMPORT=1
STORAGE_DB_PATH=/srv/bitcoin/ogid/db/ogid.sqlite
STORAGE_QUEUE_MAX_BYTES=33554432
STORAGE_MAX_COMMAND_BYTES=8388608
STORAGE_TIMEOUT_MS=30000
STORAGE_QUEUE_TIMEOUT_MS=90000
STORAGE_SHUTDOWN_TIMEOUT_MS=180000
NEWS_RETENTION_DAYS=365
```

El volumen debe estar montado antes del arranque. La importación es obligatoria para este servicio: no arranca una base de negocio vacía ni vuelve silenciosamente al JSON. La parada dispone de 210 segundos para drenar ciclos y comandos. `Restart=always`, espera de cinco segundos y límite de diez arranques en dos minutos siguen configurados.

## 4. Arrancar y comprobar

```sh
systemctl --user reset-failed ogid.service
systemctl --user start ogid.service ogid-logrotate.timer
systemctl --user status ogid.service --no-pager
curl --fail --max-time 10 http://127.0.0.1:3000/api/health
curl --fail --max-time 10 http://192.168.1.50:3000/api/health
tail -F /home/fedora/ogid/backend/data/logs/ogid.log
```

La salud debe incluir `storage.state=ready`, `businessStorage=sqlite` y `storagePhase=repositories`. Admin muestra la cola y diagnósticos cacheados; no vuelve a cargar Histórico diario. Usar las peticiones API/MCP existentes para solicitar cobertura, trabajos o importaciones. El resumen de salud responde sin esperar la consulta histórica SQL.

En el log deben aparecer `storage_worker_started`, `server_started` y los ciclos de ingesta. Buscar `storage_command_failed`, `pipeline_persistence_failed`, `research_pipeline_blocked` o errores de proveedor si algún source sigue degradado. Un timeout/429/403 del proveedor puede persistir aunque HTTP siga respondiendo; revisar su estado individual antes de forzar más peticiones. El RSS se consulta en lotes rotatorios de hasta 18 feeds, concurrencia cuatro y deadline de 60 segundos, para que un feed lento no inmovilice todo el catálogo.

Para eventos del supervisor:

```sh
journalctl --user -u ogid.service -f
systemctl --user show ogid.service -p MainPID -p NRestarts
```

## Backup y recuperación posteriores

Con el servicio activo, crear una copia consistente que incluya cambios confirmados en WAL:

```sh
cd /home/fedora/ogid/backend
npm run storage:backup -- /srv/bitcoin/ogid/db/ogid.sqlite "/srv/bitcoin/ogid/backups/ogid-$(date +%Y%m%d-%H%M%S).sqlite"
```

El comando usa la API de backup de SQLite desde otro proceso, verifica integridad/FK y no sobrescribe un destino existente. No copiar sólo `ogid.sqlite` mientras se escribe WAL. El backup automático y la política de retención de copias quedan para la siguiente entrega; este comando es manual.

Antes de restaurar, parar el servicio y guardar **todo el directorio `db/` actual** en otra ubicación. Restaurar la copia verificada en un directorio limpio, con propietario `fedora`, directorio 0700 y archivo 0600; no combinarla con `-wal`/`-shm` de otra versión. Verificar con `storage:status verify` antes de iniciar. Los tests han comprobado reapertura de una copia con datos confirmados en WAL y exclusión de una transacción sin commit.

Antes de las primeras escrituras SQL puede recuperarse la unidad y la carpeta de datos del backup previo. Después de nuevas escrituras SQL, volver al JSON antiguo perdería esas noticias, revisiones y cambios: conservar la base y usar una versión compatible o una exportación consistente. No está implementado un exportador integral SQL→stores JSON.

La retención de noticias del servicio pasa a 365 días hacia adelante; no recupera lo que el sistema anterior ya descartó. La invalidación fina de análisis, las vistas históricas nuevas y la retención de auditorías/outbox se detallan en el [roadmap](storage-implementation-roadmap.md).
