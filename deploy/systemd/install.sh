#!/bin/sh
# Ejecutar en el anfitrión Fedora como el usuario propietario de OGID.
set -eu
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
if [ "$project_dir" != "$HOME/ogid" ]; then
    echo "Estas unidades esperan el proyecto en \$HOME/ogid. Ajusta las rutas antes de instalarlas." >&2
    exit 1
fi
for executable in /usr/bin/node /usr/bin/logrotate /usr/bin/systemctl /usr/bin/mountpoint; do
    test -x "$executable" || { echo "Falta $executable" >&2; exit 1; }
done
/usr/bin/node -e 'const major = Number(process.versions.node.split(".")[0]); if (major < 22 || major >= 27) process.exit(1)'
/usr/bin/mountpoint -q /srv/bitcoin || { echo "Falta el montaje /srv/bitcoin; no se crea una base en el filesystem raíz." >&2; exit 1; }
test -r "$project_dir/backend/.env"
test -d "$project_dir/backend/node_modules"
unit_dir="$HOME/.config/systemd/user"
config_dir="$HOME/.config/ogid"
log_dir="$project_dir/backend/data/logs"
install -d -m 700 "$unit_dir" "$config_dir" "$log_dir"
for unit in ogid.service ogid-logrotate.service ogid-logrotate.timer; do
    install -m 600 "$project_dir/deploy/systemd/$unit" "$unit_dir/$unit"
done
# La ruta está validada arriba; escapar los caracteres especiales de sed.
escaped_root=$(printf '%s' "$project_dir" | sed 's/[\\&|]/\\&/g')
sed "s|@OGID_ROOT@|$escaped_root|g" "$project_dir/deploy/systemd/ogid.logrotate" > "$config_dir/logrotate.conf"
chmod 600 "$config_dir/logrotate.conf"
touch "$log_dir/ogid.log"
chmod 600 "$log_dir/ogid.log"
/usr/bin/systemd-analyze --user verify "$unit_dir/ogid.service" "$unit_dir/ogid-logrotate.service" "$unit_dir/ogid-logrotate.timer"
/usr/bin/logrotate --debug --state "$log_dir/logrotate.state" "$config_dir/logrotate.conf"
/usr/bin/systemctl --user daemon-reload
/usr/bin/systemctl --user enable ogid.service ogid-logrotate.timer
echo "Unidades preparadas. No se ha iniciado ni reiniciado OGID. Consulta docs/storage-cutover.md para importar y arrancar."
