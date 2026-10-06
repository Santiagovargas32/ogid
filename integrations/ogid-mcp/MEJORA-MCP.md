# Mejora: acceso privado de ChatGPT a OGID y calidad de fechas

OGID expone un adaptador independiente MCP de solo lectura, versión **0.1.1**, con cuatro herramientas por stdio. El túnel privado conecta ChatGPT al proceso local sin publicar el backend ni compartir claves de proveedores con el adaptador.

## Problemas resueltos

| Caso observado | Comportamiento corregido |
| --- | --- |
| Calendario con eventos de 2026 y `latestEventAt` en 1999 | Se evita `Date.parse(0)` y se usa publicación o programación real; `latestEventTimeKind` aclara cuál. La proyección también corrige metadatos guardados por versiones anteriores, sin una migración destructiva. |
| RSS del Consejo de la UE con fecha de recepción presentada como publicación | Parser compatible con prefijos XML/Atom. Conserva el campo que originó la fecha; una actualización se expone como `updatedAt` en MCP. |
| RSS con fecha inválida o ausente | El contrato interno conserva el respaldo y su indicador. MCP devuelve `publishedAt:null` y una advertencia; `receivedAt` no se interpreta como publicación. No se inventa una fecha a partir de la URL. |
| Comunicado de la Fed duplicado con clasificaciones diferentes | Proyección única para comunicados oficiales con igual URL, título y publicación. Conserva registros originales y `relatedSources`; no mezcla admisiones shadow/active. Las rutas oficiales `orders`, `bcreg` y `enforcement` se clasifican como `regulatory_filing`. |
| Mercado global marcado como respaldo sin cotizaciones | Salud incorpora disponibilidad, número de cotizaciones y número de instrumentos seleccionados. El MCP conserva las etiquetas de calidad y distingue mercado vacío. |
| Documentación con rutas personales y estado de pruebas obsoleto | Guías reutilizables, perfil con marcadores y unidad de usuario con `%h`. Claves, `.env`, perfil real y diagnóstico de máquina quedan fuera de los archivos publicables. |

La deduplicación es de la vista, no una eliminación de registros. Solo combina coincidencias exactas de URL, título y publicación de comunicados oficiales; agendas con una URL común, fechas diferentes y eventos no oficiales siguen separados. Los filtros y contadores de la vista se aplican al resultado deduplicado.

`latestEventAt` de un calendario puede apuntar al último evento futuro de la fuente. No mide la frescura de ingesta; para ello se usa `lastSuccessAt`. `lagMs` queda desconocido si solo hay fechas programadas.

## Validación realizada

El 5 de octubre de 2026:

- Análisis sintáctico correcto del backend y adaptador.
- Suite completa del backend: **532 pruebas correctas**; HTTP externo deshabilitado en las pruebas.
- Adaptador: **17 pruebas correctas**, incluyendo conexión MCP real por stdio, esquemas estrictos, privacidad, errores, reintentos, timeout y límites de bytes.
- Smoke local de versión **0.1.1**: inicialización, catálogo y cuatro herramientas correctos contra el backend existente. No reinicia el backend ni actualiza proveedores.
- Copia en memoria de la respuesta pública real: cuatro metadatos de calendario corregidos y el comunicado Fed observado reducido de dos entradas a una, con clasificación regulatoria. No se escribió el snapshot operativo.
- Feed oficial del Consejo de la UE: 20 entradas, todas con fecha de fuente reconocida por el parser nuevo.
- Sintaxis de la unidad systemd de usuario verificada sin instalarla.

Las pruebas aisladas acreditan el código nuevo. Las consultas por el plugin acreditan la conexión ya existente; el proceso activo mantiene la versión que cargó hasta reiniciarse.

## Activación y pendientes

1. Revisar e incorporar la rama de mejora. Instalar dependencias del adaptador con `npm ci --ignore-scripts` desde su carpeta y repetir `check`, `test` y `smoke` según [README.md](README.md).
2. Reiniciar de forma controlada OGID y el cliente del túnel para cargar los cambios. No solapar clientes del mismo ID. Comprobar versión **0.1.1** y las cuatro herramientas desde ChatGPT, con el prompt de [CONFIGURAR-TUNEL.md](CONFIGURAR-TUNEL.md).
3. Para mercado, seleccionar instrumentos verificados en OGID y comprobar cobertura, antigüedad y origen de cada cotización. En la inspección de esta instancia la watchlist y la cobertura estaban vacías, sin errores de proveedor registrados; eso no acredita que Yahoo proporcione precios al seleccionarlos. No convertir respaldo en datos reales cambiando una etiqueta.
4. Configurar la persistencia del backend y del túnel como parte del despliegue. Probar recuperación tras reinicio y disponibilidad sin sesión antes de depender de consultas continuas.
5. Probar por separado una tarea programada en el producto y contexto que la ejecutará. Cuatro llamadas correctas en una conversación no acreditan ese acceso.
6. Mantener `runningCommitVerified=false`: el commit del checkout no prueba qué código cargó OGID. Para acreditar una versión desplegada hace falta una identidad de build y un procedimiento de despliegue verificable; no basta con consultar Git desde el adaptador.

La clave runtime, el ID real, los procesos y el `.env` operativo no se modifican al preparar esta mejora. El cambio preexistente del lockfile del backend queda separado de ella.
