# Migración 0.1.1 → 0.2.0

Requiere actualizar el backend y el adaptador del mismo checkout completo. Conserva las cuatro herramientas y respuestas de 0.1.1, y añade seis herramientas de investigación. No hay dependencias nuevas ni migración destructiva de datos. El backend actual conserva su autenticación sensible: la rama histórica del MCP no debe sustituirlo íntegramente.

El valor implícito de OGID_INSTRUMENT_AUTH sigue siendo allowlist para conservar la restricción anterior. La plantilla nueva indica runtime explícitamente: cada referencia debe resolverse de manera única en el registro verificado del backend. La watchlist puede estar vacía. Ninguna referencia solicitada obliga a descargar precios o crear identidades.

Archivos nuevos por defecto: backend/data/intel/research-news.json y research-alerts.json. Se crean al recopilar metadata/observar candidatos. El archivo empieza al activar esta versión; ausencia de semana previa es cobertura parcial. No importar texto completo ni diagnosticar datos privados desde estas herramientas. Hacer respaldo privado de backend/data y de los perfiles antes de activar; no incluirlos en Git.

Tras comprobar tests/check/inventory, reiniciar el backend usando su forma real de arranque; después reiniciar el cliente del túnel que lanza el MCP. .env del adaptador solo tiene efecto si su comando lo carga. Actualizar en el perfil el modo runtime y usar Refresh de la conexión existente en ChatGPT. Probar diez herramientas y versión 0.2.0 en una conversación nueva. La ejecución programada requiere una prueba independiente.

## Rollback conservando datos

Detener únicamente los procesos OGID/túnel identificados. Restaurar perfil respaldado. Recuperar el checkout anterior en un directorio separado mediante su SHA verificado, instalar con sus lockfiles y dirigir allí el comando stdio. Reiniciar su backend con la configuración anterior. Mantener intactos backend/data, los archivos research-* y las credenciales privadas; la versión antigua simplemente no consulta este archivo nuevo.

No usar git reset --hard ni git clean sobre un checkout con trabajo local. La activación sin commit nuevo usa una rama con cambios locales: guardar antes una copia privada/patch completo que incluya archivos nuevos, o crear commits revisados. El HEAD de capabilities/health identifica el checkout, no certifica ese conjunto de cambios ni la versión cargada del backend.

La base inicial main 8609fa4 conservaba la autenticación y no incluía el adaptador MCP. La PR se prepara sobre main b18c0c6, que ya incorpora 0.1.1 y había eliminado esa protección; esta entrega restituye la autenticación sensible que conservaba la implementación activada. Ver RESULTADOS.md para el alcance de integración. Si se vuelve al adaptador 0.1.1 de la rama histórica, extraer exclusivamente integrations/ogid-mcp; no copiar sus cambios de autenticación al backend. Mantener una sola instancia de túnel para su identidad.
