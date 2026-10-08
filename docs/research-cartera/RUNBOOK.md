# Activación posterior, persistencia y rollback

Evolución actual: contrato 1.2.0 / MCP 0.4.0. Consultar [histórico por rango, CSV, identidad de eventos y pendientes](HISTORICO-E-IDENTIDADES.md) antes de activar este paquete.

Procedimiento preparado; **no ejecutado en esta entrega**. La autorización actual excluye despliegue, merge, push, PR remoto y cambios de tareas ChatGPT. Usar el checkout completo backend+adaptador de la misma revisión tras aprobar la activación.

## Instalación y procesos encontrados

En este host Fedora: Node /usr/bin/node v22.23.3, screen /usr/bin/screen, sesiones detached `3990.ogid` y `345952.ogid-mcp-research`. No apareció una unidad de usuario OGID/tunnel en list-units. Se observó un backend `node --watch server.js`; no se reinició deliberadamente, no se certificó el código cargado ni se consultó su health. No se abrieron perfiles privados o credenciales. Una sesión screen no acredita recuperación al reiniciar el host.

Terminal del host, desde /home/fedora/ogid; en IDE Flatpak preceder los comandos con flatpak-spawn --host y directorio explícito:

```sh
cd /home/fedora/ogid
node --version
git status --short
git log -4 --oneline
npm --prefix backend run check
npm --prefix integrations/ogid-mcp run check
npm --prefix integrations/ogid-mcp run inventory:check
npm --prefix backend test
npm --prefix integrations/ogid-mcp test
npm --prefix backend run build
npm --prefix backend audit --omit=dev --audit-level=high
screen -ls
systemctl --user list-units --all --type=service
```

Si se prepara otro checkout, instalar usando sus lockfiles (`npm --prefix backend ci`, `npm --prefix integrations/ogid-mcp ci --ignore-scripts`). No copiar node_modules entre revisiones ni instalar una segunda instancia en el mismo puerto. No alterar .env o perfiles existentes a ciegas.

## Persistencia y configuración

| Variable / archivo | Uso y migración |
| --- | --- |
| RESEARCH_LEDGER_FILE; backend/data/intel/research-ledger.json | Nuevo research-ledger-v1: events/jobs/holdings/companyFacts/sourceStates/forecasts. Atómico, 600; máximo 64 MiB y 20 000 por tabla; corrupción falla cerrada |
| RESEARCH_ALERT_STATE_FILE; backend/data/intel/research-alerts.json | MaterialAlertStore v1 leído y actualizado aditivamente a v2 en la siguiente escritura; añade escenarios/señales/consumidores/journal/firma de cursor. 32 MiB journal, 10 000 estados por tipo, 1 000 consumidores |
| RESEARCH_NEWS_ARCHIVE_FILE | Archivo existente sin migración destructiva; cursores de noticias expiran al reiniciar, metadata permanece |
| MARKET_HISTORY_DIR / data/market | Store existente: upsert y hasta 20 revisiones OHLCV por vela. No se reescribe todo el histórico al arrancar; reconciliar explícitamente |
| RESEARCH_SOURCES_FILE | JSON local opcional con companies/instruments/sources. Registra identidades antes de restaurar watchlist; debe acompañar los datos al restaurar |
| RESEARCH_SEC_USER_AGENT | Identificación/contacto requerido por SEC, nunca publicado en MCP. No es una credencial de proveedor de pago |
| RESEARCH_SIGNAL_POLICY_FILE | JSON local opcional, umbrales positivos, hysteresis<1, methodVersion y benchmarkInstrumentId verificado opcional |
| MCP_OPERATOR_CREDENTIALS_FILE / OGID_OPERATOR_CREDENTIAL_FILE | Archivos privados existentes; backend credentials[] y adaptador token/scopes. Nuevos scopes enumerados en API-CHANGES. No dar operador a tareas de investigación |
| OGID_BUILD_COMMIT / OGID_BUILD_TIME | Metadata opcional declarada por el proceso de build; SHA/fecha ISO. No demuestra atestación ni reemplaza artifactHash capturado |

Rutas research por defecto relativas al backend; preferir rutas absolutas verificadas en una activación. Sin fuentes nuevas configuradas no hay solicitudes SEC/IR/emisor. Los ciclos existentes siguen funcionando y añaden persistencia local de eventos/escenarios. Lecturas no fuerzan colectores. No hay daemon histórico ilimitado: ejecutar runs acotados según cuotas.

