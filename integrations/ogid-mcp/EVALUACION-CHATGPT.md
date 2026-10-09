# Evaluación en ChatGPT

Antes: backend nuevo activo, una instancia del túnel, Refresh de la conexión OGID existente, nueva conversación con OGID seleccionado. Catálogo esperado: diez herramientas investigación, versión del adaptador 0.4.0 y contrato 1.2.0, 45 operaciones de lectura. No hay herramienta operador. Un resultado local/stdio o readyz no acredita esta prueba.

Para transporte, pedir únicamente OGID y conservar errores; para utilidad, combinar OGID con fuentes oficiales/independientes. Fechar ventanas en ISO con zona y conservar el período exacto consultado.

| Prompt | Herramientas / aceptación |
| --- | --- |
| Usa OGID para comprobar salud, versión y cobertura. Si el túnel falla, muestra el error. | ogid_health, ogid_get_capabilities; error explícito, versión del adaptador separada del commit/process |
| Consulta noticias almacenadas de Taiwán de las últimas 48 horas; recorre todas las páginas e indica límites. | ogid_search_news, countries=[TW], from/to; nextCursor hasta hasMore=false, sin duplicar IDs, cobertura/fechas/fuentes |
| Busca NVDA y NVIDIA, incluidas noticias corporativas sin país; explica coincidencias e indirectas. | ogid_resolve_instruments y ogid_search_news sin countries; matchReasons de entidad, no afirmar exposición inferida |
| Resuelve ASML y un ETF por identidad de mercado, sin elegir una clase no confirmada. | ogid_resolve_instruments; alternativas o unavailable, ISIN/bolsa/divisa cuando existan, sin consulta provider ni SPY/QQQ |
| Prepara contexto OGID para la agenda de hoy de nuestro universo y confirma eventos oficiales. | ogid_get_portfolio_context agenda, Awareness/fuentes, confirmación externa; off/shadow no implica agenda vacía |
| Resume la semana disponible con noticias, riesgos e impactos; advierte si no cubre siete días. | contexto weekly, búsqueda paginada, history real; activación reciente y falta de historia señaladas |
| Comprueba materiales nuevos y correcciones sin duplicar el mismo hecho. | contexto material; candidateId/evidenceIds/correction, confirmación externa, deliveryAcknowledged=false; no simular envío/ack |
| Consulta riesgos, hotspots, mapas y fuentes de medios; conserva método, fecha y calidad. | ogid_get_capabilities, ogid_query intel.risks/intel.hotspots/map.layers/media.streams; solo stored, límites explícitos |
| Intenta modificar watchlist desde investigación. | ogid_operator no anunciado; ogid_query rechaza operación/cuerpo no permitidos; watchlist sigue igual |

Para tareas, inspeccionar primero las cuatro definiciones existentes y permisos del ejecutor. Aplicar TAREAS-CARTERA.md sin cambiar horarios por suposición. Registrar al menos una ejecución programada real; una llamada manual no demuestra acceso en ese contexto. El entorno de esta implementación no expone una herramienta para inspeccionar/editar esas tareas.

## Registro de evidencias

Guardar privadamente una fila por prueba; sin credenciales ni diagnósticos autenticados:

| Hora UTC / producto | Tarea o prompt | Herramientas / versión | Ventana ISO | Cobertura y fuentes | Resultado / error | Ejecución real |
| --- | --- | --- | --- | --- | --- | --- |
| Completar tras prueba | Identificador de la tarea existente | Nombres llamados | from/to | Período disponible y límites | Éxito verificable o código | Conversación o programada |

Criterios 12 y 13 del documento original: pendientes hasta contar con nueva conversación que descubra/ejecute herramientas nuevas y ejecución programada real, respectivamente. Criterio 14: pendiente hasta comprobar recuperación del backend y túnel tras reinicio/salida del host. La existencia del código no satisface esos criterios.

## Revisión del 10 de octubre de 2026

El conector OGID expuesto en esta sesión ejecutó salud, discovery, resolución NVDA/MSFT, velas almacenadas de NVDA y búsqueda de noticias Nvidia con paginación. Esto acredita llamadas reales del conector desde esta sesión; no demuestra una conversación nueva en ChatGPT web ni una ejecución programada. Se observaron TIMEOUT en noticias con el adaptador anterior de cinco segundos. La prueba del adaptador nuevo por stdio usa 30 segundos y revisa las diez herramientas y los cuatro modos de contexto; el resumen semanal añade cobertura del muestreo diario para respetar el límite de salida. La evidencia final está en [production-readiness.md](../../docs/production-readiness.md).

Para aplicar la revisión, cargar manualmente el código del backend y del adaptador, comprobar que el perfil privado no conserva `OGID_TIMEOUT_MS=5000`, refrescar la conexión y abrir una conversación nueva. No arrancar un segundo `tunnel-client` sobre el mismo perfil. `ogid_health` debe incluir `storage.state`, `storage.worker.counts` y `storage.worker.heartbeatAt`; pedir velas por investigación nunca descarga Yahoo.

La documentación oficial de [OpenAI sobre conexión y pruebas](https://developers.openai.com/plugins/deploy/connect-chatgpt) admite HTTPS público o Secure MCP Tunnel. Para este servidor privado se mantiene el túnel; su asociación con el workspace y los permisos son requisitos independientes. No se ha publicado OGID en el catálogo público de ChatGPT.
