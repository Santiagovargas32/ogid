# Proyección de mercado y operaciones de los workers

Corrección local del 14 de octubre de 2026 sobre
[3c45a7b, merge del ajuste de ciclo de vida](https://github.com/Santiagovargas32/ogid/commit/3c45a7b5230487be000d6efd82e4734693803bfa).
El checkout estaba limpio y coincidía con el último commit consultado en GitHub.

## Causa comprobada

`STORAGE_COMMAND_TOO_LARGE` es un rechazo del gestor antes de encolar o ejecutar
el comando: el JSON UTF-8 de `operation`, `input` y `requestId` supera
`STORAGE_MAX_COMMAND_BYTES`. No es un límite de SQLite ni un fallo de Yahoo.
`market_router_completed` confirma la adquisición de cotizaciones; el análisis
derivado ocurre después, de forma independiente.

La instancia en `localhost:3000` utiliza SQLite en
`/srv/bitcoin/ogid/db/ogid.sqlite`, sobre ext4, con ambos workers listos y un
límite efectivo de 8.388.608 bytes. En la primera inspección había 60 rechazos
en el lector de análisis, ninguno en el escritor y cero fallos de comandos en
el escritor. `market.analysis` estaba bloqueado por este código y readiness
devolvía 503. Este rechazo no demuestra corrupción de la base.

El ciclo copiaba `getMarketSignalCorpus()` al proceso HTTP, agregaba artículos
Awareness y enviaba otra vez todos los artículos al lector. Las ramas
geopolítica y financiera tienen límites independientes: con `analyzeLimit=3000`
pueden producir conjuntamente más de 3.000 artículos. El número de artículos
tampoco limita sus bytes. El histórico de impacto añadía otros datos a la petición.

Medición de sólo lectura del 14 de octubre, 19:25:56 Europe/Madrid:

| Medida | Resultado |
| --- | ---: |
| Artículos del corpus SQL | 4.307 |
| Bytes del corpus | 8.488.467 |
| Petición anterior reconstruida con contexto real | 8.906.752 bytes |
| Petición corregida con ese contexto | 73.646 bytes |
| Señales analizadas, incluido Awareness | 4.406 |
| Tickers con impacto y predicciones | 18 |
| Tiempo del cálculo y lecturas auxiliares de la medición | 7.326 ms |

La [evidencia JSON](market-worker-payload-evidence.json) conserva las revisiones,
la configuración efectiva y las medidas. La petición anterior es una
reconstrucción con datos de la muestra, no una captura del comando del log de
las 17:07 UTC. No se atribuye a aquel comando un tamaño exacto desconocido.

## Ajuste

El ciclo SQL envía cotizaciones, instrumentos, países y opciones del corpus.
El lector obtiene y selecciona las noticias en SQLite mediante `SqlNewsCorpus`,
con su transacción de lectura, filtros, ranking y caché existentes. Lee los
eventos financieros de Awareness en SQLite sólo en modo `visible`; `off` y
`shadow` conservan la exclusión pública. La conversión de eventos se comparte
con el servicio HTTP para evitar diferencias entre ambos cálculos.

El cálculo combina las señales dentro del lector y devuelve la proyección y
su cobertura, con revisiones de noticias y Awareness. `market.analysis` expone
la revisión SQL y el número de señales procesadas. La cantidad de artículos
ya no determina el tamaño de la petición entre procesos. Se conservan los
límites de selección existentes: esto no convierte el análisis en un escaneo
ilimitado de todo el histórico.

El histórico enviado contiene únicamente los últimos 24 puntos y los campos
que consume la serie de acoplamiento. Las cotizaciones se publican mientras
el análisis está pendiente; se mantiene la coalescencia y se descartan respuestas
si han cambiado la revisión del mercado o el contexto de noticias del proceso
HTTP. El lector usa la revisión de SQLite disponible al ejecutar, que puede
ser posterior al último refresco del dashboard; no se presenta como una
reconstrucción histórica congelada de ese refresco.

Se mantiene un único escritor. La adquisición ya confirma los artículos en
SQLite antes del análisis; los lotes existentes de ingestión y velas siguen
acotados. No se necesitan un segundo escritor, una importación ni una migración.

`STORAGE_MAX_COMMAND_BYTES` es configurable y podría aumentarse, pero una
petición y su serialización/copias crecerían con el corpus y competirían por
`STORAGE_QUEUE_MAX_BYTES`. Ambos son presupuestos de bytes serializados, no
mediciones exactas del heap. La solución conserva 8 MiB por comando y 32 MiB
por cola de la configuración local; no aumenta timeouts ni modifica `.env`.

## Panel administrativo

`/admin.html` incorpora **Operaciones de almacenamiento**, con tarjetas separadas
para escritor y análisis, estado, heartbeat, límites, ocupación de cola,
operaciones completadas/fallidas/rechazadas y último rechazo con tamaño y código.
Las tablas muestran trabajo enviado, en ejecución y en espera, además de los
últimos resultados con tiempos de cola, ejecución y CPU cuando está disponible.
Un deadline de resultado incierto se identifica como tal.

El panel consulta `/api/admin/runtime` cada cinco segundos con la pestaña visible
y cada minuto oculta; también permite actualizar manualmente. Las consultas
usan `getStatus()` y telemetría en memoria: no ejecutan comandos SQL ni llaman
a proveedores. Conserva la última muestra si falla una petición, impide
solapamientos y cancela las consultas al abandonar la página. Mantiene los
controles administrativos de la ruta existente.

Cada gestor retiene en memoria los últimos 50 resultados y muestra las primeras
50 peticiones en cola. Guarda exclusivamente IDs, etiquetas acotadas, tamaños,
estados, códigos y tiempos; no conserva argumentos ni cuerpos de proveedores.
El panel muestra los 30 resultados más recientes combinados. Los contadores
y este historial se reinician con el proceso. Las etapas persistidas del pipeline
y el observador SQL siguen siendo la referencia para la evolución de la base;
no se añade escritura de un log SQL por cada comando.

## Validación y activación

Las regresiones verifican un corpus mayor que el presupuesto de petición sin
recortarlo para transportarlo, igualdad de impactos/predicciones, los modos de
Awareness, cotizaciones publicadas durante el análisis, coalescencia y descarte
de contexto obsoleto. Verifican además límites del historial, rechazos por tamaño
y capacidad, timeout en cola, ausencia de argumentos privados y escape de HTML.
La prueba HTTP comprueba que obtener el panel no incrementa los comandos SQL.

Se ejecutaron 725 pruebas backend, 23 pruebas MCP y la comprobación de sintaxis
del backend y frontend; todas pasaron. La validación real abrió la base con `readonly` y `query_only`; calculó
los 18 tickers con la petición reducida. No arrancó otro escritor ni adquirió
datos de proveedores. La comprobación del panel es de renderizado y contrato
HTTP; no se realizó una revisión visual automatizada en navegador.

La instancia del operador permanece en ejecución con el código cargado el
13 de octubre. Para activar el ajuste, detenerla normalmente con Ctrl+C,
esperar `server_stopped` y arrancar una sola instancia:

```sh
npm --prefix /home/fedora/ogid/backend start
```

Abrir `/admin.html`, esperar un ciclo de mercado y verificar `market.analysis`
completado, ambos workers listos y ninguna nueva petición de mercado rechazada
por tamaño. Otros proveedores o etapas degradadas pueden mantener readiness
en 503; esa comprobación global no sustituye la revisión de la etapa concreta.
El observador de sólo lectura mantiene su comando habitual:

```sh
npm --prefix /home/fedora/ogid/backend run storage:inspect -- --watch
```