Ejemplo de política local sin benchmark elegido:

```json
{"methodVersion":"scenario-signals-v1","breakoutAtr":0.25,"anomalyAtr":1.5,"relativeVolume":2,"hysteresis":0.75,"cooldownMs":1800000,"expiryMs":604800000}
```

Añadir benchmarkInstrumentId solo tras verificar instrumento/divisa/mercado. Sin él no se generan anomalías relativas. relative-return-anomaly usa exceso de retorno del último par de cierres exactos dividido por ATR/precio; no convierte divisas. Volumen intradía compara la misma franja local de sesiones previas. Cambiar umbrales exige versionar la política y revisar las transiciones resultantes.

Respaldar con procesos identificados detenidos para obtener una copia consistente entre archivos. Conservar .env, perfiles, datos e identidades de forma privada. Ejemplo **posterior a la autorización de activación**:

```sh
OGID_BACKUP_DIR="$HOME/.local/state/ogid/research-backup-$(date +%Y%m%dT%H%M%S)"
install -d -m 700 "$OGID_BACKUP_DIR"
cp -a backend/data "$OGID_BACKUP_DIR/backend-data"
cp -p backend/.env "$OGID_BACKUP_DIR/backend.env"
chmod 600 "$OGID_BACKUP_DIR/backend.env"
```

Respaldar también las rutas personalizadas de research, RESEARCH_SOURCES_FILE, políticas y perfiles reales fuera de Git; los comandos anteriores solo cubren defaults. No publicar archivos o logs de esa copia. Ante capacidad/error de ledger, el hook de investigación informa blocked/pendingReplay en capabilities y event-impact sin interrumpir noticias/mercado/WebSocket. Un éxito posterior conserva partial hasta reconciliar; este estado de supervisión es de proceso, no un recibo durable. El archivo de noticias conserva la evidencia, pero no hay replay automático completo: archivar/reparar con procesos detenidos y reconciliar lotes mediante EventLedger.ingest sobre una copia revisada del archivo, verificando cobertura antes de reactivar. No borrar el ledger para aparentar recuperación.

Stores JSON requieren **un solo escritor**; varios workers necesitan almacenamiento transaccional compartido antes de habilitarse.

## Arranque y verificación después de aprobar

Comprobar primero quién ocupa 3000 y qué ejecuta cada screen. Entrar únicamente en la sesión OGID identificada, detener su proceso con Ctrl+C y arrancar desde el checkout aprobado:

```sh
cd /home/fedora/ogid
npm --prefix backend start
```

No inventar PM2 ni instalar systemd durante esta entrega. Si después se usa una unidad ya validada, reiniciar esa unidad concreta. Reiniciar luego el cliente del túnel que lanza el adaptador por stdio; una instancia por tunnel_id. La plantilla versionada usa tunnel-client 0.0.15, env -i, research y autorización runtime; comprobar la versión instalada antes de usarla:

```sh
"$HOME/.local/bin/tunnel-client" --version
"$HOME/.local/bin/tunnel-client" doctor --profile-file "$HOME/.config/ogid-mcp/tunnel-client.yaml" --explain
"$HOME/.local/bin/tunnel-client" run --profile-file "$HOME/.config/ogid-mcp/tunnel-client.yaml"
```

Usar las rutas reales si difieren. No ejecutar run si ya existe una instancia. [Runbook Fedora previo](../../integrations/ogid-mcp/RUNBOOK-FEDORA.md) y [plantilla](../../integrations/ogid-mcp/deploy/tunnel-client.profile.example.yaml).

```sh
curl --fail --silent --show-error http://127.0.0.1:3000/api/health
curl --fail --silent --show-error http://127.0.0.1:3000/api/capabilities
OGID_PROFILE=research OGID_INSTRUMENT_AUTH=runtime npm --prefix integrations/ogid-mcp run smoke
curl --fail --silent --show-error http://127.0.0.1:8766/healthz
curl --fail --silent --show-error http://127.0.0.1:8766/readyz
```

Esperar contrato 1.2.0, adaptador 0.4.0, diez herramientas research, hashes capturados, fechas/cobertura/ausencias coherentes y runningCommitVerified=false. Comparar hash con el artefacto revisado y conservar evidencia privada; checkoutCommit no certifica el proceso. Smoke existente cubre herramientas/paquetes legacy; las operaciones nuevas se verifican con las llamadas siguientes. readyz acredita transporte local, no tareas ni entrega a ChatGPT.

