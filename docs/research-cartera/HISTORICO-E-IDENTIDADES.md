# Histórico diario y seguimiento de identidad

Contrato 1.2.0, adaptador MCP 0.4.0. Implementación local; no acredita histórico financiero descargado, activación en servidor ni holdings operativos.

## Cargar el histórico desde administración

En `/admin`, sección **Histórico diario**, elegir instrumento, fechas y objetivo (500 por defecto). Las muestras intradía no cuentan para una SMA200 diaria. El parámetro `limit` de una consulta solo limita lo leído: no descarga datos.

Dos recorridos disponibles:

1. **Preparar descarga Yahoo** crea un job y muestra su presupuesto. **Ejecutar hasta 4 peticiones** procesa ventanas diarias de hasta 181 días. El estado, cursor y número de intentos quedan persistidos. No hay descargas automáticas ilimitadas. Los reintentos de chart internos se desactivan para este recorrido; los reintentos posteriores del job respetan el cooldown y Retry-After, con tres intentos por ventana. El presupuesto cuenta operaciones chart; la biblioteca puede realizar intercambios auxiliares de sesión/autenticación con Yahoo.
2. **Validar CSV**, revisar el resultado y **Guardar validado**. Declarar nombre de fuente, URL HTTPS de procedencia, símbolo y ajuste de los OHLC. Se toma la moneda del instrumento verificado. El servidor no visita esa URL ni recibe rutas de archivos. No requiere API key ni añade un proveedor contratado.

Formato CSV admitido (cabecera sin distinguir mayúsculas, coma decimal no admitida):

```csv
Date,Open,High,Low,Close,Volume
```

Cada fila contiene una fecha `AAAA-MM-DD`, OHLC numéricos positivos y volumen numérico no negativo o vacío; Volume es opcional. Máximo 500 kB y 5000 filas, rango de hasta cinco años. Solo se incluyen filas dentro de las fechas elegidas. Fechas inexistentes, sesiones sin cierre, velas abiertas, OHLC incoherentes, monedas incompatibles y duplicados contradictorios rechazan la importación antes de escribir velas. Duplicados idénticos se cuentan y reducen. BOM, CRLF y campos entrecomillados están admitidos. No se acepta Adj Close como sustituto de OHLC ajustados. Si la fuente no documenta su ajuste, no declararlo como `none` o `splits` por suposición.

La vista previa no escribe ni consulta proveedores. `validBars` describe las filas válidas de esa carga; `sma200Warmup` acredita cantidad, no continuidad ni corrección del ajuste. Tras guardar, **Consultar técnica diaria** lee hasta 500 velas del dataset y conserva N/D cuando hay huecos, datos incompatibles o muestra insuficiente. La técnica devuelve también antigüedad, calendario parcial y `provenanceVerification=operator-declared; not independently verified`.

CSV se almacena con el mismo esquema canónico JSONL en `MARKET_HISTORY_DIR/imports/<datasetId>/candles/...`, separado de Yahoo por fuente/URL/símbolo/moneda/ajuste/instrumento. El ledger conserva metadata, fingerprint, job y resultado; no conserva el CSV original. Conservar el archivo original si se necesita una auditoría completa. Las correcciones de velas guardan hasta 20 revisiones con el mecanismo existente. `requestId` repetido con los mismos argumentos no vuelve a importar; reutilizarlo con otro contenido falla con `IDEMPOTENCY_CONFLICT`.

Yahoo continúa su recogida incremental en su serie habitual. **El histórico de otra fuente no se concatena automáticamente con Yahoo ni alimenta las alertas o la evaluación existentes.** Esa promoción requiere verificar ajustes y solapamientos, y mantener una política de correcciones por splits. Mientras tanto se puede analizar el CSV expresamente o completar la serie Yahoo mediante el job por rango. No se ha añadido un descargador automático de Stooq u otro proveedor sin clave: faltan validación de su contrato de descarga, cobertura y ajuste; CSV es la alternativa disponible en esta entrega.

## API y MCP

Las diez herramientas de investigación siguen siendo las mismas. `ogid_query` admite ahora `market.history.datasets`; `market.technical-context` acepta `datasetId` opcional y `adjusted=splits|none`. El dataset debe coincidir con instrumento y ajuste. Solo admite intervalos diario y semanal derivado, sin benchmark externo. La consulta normal sin dataset conserva la serie habitual.

Jobs `market.history.create` aceptan `startAt` opcional además de `endAt`, ambos ISO con zona. El objetivo se comprueba sobre el rango del job; finalizar ventanas no garantiza alcanzar 500 sesiones. Un rango demasiado corto puede terminar correctamente con `goalMet=false`.

Las rutas `/api/admin/history`, `/api/admin/history/jobs`, `/api/admin/history/run`, `/api/admin/history/import` y `/api/admin/events/replay` usan la autenticación admin existente. La interfaz no recibe la credencial MCP operador. Vía `ogid_operator`, lectura admin requiere `admin:read`, histórico/importación `candles:backfill` y relectura de eventos `sources:ingest`. Se conservan los controles de perfil, ruta, cuerpo y scope en servidor.

