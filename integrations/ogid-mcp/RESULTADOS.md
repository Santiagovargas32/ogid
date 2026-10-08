# Resultados de la implementación 0.2.0

Documento histórico. Para la entrega financiera 0.3.0 del 08/10/2026, sin push/PR/despliegue, consultar [PROGRESS](../../docs/research-cartera/PROGRESS.md).

Implementación realizada el 6 de octubre de 2026 en feat/ogid-mcp-research, inicialmente desde main 8609fa4a9f6cbb66d16e06bf6f87a85fae412917. La entrega se prepara mediante una PR hacia main. El adaptador 0.1.1 y sus correcciones de calidad se recuperaron selectivamente de la rama histórica; se conservó inicialmente la autenticación de esa base del backend.

Preparación de la PR sobre main b18c0c6, que ya fusionó la versión anterior del MCP y eliminó la autenticación administrativa. Esta entrega conserva la protección de la implementación activada: ADMIN_API_TOKEN, ALLOW_LOCAL_ADMIN y middleware sensible, además de las credenciales scoped del operador MCP. Por tanto, respecto a main restituye la autenticación administrativa; las actualizaciones de dependencias de main se conservan. CI instala ambos paquetes y comprueba backend, MCP e inventario.

## Cambio para el usuario

Antes, cuatro herramientas consultaban salud, lote editorial y Awareness. Ahora investigación tiene diez herramientas y 35 operaciones. El registro clasifica las 45 rutas JSON de la API; 19 operaciones adicionales requieren perfil operador/scopes. El inventario compartido genera API-MCP.md y capabilities. Los endpoints administrativos solo proyectan métricas; no existe proxy HTTP libre.

NVDA/NVIDIA puede buscar noticias corporativas sin país en todo el archivo recopilado, antes del límite editorial, y completar páginas de una revisión estable. El resolver ve las identidades verificadas actuales sin obligar a seleccionar watchlist o consultar proveedores. ASML, Alphabet y nombres generales de ETF exigen confirmar mercado/clase cuando corresponde; una única cotización conocida no prueba una elección del usuario.

Archivo persistente de metadata/extractos autorizados, retención de 30 días desde última observación y límites declarados; cuatro paquetes de cartera y estado persistente de candidatos/entregas. Una corrección de publicación antigua puede reaparecer como candidata, mientras otro sondeo/feed no convierte un artículo en novedad. Lectura no reconoce entregas. La conexión investigación no permite alerts:ack ni otras mutaciones.