## Adquisición y comprobación funcional

Con conexión operador separada, credencial de alcance y fuentes verificadas; los cuerpos son argumentos de ogid_operator, no se interpolan tokens en shell:

```json
{"operationId":"market.history.create","body":{"requestId":"pilot-2026-10","instrumentIds":["ID_VERIFICADO"],"targetBars":500}}
{"operationId":"market.history.run","body":{"jobId":"ID_DEVUELTO","maxRequests":1}}
{"operationId":"research.sources.run","body":{"sourceIds":["FUENTE_LOCAL_ADMITIDA"],"maxRequests":1}}
{"operationId":"research.scenarios.refresh","body":{"instrumentIds":["ID_VERIFICADO"]}}
```

Guardar jobId, consultar market.history.job y repetir run solo cuando nextRetryAt lo permita. completed significa ventanas terminadas, **goalMet** valida barras disponibles. Ventanas hasta 181 días, solape, 5 años máximo y 3 intentos por ventana; blocked exige revisar la fuente y crear otro job de reconciliación con requestId nuevo. No se garantiza 2500 barras en cinco años. No hay segunda fuente independiente ni retorno total verificado; adjClose Yahoo se conserva separado si llega.

Fuentes: completar [sources.example.json](sources.example.json) con evidencia de empresa/CIK y de instrumento/ISIN/MIC, URL pública admitida, enabled=true y verifiedAt. [universe.example.json](universe.example.json) solo lista estudio, no catálogo activo ni selección UCITS. SEC usa submissions/companyfacts; conceptos companyfacts explícitos y fecha filed sin aceptación intradía unida. RSS oficial cubre IR/macro/regulación/contratos admitidos; no se descargan PDFs ni se sortean paywalls. issuer-holdings-json necesita JSON normalizado del emisor (asOf, isin, instrumentId, holdings[{name,weight}], complete; opcionales nav/navCurrency/navAsOf/ongoingCharge/costAsOf); no implementa CSV/HTML universal. Identidades y feeds concretos permanecen pendientes hasta validación real.

Consultas research mediante ogid_query:

```json
{"operationId":"market.technical-context","parameters":{"instrumentId":"ID_VERIFICADO","package":"standard-v1"}}
{"operationId":"research.event-impact","parameters":{"instrumentIds":["ID_VERIFICADO"]}}
{"operationId":"research.scenarios","parameters":{"instrumentIds":["ID_VERIFICADO"]}}
{"operationId":"signals.delta","parameters":{"consumerId":"revision-manual","limit":10}}
{"operationId":"etf.holdings","parameters":{"instrumentId":"ID_ETF_VERIFICADO","limit":50}}
{"operationId":"research.forecast-evaluation","parameters":{"instrumentIds":["ID_VERIFICADO"]}}
```

Revisar calidad/origen/asOf/seriesRevision/warmup, no solo ok. Para holdings continuar con nextOffset y snapshotId; cambio devuelve HOLDINGS_SNAPSHOT_CHANGED. N/D no acredita ausencia económica. Yahoo se declara web-delayed; live global no significa tiempo real.

Para signals.delta, recorrer nextCursor sin reconstruir filtros, guardar changeId para deduplicar; leer no avanza checkpoint. Solo tras procesar **delta global** completo, signals.checkpoint con checkpointCursor y expectedSequence del checkpoint leído. CURSOR_EXPIRED obliga reiniciar explícitamente; CHANGE_RETENTION_GAP exige revisar escenarios y recuperar mediante signals.recover con secuencia actual/motivo. No fingir entrega ni usar checkpoint filtrado que salte otros activos. Retención 30 días o capacidad. No existe recibo durable ChatGPT; las tareas research pueden volver a ver cambios entre ejecuciones.

Para evaluación registrar mediante research.forecast.register objetivo return/relative-return/direction, modelo, horizonte 1–720h y valores antes del resultado. issuedAt omitido usa ahora; retroactividad >60s y evidencia futura se rechazan. Precios deben estar cerrados, disponibles y actualizados; benchmark exacto/divisa compatible. Costes requieren commissionBps/spreadBps/slippageBps; sin ellos netReturn=null. Registro idempotente por forecastId; duplicado semántico se rechaza. Brier solo para probabilidad de modelo explícita de retorno absoluto positivo. No convertir confidence a probabilidad ni rellenar retrospectivamente el piloto.

