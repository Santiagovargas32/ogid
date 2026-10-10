# Mediciones locales (10-10-2026)

Node v24.10.0, mismo host, mismo script, upstreams falsos de 80 ms, 18 feeds configurados en 6 hosts, catálogo extendido automático 453, límite corpus 900, dos noticias seleccionadas por la diversidad del fixture. `NODE_ENV=test` desactiva persistencia del servidor durante comparación HTTP/WS para evitar reutilizar archivos previos; persistencia se mide separadamente. No se usaron claves de proveedores ni publishers reales.

Base `5f141823c10eafdebb5529f119e5c86766fda5f0` en worktree detached; rama main-arquitectura JSON con canonical. 10 rondas por ruta: 10 observaciones con 1 cliente / 100 con 10. Comparación corrida secuencialmente sin stress paralelo. `samples` incluye lecturas durante ingestión/cold-start (el cuerpo puede estar vacío en main hasta publicar); `warmStored` compara lecturas con datos existentes después de terminar el ciclo. Los tamaños son cuerpo JSON/HTML, sin headers/compresión; WS es tamaño de un payload update serializado, sin framing TCP. No se mide ancho de banda WAN.

| Lectura almacenada con datos | Base p50 / p95 ms | Rama p50 / p95 ms | Bytes base / rama |
|---|---:|---:|---:|
| 1:/api/health | 2.1 / 3.1 | 1.4 / 3.1 | 2048 / 2045 |
| 1:/api/intel/snapshot?countries=ALL&limit=100 | 2.4 / 4.3 | 1.4 / 2.9 | 63084 / 25412 |
| 1:/api/news/aggregate?stored=1&limit=40 | 1.5 / 5.7 | 1.2 / 1.2 | 30007 / 36365 |
| 1:/api/admin/news-raw?dataset=rss-aggregate&stored=1 | 1.9 / 3.5 | 2.0 / 3.3 | 9813 / 11085 |
| 10:/api/health | 11.5 / 15.3 | 7.6 / 9.1 | 2048 / 2045 |
| 10:/api/intel/snapshot?countries=ALL&limit=100 | 18.7 / 22.9 | 8.9 / 11.2 | 63084 / 25412 |
| 10:/api/news/aggregate?stored=1&limit=40 | 5.5 / 8.4 | 5.9 / 10.6 | 30007 / 36365 |
| 10:/api/admin/news-raw?dataset=rss-aggregate&stored=1 | 8.5 / 13.6 | 7.5 / 11.1 | 9813 / 11085 |

| Métrica de ciclo + lecturas del fixture | Base | Rama |
|---|---:|---:|
| Primera selección publicada | 2977 ms | 451 ms |
| Peticiones upstream | 36 | 18 |
| Duración total script (incluye rondas HTTP calientes) | 3567 ms | 1313 ms |
| CPU acumulada user + system | 1.827 s | 1.778 s |
| Memoria RSS al final | 220.0 MiB | 205.2 MiB |
| Heap utilizado al final (sin forzar GC en HTTP) | 49.8 MiB | 62.6 MiB |
| Event-loop lag p95 | 14.6 ms | 15.1 ms |
| Update WS serializado | 77741 bytes | 25011 bytes |

El lote RSS canónico tarda 433 ms en este fixture; su selección posterior tarda 22 ms. Main mezclaba recolección/selección/agregado/mapa dentro del ciclo de ~2978 ms. CPU y esperas se miden separadamente: reducir espera secuencial no implica reducir proporcionalmente CPU; el heap y algunos payloads raw crecen por metadatos de procedencia/aliases. Global deadline se verifica con fixture de cola/cuerpo, no con un publisher lento real. Los GET de health/stored quedan muy por debajo de 500 ms en este ensayo; no son una garantía para Internet ni para el archivo máximo.

Browser con 60 artículos ya existentes: feed útil 299 ms, Admin útil 230 ms. Antes, una petición RSS que nunca responde deja cero diagnósticos Admin a los 800 ms y no termina el ciclo; después los paneles independientes se muestran. La medida de primera selección arriba corresponde a arranque frío del backend; el browser antes/después con fixtures verifica layout/estado y no mide publicación WAN. CDN se sirvió desde copia local íntegra y recursos externos de vídeo/imagen se bloquearon, por lo que no demuestra latencia de CDN.

## JSON representativo

10.000 artículos permitidos, 10595917 bytes tanto antes como después, disco temporal mismo host:

| Operación | Base | Rama |
|---|---:|---:|
| Ingestión síncrona | 774.1 ms | 654.7 ms |
| Registrar contexto | 91.1 ms | 0.17 ms |
| Flush explícito pendiente | ~0 (ya había escrito) | 116.4 ms |
| Total ingest + contexto + guardado | 865.2 ms | 771.3 ms |
| Escrituras del lote | 2 (ingest/contexto síncronos) | 1 coalescida |
| Serialización/poda de flush | Incluida en operaciones síncronas | 86.0 ms síncronos |
| Write/rename de flush | Incluida en operaciones síncronas | 25.5 ms asíncronos |

**Desviación importante:** ingestión de 10k supera 500 ms; no se afirma cumplir health p95 bajo una admisión masiva de ese tamaño. El lote de adquisición está acotado a 18×200 y el corpus a 900, pero el archivo histórico puede llegar a 100k y su poda/serialización todavía consumen CPU síncrona. Se eliminan serialización/escritura redundantes y bloqueos de disco; no se inventa una mejora de CPU completa ni se introduce otra arquitectura de persistencia. El flush tiene orden/revisión dirty y shutdown espera ciclos admitidos. Errores explícitos rechazan y son recuperables; archivo corrupto se conserva.

## Estabilidad y memoria

180 ciclos / 184.0 s, 300 feeds (240 de un host), clock de elegibilidad simulado, upstream falso, persistencia JSON y GC explícito en muestras. Cobertura 300/300; colas/en vuelo/slots activos = 0 y handles = 1 en todas las muestras. Lag p95 10.7 ms; heap tras calentamiento ~9–10 MiB, sin crecimiento sostenido del corpus ni de colas.

**El RSS del proceso sí crece de 74.4 a 146.7 MiB** durante este ensayo y el heap reservado también crece aunque el heap utilizado se mantenga estable (última muestra 8.4 MiB). Eso es compatible con reservas/fragmentación del runtime, pero no prueba su causa. No se declara satisfecha la condición de RSS de proceso plano ni una prueba de horas; se deja como riesgo medido y seguimiento del operador. La prueba es acelerada por reloj simulado y no representa 180 ciclos reales de 15/60 min. Usar `OGID_SOAK_ROUNDS` para ampliar en un entorno de pruebas y observar RSS/heap/colas, sin publishers reales.

Comandos/scripts de reproducción y límites LAN/proxy en [README](README.md). Resultados JSON guardan p50/p95 y bytes exactos, muestras y parámetros no secretos.
