# Runbook Fedora

Para la evolución financiera 0.3.0, usar también [migración, verificaciones nuevas y rollback v2](../../docs/research-cartera/RUNBOOK.md).

Ejecutar en terminal del host, shell sh/Bash, desde la raíz real del checkout. En IDE Flatpak, los binarios del host se ejecutan con flatpak-spawn --host. Las rutas de esta guía son genéricas; RUNBOOK-FEDORA.local contiene los comandos y observaciones de esta máquina y está ignorado por Git.

## Validar antes de reiniciar

```sh
command -v node
node --version
npm --prefix backend run check
npm --prefix backend test
npm --prefix integrations/ogid-mcp run check
npm --prefix integrations/ogid-mcp run inventory:check
npm --prefix integrations/ogid-mcp test
systemctl --user list-units --all --type=service
screen -ls
```

Identificar el PID, directorio y forma de arranque del backend. No asumir PM2 ni una unidad instalada. El arranque del proyecto es npm --prefix backend start; si el terminal ya está en backend, npm start. En una sesión screen existente, detener el proceso con Ctrl+C y ejecutar ese comando desde su directorio. No instalar una segunda copia que compita por el puerto. Respaldar configuración/datos de forma privada antes de cambiar procesos.

```sh
curl --fail --silent --show-error http://127.0.0.1:3000/api/capabilities
OGID_PROFILE=research OGID_INSTRUMENT_AUTH=runtime npm --prefix integrations/ogid-mcp run smoke
```

Capabilities debe devolver contractVersion=1.1.0. El smoke requiere el backend nuevo y comprueba versión MCP 0.3.0, diez herramientas y cuatro modos. Puede fallar explícitamente por presupuesto o datos ausentes; eso no permite forzar un proveedor.

## Túnel existente

Verificar versión y ayuda del binario antes de adaptar el YAML. La plantilla corresponde a tunnel-client 0.0.15. Perfil fuera de Git, secreto runtime en archivo privado; el comando del hijo incluye OGID_PROFILE=research y OGID_INSTRUMENT_AUTH=runtime. Una instancia por tunnel_id.

```sh
"$HOME/.local/bin/tunnel-client" --version
"$HOME/.local/bin/tunnel-client" doctor --profile-file "$HOME/.config/ogid-mcp/tunnel-client.yaml" --explain
"$HOME/.local/bin/tunnel-client" run --profile-file "$HOME/.config/ogid-mcp/tunnel-client.yaml"
```

El cliente lanza el MCP por stdio; no arrancar otra instancia independiente para la misma conexión. Backend y túnel deben permanecer activos.

```sh
curl --fail --silent --show-error http://127.0.0.1:8766/healthz
curl --fail --silent --show-error http://127.0.0.1:8766/readyz
```

Revisar logs localmente sin publicarlos. Un 200 solo acredita el estado local descrito por esa ruta. Una llamada real desde la conversación es la prueba de acceso del producto.

La UI local está en `http://127.0.0.1:8766/ui`: `Overview` muestra el estado del cliente y `Logs` recibe los eventos del túnel en directo. Un evento `dispatcher forwarded command to MCP server` acredita el envío al hijo MCP. Para comprobar la entrega, abrir `http://127.0.0.1:8766/health/response-delivery` antes y después de una consulta: los contadores `accepted` y `completed` deben aumentar y `terminal_failures` no debe aumentar. Estos contadores son del transporte; comprobar también que la respuesta de la herramienta tiene `ok:true` y datos válidos.

Si el cliente se inició redirigiendo su salida a un archivo, seguirlo con `tail -f RUTA_DEL_LOG`; la ruta depende del comando de arranque. Si se ejecuta como la unidad de usuario de esta guía, usar `journalctl --user -u ogid-mcp-tunnel -f`. No arrancar otro cliente para consultar sus logs.

## Persistencia

La unidad deploy/ogid-mcp-tunnel.service es una plantilla, no acredita instalación. Si ya existe y sus rutas son correctas, systemctl --user restart ogid-mcp-tunnel. Para instalarla, validar primero el perfil, el backend persistente y detener la instancia de primer plano:

```sh
mkdir -p "$HOME/.config/systemd/user"
cp integrations/ogid-mcp/deploy/ogid-mcp-tunnel.service "$HOME/.config/systemd/user/"
systemd-analyze --user verify "$HOME/.config/systemd/user/ogid-mcp-tunnel.service"
systemctl --user daemon-reload
systemctl --user enable --now ogid-mcp-tunnel
systemctl --user status ogid-mcp-tunnel
loginctl show-user "$USER" -p Linger
```

Una sesión screen no garantiza recuperación al reiniciar el host. La unidad de usuario necesita sesión o linger; instalar el túnel no hace persistente el backend. Definir el servicio backend según la instalación real, con su directorio y dotenv propios. No se ha habilitado linger ni instalado servicios nuevos en esta implementación. Probar recuperación de ambos tras reinicio/salida antes de prometer disponibilidad programada.

## ChatGPT

Abrir la conexión OGID existente en chatgpt.com/plugins. En la pantalla de gestión de la aplicación, pulsar **Actualizar herramientas** (Refresh), conservar su túnel, revisar diez herramientas/esquemas/permisos e iniciar una conversación nueva con OGID seleccionado. Comprobar `ogid_health` (versión 0.3.0) y `ogid_get_capabilities`. Este botón refresca el contrato anunciado; para cargar cambios de código hay que reiniciar primero los procesos afectados. El estado `dev mode` de la pantalla no muestra la versión del adaptador. Solo recrearla si no se puede recuperar; no duplicar tareas ni conexión. Véanse EVALUACION-CHATGPT.md y TAREAS-CARTERA.md.

[Conectar y refrescar el plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt), [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).