Archivos principales: backend/contracts/ogidOperations.js, backend/services/research/*, researchController, researchRoutes, mcpOperatorAuth y researchProjection; hooks de recolección preeditorial, lecturas stored de RSS/mapas/medios, correcciones Awareness/RSS; adaptador src/operations.js/client.js/tools.js/config.js/server.js y pruebas. Configuración, inventario, migración, runbook y textos de tareas están en esta carpeta. No se han modificado frontend ni secretos del backend.

## Validación y activación

| Ámbito | Evidencia / alcance |
| --- | --- |
| Backend | Check sintáctico y suite completa sobre main b18c0c6: 543/543 pruebas correctas, HTTP externo bloqueado; la base inicial había validado 544/544 |
| MCP | Check, inventory:check y 21/21 pruebas correctas, cuatro herramientas compatibles y protocolo stdio real |
| Cobertura | Todas las rutas montadas clasificadas; todas las lecturas ejecutadas contra backend real de prueba con proveedores/refresh bloqueados: cero llamadas externas |
| Archivo / alertas | Más de una página, filtros previos, límites de bytes sin pérdidas, revisión estable, persistencia, cursor caducado, fechas, shadow, política de contenido, falsos positivos, clases ambiguas y correcciones deduplicadas |
| Operador | Fixtures HTTP de todas las operaciones, métodos/cuerpos/scopes, credenciales privadas, rechazo en investigación y rechazo real de credencial/scope en backend. No se consumieron proveedores reales desde operador |
| Host | Backend real reiniciado en su sesión existente; smoke stdio de diez herramientas y cuatro modos correcto; identidades runtime verificadas y archivo recuperado tras reinicio |
| Túnel | doctor correcto, perfil existente actualizado a research/runtime, cliente arrancado; healthz/readyz 200. Conservados túnel y referencia de clave |
| Comprobación de entrega | UI local disponible; llamada real a ogid_health con ok:true y versión 0.2.0. Contadores accepted/completed aumentaron de 1 a 2 y terminal_failures permaneció en 0 |
| Conector OGID | Cuatro herramientas compatibles ejecutadas correctamente por el conector real; ogid_health devuelve adapterVersion=0.2.0. Catálogo del cliente de esta sesión aún contiene cuatro herramientas anteriores |
| ChatGPT nuevo catálogo | Pendiente de Refresh y nueva conversación que descubra/ejecute las seis herramientas añadidas: criterio 12 |
| Tareas | No hay capacidad disponible para inspeccionar/editar sus definiciones. Cuatro textos y batería de evaluación entregados. Ejecución programada real pendiente: criterio 13 |
| Recuperación host | Procesos en screen; no se han instalado unidades ni habilitado linger. Reinicio/salida del host pendiente de comprobar: criterio 14 |

Los smoke no ejecutan force/refresh ni mutaciones. El backend operativo conserva sus ciclos normales de recolección; reiniciarlo los arranca según su configuración/budgets, independientemente de las consultas MCP. Un smoke local no demuestra disponibilidad de tareas del producto.

Preparación de Git: reglas de la integración centralizadas en el .gitignore raíz; eliminado el .gitignore interno. Comprobados con git check-ignore los .env, node_modules, diagnósticos, archivos *.local y copias activation.local, también en subdirectorios. Código, ejemplos y lockfile siguen visibles; no hay archivos ya versionados que coincidan con las reglas de exclusión. Revisión de patrones de credenciales sin hallazgos; la única ruta personal encontrada entre los candidatos es una aserción de prueba de redacción. git diff --check e inventory:check correctos. Secretos, configuración real y datos locales permanecen fuera del commit.

## Configurado y pendiente

Backend y túnel están activos con el código nuevo. El perfil real contiene OGID_PROFILE=research y OGID_INSTRUMENT_AUTH=runtime, con env -i; no carga backend/.env en el adaptador. Se han conservado credenciales/identidad de túnel y preparado rollback privado del código/configuración/datos. Los detalles de máquina y rutas exactas están en RUNBOOK-FEDORA.local, ignorado por Git.

Falta Refresh de la conexión OGID existente en ChatGPT, conversación nueva y una ejecución programada real conservando los horarios existentes. No se ha conectado un perfil operador ni creado secretos operador. Reconocer entregas requiere un ejecutor explícitamente autorizado después del envío real; sin él, candidatos pendientes pueden volver a aparecer. La deduplicación no afirma entrega.

La acumulación empieza al activar esta versión; no hay siete días retrospectivos. Adquisición continua no acreditada, fechas de publicación desconocidas conservadas, falta de precios/identidades/series declarada. Sin holdings fechados/pesos ETF, exposición indirecta no cuantificable. Scores y relaciones noticia/precio son heurísticos; la investigación externa sigue siendo necesaria.

Para futuras actualizaciones: reiniciar backend si cambia su código/configuración, reiniciar una sola instancia de tunnel-client para cargar el hijo MCP y usar Refresh si cambia el catálogo. Lanzar el túnel solo no recarga un backend que ya está ejecutándose. Editar .env no afecta un comando que no lo carga.

Rollback general en MIGRACION-0.2.md; procedimiento exacto y copias privadas para esta instalación en RUNBOOK-FEDORA.local. Preservar archivos research-* y configuración; no hacer reset/clean destructivo del checkout con cambios locales.
