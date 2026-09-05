# llama.cpp por Tailscale: integración y despliegue de OGID

El proveedor `llamacpp` consume `/v1/chat/completions` desde el backend. La primera puesta en marcha debe usar `shadow`. Los cambios de código no despliegan la VM, no modifican su `.env` ni configuran Fedora, Tailscale, systemd, Nginx o PM2. Esta guía se ejecuta manualmente en Google Cloud después de aprobar y publicar una revisión que contenga la integración.

## Arquitectura y compatibilidad

`createAiProvider()` selecciona `NoopAiProvider`, `NvidiaNimProvider` o `LlamaCppProvider`. El adaptador llama.cpp está separado en `backend/services/ai/llamaCppProvider.js` y se exporta también desde `aiProviders.js`. Las utilidades de URL, JSON, uso y metadatos están en `aiProviderUtils.js`.

La ruta de ejecución sigue siendo:

```text
Snapshots deterministas → AiEnrichmentCoordinator → proveedor seleccionado
                                                   ↓
                                         AiBudgetService + ProviderRuntime
                                                   ↓
                           AJV + grounding → AiEnrichmentStore
                                                   ↓
                               proyección existente + ai:update:v1
```

El coordinador conserva la cola, concurrencia, prioridad, features, validadores, caché y persistencia. Los resúmenes usan `summaryModel`; país y mercado usan `reasoningModel`. El alias solicitado identifica el modelo en el registro y la caché; `providerResponse.payloadModel` registra el nombre devuelto sin exigir coincidencia. Cambiar el proveedor, alias, entrada o versiones invalida la clave existente; reemplazar un GGUF bajo el mismo alias requiere un alias nuevo para evitar reutilizar resultados del modelo anterior.

NVIDIA conserva `guided_json`, su formato alternativo explícito, el sondeo 202 de NIM y la coincidencia estricta del modelo. llama.cpp no utiliza estos comportamientos. Los valores de entorno de ambos proveedores permanecen separados. `AI_PROVIDER` ausente o vacío sigue significando `none`; un valor desconocido ahora falla explícitamente con `AI_PROVIDER_INVALID`, incluso si el modo es `off`. La inyección de proveedores de las pruebas se conserva.

Los prompts existentes ya exigen un único objeto JSON sin Markdown, referencias suministradas y entidades copiadas de la evidencia. AJV y los validadores existentes siguen siendo la autoridad final para los tres features, también con `LLAMACPP_JSON_MODE=off`. No se relajan los controles de país, instrumento, recomendaciones financieras o causalidad.

## Contrato JSON y límites