## Rollback conservando evidencia

Detener backend y túnel identificados. Conservar copia íntegra de los datos **posteriores** a la activación antes de restaurar. Recuperar código anterior en otro directorio con `git worktree add --detach /RUTA/rollback-ogid SHA_PREVIO_VERIFICADO`, instalar sus lockfiles y dirigir procesos a ese directorio; no reset --hard ni git clean. Restaurar configuración previa y datos preactivación en rutas separadas. Los datos nuevos se mantienen archivados para análisis/importación posterior.

**Importante:** el código anterior de MaterialAlertStore solo lee v1; un archivo v2 no es retrocompatible para ese lector. Opción preferida: usar la copia v1 previa en el runtime antiguo y conservar v2 intacto. Si se necesita preservar reconocimientos legacy posteriores, preparar una copia v1 con el script siguiente; nunca escribir sobre el v2 ni ejecutar con procesos activos:

```sh
node --input-type=module - /RUTA/privada/research-alerts-v2.json /RUTA/rollback/research-alerts-v1.json <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const [source,target]=process.argv.slice(2);
if(source===target)throw new Error('destino debe ser distinto');
const data=JSON.parse(readFileSync(source,'utf8'));
if(data.schemaVersion!=='material-alerts-v2'||!Array.isArray(data.observed)||!Array.isArray(data.acknowledged))throw new Error('schema inválido');
writeFileSync(target,JSON.stringify({schemaVersion:'material-alerts-v1',observed:data.observed,acknowledged:data.acknowledged}),{mode:0o600,flag:'wx'});
JS
```

La copia v1 omite escenarios/journal/checkpoints, que permanecen en v2; no simular que el runtime antiguo los sigue. Research ledger nuevo no lo lee la versión anterior. OHLCV JSONL mantiene schemaVersion=1 con campos aditivos; restaurar copia previa si se necesita reproducir exactamente el estado antiguo. Al volver a activar v2, no mezclar checkpoints restaurados a ciegas: verificar secuencias, CHANGE_HISTORY_CHANGED y revisión de snapshot. Reiniciar una única instancia del túnel con el perfil anterior y volver a refrescar esquemas del cliente.

## Actualizar ChatGPT después

Tras desplegar/reiniciar los procesos y verificar localmente, abrir la conexión OGID existente en la gestión de plugins de ChatGPT, **Refresh/Actualizar herramientas**, comprobar metadata/esquemas y abrir una conversación nueva. Flujo contrastado con [documentación oficial](https://developers.openai.com/plugins/deploy/connect-chatgpt). No recrear tareas ni tocar otros chats desde este encargo.

Invocar ogid_health y ogid_get_capabilities; verificar 0.4.0/1.2.0 y los nuevos operationId. Resolver instrumentos primero: GOOGL/GOOG son clases, ASML requiere mercado, los UCITS requieren clase/ISIN/MIC verificados y no se sustituyen por QQQ/SPY. Consumir técnica/eventos/escenarios/delta/holdings/evaluación por ogid_query. Conservar missingReason, warnings, atraso y cobertura. Un plugin refrescado no cambia por sí solo el código del servidor.

Una consulta real desde ChatGPT debe comprobarse por separado tras activar. Transporte exitoso, respuesta de herramienta y entrega final de una tarea son evidencias diferentes. Esta entrega no modifica ninguna tarea ni valida notificación, ejecución programada o recibo de entrega.

## Referencias de fuentes revisadas

- [SEC APIs oficiales](https://www.sec.gov/search-filings/edgar-application-programming-interfaces), [acceso EDGAR y fair access](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data): identificador/contacto y límite vigente publicado 10 solicitudes/s; adaptador aplica máximo 4/s y cooldown adicional.
- [NYSE calendario](https://www.nyse.com/trade/hours-calendars), [Nasdaq calendario](https://www.nasdaqtrader.com/Trader.aspx?id=Calendar), [Xetra calendario](https://www.cashmarket.deutsche-boerse.com/cash-en/trading/trading-calendar-and-trading-hours), [Euronext sesiones](https://www.euronext.com/en/trading/trading-hours-holidays). 2026 versionado; otros años parciales. XAMS 24/31 diciembre: media sesión reconocida pero hora pendiente de apéndice, sin vela inferida.

Consulta documental no es LIVE_VALIDATED del proveedor ni del runtime desplegado.
