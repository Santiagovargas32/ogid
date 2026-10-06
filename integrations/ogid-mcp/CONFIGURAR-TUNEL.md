# Conectar OGID a ChatGPT mediante un túnel privado

El adaptador utiliza stdio y el cliente oficial `tunnel-client`. El perfil de ejemplo corresponde a **v0.0.15**. Instalar el paquete adecuado para el sistema y arquitectura, comprobar el SHA-256 publicado y conservar sus archivos auxiliares. No basta con copiar un binario aislado del paquete.

## Perfil y credencial

1. Instalar dependencias del adaptador y comprobar OGID según [README.md](README.md).
2. Crear una carpeta de configuración fuera del repositorio. Copiar `deploy/tunnel-client.profile.example.yaml` a esa carpeta como `tunnel-client.yaml`.
3. Sustituir `RELLENAR_TUNNEL_ID` por el ID del túnel y ambas rutas `/ABSOLUTE/PATH/...` por rutas absolutas reales. YAML no expande necesariamente `~`, `$HOME` ni variables de shell.
4. Guardar la clave en `runtime-api-key`, junto al perfil: únicamente el secreto, sin asignación de variable ni comillas. Proteger carpeta con `700` y los dos archivos con `600`.

La credencial es una **API key runtime de la organización OpenAI**, obtenida en Platform; no aparece como un secreto de la suscripción personal ChatGPT y no es una clave de OGID. El principal necesita permisos Tunnels **Read + Use** en la organización del túnel. Un ID identifica el túnel y no sustituye su clave. Mantener el secreto fuera de Git, del chat y de los argumentos del proceso; `file:` permite que el cliente lea el archivo protegido.

La plantilla inicia Node con `env -i` para evitar transmitir al adaptador variables del cliente del túnel. Comprobar la ruta de Node con `command -v node`; añadir únicamente las variables `OGID_*` necesarias. La plantilla 0.2.0 añade `OGID_PROFILE=research` y `OGID_INSTRUMENT_AUTH=runtime` para resolver los símbolos verificados del backend. El comando de ejemplo no carga `.env` ni `backend/.env`.

## Prueba local y desde ChatGPT

Ejemplo para una instalación en `~/.local/bin` y configuración en `~/.config/ogid-mcp`:

```sh
~/.local/bin/tunnel-client doctor --profile-file "$HOME/.config/ogid-mcp/tunnel-client.yaml" --explain
~/.local/bin/tunnel-client run --profile-file "$HOME/.config/ogid-mcp/tunnel-client.yaml"
```

Corregir checks obligatorios de `doctor`. Mantener una sola instancia de cliente para el mismo ID. En un IDE Flatpak, ejecutar desde una terminal del host o anteponer `flatpak-spawn --host` al comando.

```sh
curl --fail --silent --show-error http://127.0.0.1:8766/healthz
curl --fail --silent --show-error http://127.0.0.1:8766/readyz
```

El puerto de diagnóstico debe estar libre y escuchar solo en loopback. La UI está en `http://127.0.0.1:8766/ui`. No necesita puertos entrantes públicos. Que ambos GET respondan 200 no demuestra por sí solo que ChatGPT pueda listar y ejecutar las herramientas.

En la UI, `Overview` permite revisar el estado y `Logs` muestra los eventos en directo. Comparar los contadores de `/health/response-delivery` antes y después de una llamada: deben aumentar `accepted` y `completed`, sin nuevos `terminal_failures`. Un evento `dispatcher forwarded command to MCP server` indica envío al MCP; los contadores y el resultado de la herramienta permiten comprobar la entrega y el éxito de la operación por separado.

En ChatGPT, crear o revisar el MCP personalizado con conexión **Tunnel**, seleccionar el túnel asociado al workspace correcto y limitar su acceso. Este adaptador no implementa OAuth de aplicación: los permisos del túnel y workspace deben corresponder al alcance de lectura previsto. Instalar/seleccionar el plugin en la conversación y ejecutar:

> Usa únicamente OGID: comprueba salud y capabilities, versión 0.2.0 y diez herramientas; resuelve NVDA/NVIDIA y ASML sin elegir un mercado ambiguo; consulta ogid_search_news para NVDA sin countries y completa sus páginas; lee un artículo y pide contexto weekly con identidad confirmada. Conserva cobertura, procedencia y calidad. Si falla, informa del error sin sustituirlo por navegación web. Ejecuta también las cuatro herramientas compatibles.

| Prueba | Criterio de aceptación |
| --- | --- |
| Salud | `ok:true`, versión esperada, calidad y disponibilidad de mercado, Awareness |
| Noticias | Lote acotado, procedencia, fechas sin verificar identificadas, sin texto completo |
| Agenda | `upcoming`/`recent`, fechas y fuentes; calendario sin fecha ficticia de 1999 |
| Fuentes | Catálogo y salud diferenciados; `runtime:null` no se interpreta como sano |
| Límites | Entradas inválidas rechazadas; no hay ogid_operator ni capacidad de refresh/mutación en investigación |

Registrar hora, herramienta y éxito/error sin secretos ni contenidos privados. Revisar `/health/control-plane` y `/health/response-delivery` junto con las respuestas reales. `/health/mcp=unknown/not_observed` puede reflejar observación limitada del protocolo y exige contrastar las llamadas. Consultas de descubrimiento a un canal `harpoon` no configurado no justifican habilitarlo cuando las herramientas OGID de `main` funcionan.

Al actualizar el código, reiniciar el backend y el cliente del túnel de forma controlada para cargarlo, y comprobar la versión por `ogid_health`. El cliente lanza y administra su hijo stdio: no iniciar además otro MCP para la misma conexión. Usar **Actualizar herramientas** (Refresh) en la gestión de la conexión existente e iniciar una conversación nueva si cambia el contrato. No hace falta editar el nombre ni la descripción para actualizar las herramientas. Ver [migración 0.2.0](MIGRACION-0.2.md) y [evaluación completa](EVALUACION-CHATGPT.md).

## Ejecución persistente

`deploy/ogid-mcp-tunnel.service` es una plantilla de usuario. Usa `%h` para la carpeta personal y supone binario en `~/.local/bin`, perfil y clave en `~/.config/ogid-mcp`. Adaptar las rutas si la instalación difiere. El perfil ya contiene la ruta absoluta al checkout; no necesita `EnvironmentFile`.

Después de verificar las diez herramientas y disponer de OGID persistente, detener el cliente en primer plano antes de iniciar el servicio:

```sh
mkdir -p "$HOME/.config/systemd/user"
cp integrations/ogid-mcp/deploy/ogid-mcp-tunnel.service "$HOME/.config/systemd/user/"
systemd-analyze --user verify "$HOME/.config/systemd/user/ogid-mcp-tunnel.service"
systemctl --user daemon-reload
systemctl --user enable --now ogid-mcp-tunnel
systemctl --user status ogid-mcp-tunnel
```

Una unidad de usuario necesita una sesión o linger para ejecutarse sin login. La persistencia del backend y la disponibilidad del host también son necesarias. Decidir esa configuración como parte del despliegue; validar recuperación de ambos procesos y acceso tras reinicio.

El éxito en una conversación no acredita acceso desde tareas programadas. Probar una tarea en el contexto y con los permisos del producto que realmente la ejecutará, comprobar su resultado y conservar avisos de calidad. No sustituir esa prueba por una llamada manual.

Para retirar la integración: detener/deshabilitar el servicio del túnel, quitar su conexión de ChatGPT y revocar la clave runtime. No requiere borrar datos de OGID.

Referencias: [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels), [conectar un plugin a ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt), [release v0.0.15](https://github.com/openai/tunnel-client/releases/tag/v0.0.15).