La [documentación oficial del servidor llama.cpp](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#post-v1chatcompletions-openai-compatible-chat-completions-api), consultada el 5 de septiembre de 2026, documenta este contrato:

```json
{"response_format":{"type":"json_schema","schema":{"type":"object"}}}
```

OGID envía el esquema real del trabajo como objeto. No utiliza el esquema serializado de NIM/SGLang. La compatibilidad de la versión instalada en Fedora se comprueba con el smoke manual; no se presupone que coincida con la versión documentada.

| JSON mode | Comportamiento |
| --- | --- |
| `off` | Omite `response_format`; mantiene el mismo prompt y validación. |
| `on` | Envía el esquema; cualquier incompatibilidad falla explícitamente. |
| `auto` | Envía el esquema; permite un único fallback sin formato ante un HTTP 400/422 cuyo error identifica explícitamente `response_format` como no soportado. |

El fallback y los reintentos transitorios comparten `AI_MAX_RETRIES`. Con `1` hay como máximo **dos POST por generación lógica**; con `0` no hay segunda llamada, tampoco fallback. Cada POST reserva una petición y tokens en el presupuesto existente. Un 400/422 consume una petición y cero tokens; una respuesta válida liquida el uso devuelto. La ausencia de uso, ceros o un resultado incierto de red consumen la estimación reservada. Si el presupuesto impide el segundo intento, no se realiza. `formatFallbacks` y `retries` se presentan por separado.

401/403, 429, 5xx, errores de red y timeout nunca activan el fallback de formato. Solo los errores transitorios reintentables pueden consumir la segunda llamada con el mismo formato y una espera acotada. Errores de autenticación, JSON, grounding o validación no se reintentan. Un 202 falla sin sondear `/status`. Los redirects se rechazan para mantener las credenciales y el tráfico en el destino configurado.

El runtime puede almacenar temporalmente el cuerpo en memoria (`bufferResponse`) para mantener activo el timeout y la plaza de concurrencia hasta recibir la respuesta completa. Solo llama.cpp y su smoke activan esta opción; no introduce almacenamiento de respuestas crudas en disco. El timeout es **por intento**; con dos intentos el tiempo total puede acercarse a dos timeouts más la espera. La concurrencia inicial es uno para corresponder a `llama-server -np 1`.

Los metadatos contienen modelos, request ID, estado HTTP, finish reason, uso, tipo/longitud de contenido y presencia de reasoning. No contienen prompts, contenido generado crudo ni reasoning. Los textos de errores del servidor solo se inspeccionan para clasificar la incompatibilidad y no se persisten en los diagnósticos llama.cpp. El campo `output` del enriquecimiento sigue almacenando únicamente el objeto aceptado por los validadores.

## Qwen: comprobar JSON antes de desplegar

En la prueba local del 5 de septiembre de 2026, Qwen devolvió HTTP 200 con `finishReason=stop`, 303 tokens y contenido que no era JSON. La misma petición mínima con `chat_template_kwargs: {"enable_thinking": false}` devolvió el objeto esperado en seis tokens. Esto acredita la prueba de conectividad; los enriquecimientos completos requieren validar también el esquema y la evidencia.

En el servidor Fedora ya configurado, comprobar qué unidad y alias atienden el puerto antes de cambiar su configuración. Para establecer el modo sin razonamiento explícito por defecto, la versión instalada debe admitir este argumento dentro de su `ExecStart` existente:

```ini
    --jinja \
    --chat-template-kwargs '{"enable_thinking":false}' \
```

Este cambio corresponde al servicio llama.cpp y afecta a su comportamiento por defecto para los clientes. OGID no lo aplica automáticamente ni expone una variable `LLAMACPP_ENABLE_THINKING`. El modo puede cambiar la calidad de los análisis complejos: revisar muestras reales antes de promover a visible. La [documentación de Qwen](https://huggingface.co/Qwen/Qwen3.8-27B#instruct-or-non-thinking-mode) describe ambos modos.

El smoke muestra `responseMetadata` también cuando falla. `httpStatus=200` con `AI_INVALID_JSON` identifica un problema del contenido generado; `finishReason=length` señala que se alcanzó el límite de generación. `hasReasoningContent`, `contentLength` y `usage` ayudan a diagnosticarlo sin publicar el texto crudo. Un fallo de red sin respuesta mantiene `httpStatus=null`.

## Configuración

No reemplazar el `.env` existente. Conservar las demás variables, en particular `ADMIN_API_TOKEN`, `ALLOW_LOCAL_ADMIN=0`, fuentes y configuración de mercado.

| Variable nueva | Valor predeterminado / significado |
| --- | --- |
| `LLAMACPP_BASE_URL` | Vacío; obligatorio al activar el proveedor. Usar la base terminada en `/v1`. |
| `LLAMACPP_API_KEY` | Vacío; obligatorio en destinos remotos. Loopback puede funcionar sin clave si el servidor lo permite. |
| `LLAMACPP_MODEL_SUMMARY` | Vacío; obligatorio al activar el proveedor. |
| `LLAMACPP_MODEL_REASONING` | Si está vacío, reutiliza el modelo de resumen. |
| `LLAMACPP_JSON_MODE` | `auto`; acepta `auto`, `on`, `off`. |
| `LLAMACPP_ALLOW_PRIVATE_HTTP` | `0`; requiere opt-in para HTTP remoto. |
| `HOST` | Sin valor mantiene el comportamiento previo de escucha. En producción usar `127.0.0.1`. |

Perfil inicial de producción, con valores ficticios:

```env
HOST=127.0.0.1
PORT=3000
ALLOW_LOCAL_ADMIN=0
AI_PROVIDER=llamacpp
AI_MODE=shadow
AI_FEATURES=article-summary,country-insight,market-explanation
AI_DAILY_REQUEST_BUDGET=50
AI_DAILY_TOKEN_BUDGET=100000
AI_MAX_CONCURRENCY=1
AI_QUEUE_MAX=20
AI_MAX_JOBS_PER_CYCLE=6
AI_TIMEOUT_MS=180000
AI_MAX_RETRIES=1
AI_MAX_INPUT_CHARS=6000
AI_MAX_OUTPUT_TOKENS=4096
AI_STATE_FILE=data/ai/ai-enrichments.json
AI_BUDGET_STATE_FILE=data/ai/ai-budget.json
LLAMACPP_BASE_URL=http://<AI_SERVER_TAILSCALE_HOST>:8080/v1
LLAMACPP_API_KEY=<LLAMACPP_API_KEY>
LLAMACPP_MODEL_SUMMARY=qwen3.8-27b
LLAMACPP_MODEL_REASONING=qwen3.8-27b
LLAMACPP_JSON_MODE=auto
LLAMACPP_ALLOW_PRIVATE_HTTP=1
DISABLE_BACKGROUND_REFRESH=0
```

El `.env.example` general conserva `none/off`. `.env.production.example` incluye el perfil shadow con host ficticio y clave vacía; necesita configuración local antes de arrancar.

El perfil mantiene una generación simultánea para el servidor de un slot. Los seis trabajos son nuevas incorporaciones por ciclo, no seis peticiones simultáneas. La cola admite veinte trabajos entre pendientes y activos; la caché evita repetir entradas ya aceptadas. Los presupuestos son compartidos por los tres features, incluyen reintentos y persisten entre reinicios; se renuevan al cambiar el día UTC. El coordinador no adapta todavía estos límites según GPU o slots. El límite de salida de 4096 permite los análisis de país observados, de más de 1600 tokens, sin imponer esa longitud a todas las respuestas.

HTTP sin TLS solo debe utilizarse dentro de una red privada cifrada como Tailscale. Se permite loopback sin opt-in. Para destinos remotos, se exige el flag y una clave; las IP literales se restringen a RFC1918, el rango Tailscale `100.64.0.0/10` y direcciones IPv6 locales `fc00::/7`. Se rechazan IP públicas, direcciones no especificadas y link-local. Los nombres MagicDNS como `ai-server` se aceptan con flag y clave. No se realiza DNS durante el arranque: el operador debe verificar que el nombre resuelve al servidor del túnel, no a una IP pública. El flag no comprueba ni crea el túnel. HTTPS remoto sigue disponible con clave. URLs con credenciales embebidas o protocolos distintos de HTTP/HTTPS son inválidas; query y fragment se eliminan.

No abrir el puerto 8080 en el router doméstico ni publicar el puerto 3000 de la VM.

## Actualizar la copia desplegada

Ejecutar como el usuario que administra el proceso PM2 existente. Node 24 es la base del repositorio; el manifiesto admite Node 22–26. Ejecutar estas instrucciones después de fusionar el PR de integración en `main` y comprobar que su CI pasó. Publicar la rama por sí solo no actualiza la VM.

```bash
cd /var/www/ogid
git status --short
test -z "$(git status --porcelain)" || { echo 'Hay cambios locales: revisarlos antes de desplegar.'; exit 1; }
git fetch origin
git switch main
git pull --ff-only origin main
git log -1 --oneline
test -f backend/services/ai/llamaCppProvider.js || { echo 'La revision no contiene la integracion llama.cpp.'; exit 1; }
cd /var/www/ogid/backend
node --version
npm ci && npm run check && npm test && npm run build && npm audit --omit=dev --audit-level=high
```

Si falla algún comando, resolver el fallo antes de reiniciar. No usar `reset --hard`, no borrar archivos de estado ni copiar un ejemplo sobre `.env`. Los scripts actuales no definen lint ni typecheck separados; `build` ejecuta la comprobación de sintaxis.

Guardar una copia privada fuera del repositorio y editar el `.env` existente:

```bash
umask 077
OGID_BACKUP_DIR="$HOME/.local/state/ogid"
mkdir -p "$OGID_BACKUP_DIR"
chmod 700 "$OGID_BACKUP_DIR"
cp .env "$OGID_BACKUP_DIR/env-before-llamacpp-$(date +%Y%m%d-%H%M%S)"
chmod 600 .env
nano .env
```

Introducir el perfil anterior con el host y la clave reales exclusivamente en ese archivo. Mantener el token administrativo ya existente. El smoke y PM2 deben ejecutarse con el mismo usuario y directorio de backend que utiliza la aplicación.

## Comprobar la VM antes del reinicio

Estos comandos leen las claves de `.env` y crean cabeceras temporales de modo 600. Las claves no aparecen en argumentos de procesos ni en el historial. Ejecutar los bloques siguientes en la misma sesión Bash. No activar trazas de shell ni `curl -v`.

```bash
cd /var/www/ogid/backend
umask 077
export OGID_CHECK_DIR="$(mktemp -d)"
trap 'rm -rf "$OGID_CHECK_DIR"' EXIT
node --input-type=module <<'NODE'
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LlamaCppProvider } from './services/ai/aiProviders.js';
const provider = new LlamaCppProvider({
  baseUrl: process.env.LLAMACPP_BASE_URL,
  apiKey: process.env.LLAMACPP_API_KEY,
  summaryModel: process.env.LLAMACPP_MODEL_SUMMARY,
  reasoningModel: process.env.LLAMACPP_MODEL_REASONING,
  allowPrivateHttp: process.env.LLAMACPP_ALLOW_PRIVATE_HTTP === '1',
  jsonMode: process.env.LLAMACPP_JSON_MODE || 'auto'
});
if (!process.env.ADMIN_API_TOKEN) throw new Error('ADMIN_API_TOKEN requerido');
for (const [name, value] of Object.entries({
  'ai-base': provider.baseUrl.toString(),
  'ai-host': provider.baseUrl.hostname,
  'llama-header': `Authorization: Bearer ${provider.apiKey}\n`,
  'admin-header': `Authorization: Bearer ${process.env.ADMIN_API_TOKEN}\n`
})) writeFileSync(join(process.env.OGID_CHECK_DIR, name), value, { mode: 0o600 });
NODE
OGID_AI_BASE="$(cat "$OGID_CHECK_DIR/ai-base")"
tailscale status
tailscale ping "$(cat "$OGID_CHECK_DIR/ai-host")"
curl --fail --silent --show-error --connect-timeout 5 --max-time 10 \
  "${OGID_AI_BASE%/v1}/health"
curl --fail --silent --show-error --connect-timeout 5 --max-time 10 \
  "$OGID_AI_BASE/models" --header "@$OGID_CHECK_DIR/llama-header"
RUN_LIVE_LLAMACPP_SMOKE=1 npm run smoke:llamacpp
```

Se esperan salud correcta y una lista de modelos no vacía. El smoke realiza un GET de modelos y una generación JSON breve, usando `LlamaCppProvider`, un presupuesto aislado en memoria y timeouts explícitos. No lee ni modifica el presupuesto persistente de producción, no imprime la clave y no se ejecuta en CI/`npm test`. Sin `RUN_LIVE_LLAMACPP_SMOKE=1`, se omite sin tráfico. Un resultado correcto comprueba conectividad y contrato, no la calidad de las tres clases de enriquecimiento. No se debe ampliar el timeout o desactivar validadores para ocultar un error del smoke.

## Reiniciar el proceso PM2 correcto

```bash
pm2 list
read -r -p 'Nombre exacto del proceso OGID existente: ' OGID_PM2_NAME
test -n "$OGID_PM2_NAME" || exit 1
pm2 describe "$OGID_PM2_NAME"
pm2 restart "$OGID_PM2_NAME" --update-env
pm2 list
pm2 logs "$OGID_PM2_NAME" --lines 80 --nostream | rg 'api_config_status|ai_enrichment_failed|server_started|startup_failed'
ss -ltn 'sport = :3000'
curl --fail --silent --show-error --connect-timeout 5 --max-time 10 \
  http://127.0.0.1:3000/api/health
curl --fail --silent --show-error --connect-timeout 5 --max-time 10 \
  https://dashboard.clobig.com/api/health
curl --fail --silent --show-error --connect-timeout 5 --max-time 10 \
  http://127.0.0.1:3000/api/admin/pipeline-status \
  --header "@$OGID_CHECK_DIR/admin-header"
curl --fail --silent --show-error --connect-timeout 5 --max-time 10 \
  'http://127.0.0.1:3000/api/admin/ai-enrichments?page=1&pageSize=50' \
  --header "@$OGID_CHECK_DIR/admin-header"
```

No ejecutar `pm2 start` ni crear otra instancia. Confirmar en `pm2 describe` que el script y cwd corresponden a `/var/www/ogid/backend`. PM2 puede conservar variables que prevalecen sobre dotenv: si la configuración observada no coincide con `.env`, revisar solo los nombres de variables relevantes del perfil existente y corregir su origen antes de continuar; no volcar secretos mediante `pm2 env`, `pm2 jlist` o `cat .env`. No guardar una configuración PM2 incorrecta.

Verificar `127.0.0.1:3000` en `ss`, proceso `online`, salud local y HTTPS, y estos campos de `data.ai`:

- `configuredProvider=llamacpp`, `activeProvider=llamacpp`, `mode=shadow`.
- Los tres features y ambos modelos `qwen3.8-27b`.
- `jsonMode=auto`, `apiKeyConfigured=true`, endpoint del servidor del túnel.
- Cola que progresa, presupuesto que contabiliza intentos y circuit breaker `closed`.
- Sin errores de autenticación; registros `ready`, `rejected` o `failed` con códigos de diagnóstico seguros.

País requiere al menos dos clusters y dos publishers independientes; mercado requiere evidencia vinculada e impacto determinista. La ausencia de estos trabajos puede ser falta de evidencia elegible, no un fallo de transporte. Los motivos se encuentran en `eligibility`. En shadow, los resultados permanecen en administración y disco; las proyecciones REST y WebSocket no publican el texto generado.

La vista `/admin` muestra `AI Enrichment` y `AI Enrichments`, actualizadas cada 60 segundos, y exige autenticación en producción. La tabla solo presenta una vista previa; el endpoint autenticado `ai-enrichments` incluye `output`, `provenance`, `validation` y `providerResponse`. Revisar registros nuevos con `provider=llamacpp`: el historial de NVIDIA se conserva y no acredita la integración nueva. `ready` implica que pasaron los controles automáticos; revisar además que el texto se apoya en las fuentes.

Solo después de confirmar que el proceso correcto está online y las comprobaciones son correctas:

```bash
pm2 save
rm -rf "$OGID_CHECK_DIR"
unset OGID_CHECK_DIR
trap - EXIT
```

No se cambia a `visible` durante este despliegue.

## Limpieza posterior

Eliminar únicamente las cabeceras temporales con el bloque anterior. Conservar `.env`, la copia privada de respaldo, `data/ai/ai-enrichments.json` y `data/ai/ai-budget.json`; no borrar resultados ni presupuestos para aparentar un arranque limpio. Verificar `git status --short` en `/var/www/ogid`: la configuración y los estados deben seguir ignorados por Git. Mantener una sola instancia PM2 del backend. Si la prueba local ya terminó, detener ese `npm run dev` evita que siga consumiendo capacidad del mismo servidor IA junto a la VM.

## Observación, caída del proveedor y promoción

Revisar una muestra suficiente de cada tipo de trabajo: proporción `ready`, JSON inválido, `finishReason=length`, evidencia/entidades inexistentes, país o instrumento incorrectos, recomendaciones o causalidad prohibidas. Revisar tokens por petición, cola, tiempo medio (`transport.latencyMs / transport.calls`), última/máxima duración lógica, reintentos, fallback y circuit breaker. Revisar en Fedora los reinicios y errores CUDA mediante el procedimiento operativo existente.

Una caída del servidor o Tailscale deja el trabajo en `failed` con diagnóstico seguro, conserva resultados aceptados anteriores como `stale` durante la actualización y permite que continúen noticias, mercado, awareness, salud y WebSockets. La deduplicación cubre trabajos pendientes y activos; varios fallos sucesivos conservan la referencia al último resultado aceptado. El circuit breaker usa el umbral y recuperación del runtime existente; un nuevo trabajo tras la recuperación prueba de nuevo el proveedor. Los presupuestos y límites de cola siguen aplicándose, también durante la caída. Las pruebas automatizadas simulan estas situaciones sin conectarse al servidor Fedora.

Cuando la muestra sea estable, comprobar que la proyección existente llega al frontend correctamente y decidir por separado la promoción manual a `AI_MODE=visible`. Si cambia el modo, reiniciar el mismo proceso y volver a verificar. No eliminar estados ni presupuestos para forzar resultados favorables.

## Rollback

Editar únicamente estas variables en el `.env` existente:

```env
AI_PROVIDER=none
AI_MODE=off
```

Conservar `HOST=127.0.0.1`, `PORT=3000`, `ALLOW_LOCAL_ADMIN=0`, el token administrativo y los archivos de estado. Ejecutar como el usuario propietario de PM2:

```bash
cd /var/www/ogid/backend
nano .env
pm2 list
read -r -p 'Nombre exacto del proceso OGID existente: ' OGID_PM2_NAME
test -n "$OGID_PM2_NAME" || exit 1
pm2 restart "$OGID_PM2_NAME" --update-env
pm2 list
curl --fail --silent --show-error --connect-timeout 5 --max-time 10 \
  http://127.0.0.1:3000/api/health
```

Repetir la consulta administrativa autenticada con una cabecera temporal y confirmar `activeProvider=none`, `mode=off`, `enabled=false` y cero llamadas del transporte desde el reinicio. Guardar con `pm2 save` solo tras confirmar el proceso online y la salud. No se necesita migración ni borrado de resultados. Si PM2 conserva variables contradictorias, corregir su origen de la misma forma que en el despliegue antes de afirmar que el rollback está aplicado.
