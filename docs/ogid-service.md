# OGID como servicio de usuario en Fedora

Configurado el 9 de octubre de 2026 para `fedora`, con el proyecto en `/home/fedora/ogid`. El backend usa su `.env` existente y el puerto 3000. La unidad instalada inicialmente activa `STORAGE_ENABLED=1` y `STORAGE_DB_PATH=/srv/bitcoin/ogid/db/ogid.sqlite`, comprobando que el volumen esté montado antes del arranque. El servicio ejecuta `/usr/bin/node` directamente, con `NODE_ENV=production`; no depende de Screen ni de una terminal.

La nueva unidad SQL está preparada en el proyecto y aún no se ha instalado. Para activarla por primera vez, seguir [storage-cutover.md](storage-cutover.md) antes de usar los comandos de arranque habituales.

## Uso diario

Ejecutar estos comandos en una terminal del anfitrión Fedora:

```sh
systemctl --user status ogid.service --no-pager
systemctl --user start ogid.service
systemctl --user stop ogid.service
systemctl --user restart ogid.service
curl --fail --max-time 10 http://127.0.0.1:3000/api/health
```

Leer el registro de ejecución y los eventos del supervisor:

```sh
tail -F /home/fedora/ogid/backend/data/logs/ogid.log
journalctl --user -u ogid.service -f
systemctl --user list-timers ogid-logrotate.timer
```

La salida normal y los errores de Node se guardan en `backend/data/logs/ogid.log`, con permisos 0600. `journalctl` contiene los eventos de systemd: arranques, salidas y reinicios. Las líneas JSON de la aplicación usan UTC; el estado mostrado por systemd usa la zona del anfitrión. Durante el ensayo inicial se creó `ogid.log.1` al probar una rotación real.

El log rota diariamente o cuando supera 20 MiB al comprobarlo cada quince minutos. Se conservan siete copias, comprimidas salvo la más reciente. No es un límite duro de tamaño: entre comprobaciones el archivo puede superar 20 MiB. `copytruncate` mantiene abierto el descriptor del proceso sin reiniciarlo; puede perder unas pocas líneas entre copia y truncado, por lo que este log no sustituye a un historial transaccional ni al supervisor.

`Restart=always` recupera el proceso cinco segundos después de una salida, incluso si su código es cero. Una orden explícita `systemctl --user stop` lo deja detenido. Diez arranques fallidos en dos minutos activan el límite de protección; después de corregir la causa:

```sh
systemctl --user reset-failed ogid.service
systemctl --user start ogid.service
```

La nueva plantilla del servicio tiene 210 segundos para terminar con SIGTERM. El reinicio recupera procesos que salen; un proceso vivo que deja de responder necesita diagnóstico y una comprobación externa o un watchdog que la aplicación alimente. No se ha configurado un watchdog ficticio.

## Instalación reproducible

Las plantillas y el instalador están en `deploy/systemd/`. El instalador espera el proyecto en `$HOME/ogid`, Node compatible con el manifiesto (22–26), `/usr/bin/logrotate`, `/usr/bin/mountpoint`, el montaje `/srv/bitcoin` disponible y dependencias instaladas y `.env` existente. No reemplaza el `.env` ni instala paquetes.

```sh
/home/fedora/ogid/deploy/systemd/install.sh
loginctl enable-linger fedora
loginctl show-user fedora -p Linger
```

Se instalan `ogid.service`, `ogid-logrotate.service` y `ogid-logrotate.timer` en `~/.config/systemd/user/`; la configuración de rotación queda en `~/.config/ogid/logrotate.conf`. Se habilitan el backend y el temporizador. El instalador comprueba la sintaxis de unidades y logrotate, ejecuta `daemon-reload` y las habilita sin `--now`: no inicia ni reinicia el proceso. Para la nueva versión, completar primero la [importación y activación manual](storage-cutover.md).

`Linger=yes` permite iniciar el gestor de servicios del usuario al arrancar Fedora y mantenerlo sin sesión iniciada. Se ha activado en esta máquina. No se ha realizado un reinicio del sistema como prueba. El binario instalado es Node 22.23.3, compatible con `backend/package.json`; las referencias del proyecto fijan Node 24 como baseline para una futura actualización verificada.

Desde VS Code Flatpak, anteponer `flatpak-spawn --host` a comandos del anfitrión; los PID y el `/tmp` del Flatpak son distintos:

```sh
flatpak-spawn --host systemctl --user status ogid.service --no-pager
flatpak-spawn --host /home/fedora/ogid/deploy/systemd/install.sh
```

## Validación realizada

- Unidades aceptadas por `systemd-analyze --user verify`; configuración aceptada por logrotate.
- Servicio habilitado y `/api/health` con HTTP 200 y `status=ok`; dashboard con HTTP 200 y WebSocket `/ws` con bootstrap recibido.
- Reinicio automático real: SIGTERM al proceso principal; PID 475924 → 476020, `NRestarts=1` y recuperación de HTTP 200.
- Rotación real forzada, servicio de rotación terminado con éxito y nueva petición registrada en `ogid.log` después del truncado.
- Temporizador habilitado y `Linger=yes`. Watchlist recuperada: 18 instrumentos.

Las comprobaciones anteriores corresponden a la unidad instalada inicialmente. La nueva plantilla activa `STORAGE_BUSINESS_ENABLED=1`, exige importación y siete migraciones, y amplía la parada a 210 segundos. No se ha instalado ni reiniciado en esta entrega. Después del corte, `/api/health` debe mostrar `storage.state=ready` y `businessStorage=sqlite`; los pasos están en [storage-cutover.md](storage-cutover.md).

## Deshabilitar

```sh
systemctl --user disable --now ogid.service ogid-logrotate.timer
```

Esta orden conserva los datos, logs y unidades. Desactivar linger afecta también a los demás servicios del usuario; no hacerlo como parte de una limpieza de OGID sin revisar sus dependencias.