## Corregir la agrupación de publicaciones

La identidad anterior reutilizaba un evento al encontrar una URL coincidente. Una URL de agenda del BLS o BEA podía así reunir publicaciones distintas. Ahora:

- Un wire explícito conserva su identidad declarada; un factKey se acota a su fuente.
- Un sourceEventId/eventId/id se acota a fuente y clase de evento. Las correcciones del mismo ID conservan sus revisiones.
- Sin ID se usa título y fecha de publicación/agenda. Si tampoco hay fecha, la identidad se declara insuficiente y no produce impactos.
- Una URL compartida no demuestra identidad. BEA incluye título, URL y fecha programada en el ID de cada fila para separar publicaciones recurrentes.

Los registros anteriores se conservan como `legacy_identity_requires_replay`, con `identityVerified=false`, y quedan excluidos de impactos. En el siguiente refresh de escenarios se desactivan las señales `event-review-candidate` ligadas a identidades antiguas mediante una transición auditada; el journal histórico se conserva. Escenarios y señales históricas ya distribuidos no se reescriben retrospectivamente. Sus consumidores deben procesar las revisiones/inactivaciones posteriores.

En Awareness, una fila BEA antigua y otra con el nuevo ID solo se colapsan en la vista si coinciden fuente, admisión, título, tipo, URL y fecha programada. Se prefiere el ID nuevo; los registros originales permanecen almacenados. Dos fechas o publicaciones distintas siguen separadas. Esta compatibilidad evita duplicados de agenda al actualizar el parser.

Tras una lectura con los parsers nuevos de Awareness, pulsar **Revisar relectura de agenda almacenada**. El panel muestra hasta 500 correspondencias entre ID de fuente y nuevo ID; no descarga nada. **Releer agenda revisada** exige el mismo snapshot: si la agenda cambió, se rechaza y se pide otra vista previa. La repetición sin cambios no duplica evidencias. Solo se reconstruye el snapshot público admitido de Awareness; publicaciones antiguas que ya no estén allí requieren releer los archivos originales. No se intenta separar un evento contaminado inventando atribuciones desde su URL.

Antes de activar: respaldar ledger de investigación, alertas, Awareness y directorio de mercado. No hay conversión destructiva al arrancar; las escrituras posteriores son explícitas o parte de los ciclos ya existentes. Para rollback conservar backend y adaptador de la misma revisión y restaurar copias coherentes. Los datasets CSV son adicionales y el formato `research-ledger-v1` permanece compatible; código anterior no aplica la exclusión nueva de eventos legacy, por lo que restaurarlo sin las copias correspondientes reintroduce el fallo.

## Fuentes, entidades, ETF y evaluación

`research.sources` mantiene `sources` para los adaptadores específicos configurados y añade `catalog` con Awareness y su estado observado. Estar en el catálogo o admitido no certifica una lectura correcta. Las fuentes Awareness se ejecutan mediante su propio ciclo, no por `research.sources.run`.

Para completar los datos pendientes:

| Punto | Trabajo siguiente | Criterio de aceptación |
| --- | --- | --- |
| companyId / CIK | Registrar entidades y relaciones instrumento→entidad mediante RESEARCH_SOURCES_FILE. Verificar ticker y CIK con SEC/IR; dos clases pueden pertenecer a una misma entidad | Entidad con evidencia URL/fecha, CIK único y filings/companyfacts reales fechados |
| MIC / calendarId / ISIN | Verificar mercado, clase y divisa con bolsa/emisor; no deducir ISIN desde un ticker. El calendario efectivo puede derivarse del exchange sin que eso complete la identidad MIC almacenada | Identidad verificable por mercado, sin sustituir otra cotización o clase |
| VWCE | Confirmar la cotización concreta y clase acumulativa; obtener composición del emisor y adaptar su formato al ingest de holdings fechado existente | ISIN consistente, asOf del documento, pesos y cobertura; sin atribuir la fecha de descarga a los holdings |
| Piloto predictivo | Registrar previsiones realmente emitidas con modelo fijo, horizonte y evidencia disponible antes del resultado; esperar vencimientos | Muestras observadas, particiones cronológicas, costes y comparadores; precisión/calibración N/D con muestra insuficiente |

SEC ofrece submissions y companyfacts sin autenticación ni API keys; su adaptador ya existe y exige identificación/contacto en User-Agent. Esto no completa por sí solo las entidades ni activa fuentes: [documentación oficial SEC](https://www.sec.gov/search-filings/edgar-application-programming-interfaces). Para VWCE, usar los documentos y datos de cartera de la clase correspondiente del [emisor Vanguard](https://www.vanguard.co.uk/professional/product/etf/equity/9679/ftse-all-world-ucits-etf-usd-accumulating); la página UK presenta una cotización distinta, así que debe verificarse también la plaza elegida. No se han descargado ni importado holdings en esta entrega.

La evaluación existente necesita precios utilizables disponibles al emitir cada pronóstico. Cargar hoy un CSV antiguo no acredita que esos datos estuvieran disponibles al pronosticar ayer, ni permite fabricar muestras retrospectivas. El dataset CSV no se promueve a evaluación de forma implícita.
