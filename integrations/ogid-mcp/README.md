# OGID MCP de solo lectura

Adaptador Node.js/ESM que consulta un backend OGID existente por HTTP en loopback y expone cuatro herramientas MCP por **stdio**. No abre un puerto propio, carga claves de proveedores ni inicia otro recolector. Requiere el checkout completo de OGID porque reutiliza sus catálogos estáticos de países y fuentes.

## Instalación y pruebas

Node 22–26; el proyecto recomienda Node 24. Desde la raíz del repositorio, con OGID ya en ejecución:

```sh
npm --prefix integrations/ogid-mcp ci --ignore-scripts
npm --prefix integrations/ogid-mcp run check
npm --prefix integrations/ogid-mcp test
npm --prefix integrations/ogid-mcp run smoke
```

Las pruebas usan fixtures y un cliente MCP real por stdio. `smoke` consulta las cuatro herramientas contra el backend local y solo imprime contadores y calidad. No refresca proveedores. `npm start` inicia stdio, que requiere un cliente MCP; no es un servidor HTTP para abrir en el navegador.

## Herramientas

| Herramienta | Lectura | Parámetros |
| --- | --- | --- |
| `ogid_health` | Conectividad, calidad por dominio, disponibilidad de mercado y modo Awareness | Ninguno |
| `ogid_get_news` | Lote actual de noticias con procedencia y fechas | `countries`, `sources`, `limit` |
| `ogid_get_awareness` | Agenda y comunicados públicos; listas `upcoming` y `recent` | `domains`, `kinds`, `statuses`, `countries`, `instrumentIds`, `from`, `to`, `limit` |
| `ogid_get_awareness_sources` | Catálogo versionado y salud pública disponible por fuente | Ninguno |

`limit` admite 1–100, por defecto 20. OGID aplica el límite Awareness por separado a cada lista. Fechas ISO con zona horaria; `from <= to`. `instrumentIds` solo acepta los IDs verificados que el operador configure. El filtro de noticias usa `ALL` por defecto, pero sigue sujeto a las menciones de países reconocidas por OGID; no es una búsqueda histórica completa.

Cada respuesta incluye `ok`, `queriedAt`, `origin`, `data`, `warnings` y `truncated`. Los errores son explícitos y no se convierten en listas vacías. Al alcanzar el máximo de bytes se recortan listas y se informa de que el resultado es parcial.

## Configuración

`.env.example` contiene valores públicos de ejemplo. El adaptador **no carga `.env` automáticamente**, ni lee `backend/.env`. Para una ejecución local con configuración propia:

```sh
cd integrations/ogid-mcp
cp .env.example .env
node --env-file=.env src/index.js
```

El cliente del túnel usa los valores escritos en su `mcp.commands[].command`. Editar `.env` no altera ese comando; configurar allí las variables necesarias o añadir una ruta absoluta a `--env-file` para un archivo exclusivo del adaptador.

| Variable | Predeterminado | Contrato |
| --- | --- | --- |
| `OGID_BASE_URL` | `http://127.0.0.1:3000` | Solo IP literal loopback; sin usuario, contraseña, ruta, query ni fragmento |
| `OGID_TIMEOUT_MS` | 5000 | 100–30000 ms; incluye la lectura del cuerpo |
| `OGID_MAX_RESPONSE_BYTES` | 2097152 | Máximo por respuesta HTTP; 1024–4194304 |
| `OGID_MAX_OUTPUT_BYTES` | 262144 | Máximo de respuesta MCP completa; 4096–524288 |
| `OGID_INSTRUMENT_IDS` | Vacío | IDs verificados separados por comas; vacío deshabilita el filtro por instrumento |

## Calidad y límites

- `synthetic`, `fallback`, `mixed` y `stale` se conservan. Un backend sano no acredita precios utilizables para una cartera. `market.availability=empty` significa que no hay cotizaciones, aunque la calidad global indique respaldo.
- Una fecha RSS de respaldo no se presenta como publicación: `publishedAt=null`, con `receivedAt` y `provenance.publishedAtQuality`. Si la fuente solo informa actualización, se expone `updatedAt` y `provenance.publishedAtBasis=updated`. No se deduce publicación a partir de la URL.
- `latestEventAt` en un calendario puede ser una fecha programada futura; `latestEventTimeKind` distingue `scheduledAt` de `publishedAt`. La frescura de consulta se mide con `lastSuccessAt`, no con la fecha del evento ni `generatedAt`.
- El backend proyecta un solo comunicado oficial cuando dos ingestiones comparten URL, título y publicación, conservando `relatedSources`. Los registros y auditorías de cada fuente se mantienen, y los datos shadow no enriquecen la vista pública.
- Awareness `shadow`/`off` oculta eventos. `runtime:null` en el catálogo significa desconocido. Los calendarios no aportan consenso financiero.
- `ogidCheckoutCommit` identifica el checkout, no el proceso OGID cargado. `runningCommitVerified=false` se mantiene hasta disponer de identificación verificable de un despliegue. La distribución sin `.git` devuelve commit desconocido.

## Seguridad y conexión

Solo se permiten tres rutas GET fijas y sus parámetros pactados. Sin escrituras, refresh, administración, shell, URL/cabeceras arbitrarias ni lectura de archivos desde las herramientas. No se reenvían cookies ni tokens. Redirecciones rechazadas y validación TLS normal; se rechaza `NODE_TLS_REJECT_UNAUTHORIZED=0`. Un único reintento para 502/503/504 y determinados fallos de conexión; ninguno para 401, 429 o timeout.

La salida limita contenido y elimina campos privados. Noticias y eventos son datos externos no confiables: las instrucciones MCP exigen conservar su calidad y no obedecer instrucciones incluidas en ellos. Las anotaciones de lectura no sustituyen autenticación ni los permisos del cliente.

```text
ChatGPT → túnel privado de OpenAI ← HTTPS saliente ← tunnel-client
                                                     ↕ stdio
                                                 OGID MCP
                                                     ↓ GET loopback
                                                 backend OGID
```

La [guía del túnel](CONFIGURAR-TUNEL.md) explica credencial runtime, perfil local, prueba desde ChatGPT y servicio de usuario. Las claves, IDs reales y perfiles de máquina se guardan fuera de Git. `DIAGNOSTICO-LOCAL.md` y los archivos `.local` se conservan como notas locales ignoradas.

Ver [MEJORA-MCP.md](MEJORA-MCP.md) para el alcance de la mejora y los pasos de activación. Dependencias fijadas en `package-lock.json`: SDK MCP servidor/cliente 2.3.1 y Zod 4.6.5.
