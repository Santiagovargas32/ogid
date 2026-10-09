# Revisión de entrega: SQLite, workers y MCP

Revisado el 10 de octubre de 2026, Europe/Madrid. Dictamen: **candidata para revisión y pruebas controladas, todavía no aprobada como entrega final de producción**. El push a GitHub no reinicia ni despliega el proceso de Fedora. No se instala ni reinicia el túnel durante esta revisión.

## Evidencia y correcciones

La arquitectura conserva Yahoo directo para símbolos, cotizaciones y velas del panel. El archivado SQL de las velas es posterior y asíncrono, ordenado por símbolo/intervalo; los análisis técnicos se calculan y guardan en el worker. Las lecturas históricas API/MCP permanecen almacenadas. La cola tiene límites de elementos/bytes, separa espera de ejecución y permite un análisis CPU simultáneo. RSS primario y complementario tienen operaciones y plazos separados. Los cálculos de riesgo utilizan los candidatos diarios antes del recorte editorial.

Durante esta revisión se corrigieron tres defectos adicionales:

- El perfil MCP de investigación podía aceptar `source=yahoo` tras añadir ese parámetro al endpoint. Ahora sólo permite/fija `source=stored`; la descarga autorizada permanece en el perfil operador y el panel web.
- El filtro SQL `timeField=updatedAt` consultaba `archiveChangedAt`. Ahora consulta la actualización declarada por la fuente y se compara contra el comportamiento del archivo anterior.
- El contexto semanal devolvía 77 observaciones horarias, unos 427 KB de historial y 506 KB de datos, superando el presupuesto de salida MCP. El adaptador envía un resumen diario acotado y `historyCoverage`; la API conserva todas las observaciones de la ventana. La consulta SQL filtra el rango antes de deserializar el historial.

El adaptador pasa de cinco a treinta segundos de plazo por defecto, sin reintentar timeout. Los valores explícitos del perfil privado prevalecen. La salud MCP publica sólo estado, versiones de migración, heartbeat, contadores, cola y estados de pipelines; no publica ruta SQL, credenciales ni payloads internos.

Validación final local: **628 pruebas backend y 23 MCP aprobadas**, sintaxis correcta, inventario de 68 rutas/77 operaciones consistente y auditorías npm sin vulnerabilidades detectadas. El smoke por protocolo stdio con el backend activo completó las diez herramientas y los cuatro modos de contexto. La suite cruza medianoche con el reloj inyectado del archivo para que las lecturas diarias sean reproducibles. En el smoke posterior a medianoche el feed del nuevo día estaba vacío; la búsqueda histórica sí devolvió artículos y paginación. No se presentó ese vacío como un fallo ni se rellenó con noticias del día anterior.

La base activa se inspeccionó en modo de sólo lectura: SQLite 3.53.4, siete migraciones, `quick_check=ok`, claves foráneas sin incidencias, 35.543 artículos, 11.763 eventos, 24.682 velas, 2.360 observaciones de cotización y 175 análisis en la muestra. El worker figuraba `ready`, cero comandos fallidos y catálogo primario RSS de 66 fuentes, con 18 consultadas por rotación. Estos contadores son una fotografía, no una garantía de cobertura de todos los proveedores.

En `/srv/bitcoin/ogid/diagnostics` se verificó WAL, lectura concurrente, bloqueo de escritor y recuperación tras SIGKILL: commit conservado y transacción abierta descartada. La prueba no simula un corte eléctrico. Las suites verifican migraciones/checksums, idempotencia, rollback, límites, muerte del worker, archivado ordenado y backup/restauración.

## Límites que impiden la aprobación final

| Observación real | Trabajo y criterio de aceptación |
| --- | --- |
| En el servicio activo, Advanced tardó 65 s y Conditions 70 s bajo carga; algunas consultas del adaptador anterior agotaron 5 s | Medir de nuevo el código final con ingesta, backfill y consultas simultáneas; deduplicar/precalcular proyecciones o separar cálculo del worker SQL si persiste la espera. Las lecturas MCP habituales deben completar dentro de sus 30 s sin impedir ingesta/health |
| El adaptador remoto inició antes de estas correcciones | Cargar manualmente la versión final y repetir discovery, noticias/paginación, indicadores, condiciones, Advanced y los cuatro paquetes desde una conversación nueva |
| No se ha observado una prueba prolongada de la versión final ni recuperación tras reinicio del host | Mantener 24 horas de adquisición/lecturas con cero fallos del worker; comprobar recuperación del backend y del túnel |
| Backup disponible por comando; auditorías/análisis no tienen aún mantenimiento integral automático | Definir periodicidad y retención de copias y medir crecimiento de auditorías/análisis; probar restauración antes de comprometer un SLA |

No se exige cambiar SQLite por un servidor distribuido para esta entrega local. El cuello de botella observado es la competencia de CPU y consultas en un worker, no evidencia de una necesidad de PostgreSQL. El siguiente cambio de rendimiento debe medirse con las mismas ventanas y carga.

## Activación y compatibilidad con ChatGPT

El conector de esta sesión respondió a salud/discovery, resolución de NVDA/MSFT, búsqueda paginada y velas almacenadas. El ensayo local por stdio distingue protocolo/adapter de la superficie ChatGPT. No acredita publicación en el catálogo, acceso desde cualquier cuenta, ejecución programada ni una conversación nueva con el catálogo final.

ChatGPT admite un servidor privado mediante [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels); el túnel debe estar asociado al workspace y el usuario debe tener permisos de uso. La comprobación final sigue la [guía oficial de conexión/pruebas](https://developers.openai.com/plugins/deploy/connect-chatgpt) y [EVALUACION-CHATGPT.md](../integrations/ogid-mcp/EVALUACION-CHATGPT.md).

Después de aprobar y descargar la entrega, en el anfitrión y manualmente:

```sh
cd /home/fedora/ogid/backend
npm ci --omit=dev
systemctl --user reset-failed ogid.service
systemctl --user restart ogid.service
systemctl --user status ogid.service --no-pager
```

No repetir la importación inicial: la base ya está migrada. El túnel actual no está instalado como `ogid-mcp-tunnel.service`; no se da por ejecutable un reinicio de esa unidad. Detener/reanudar manualmente la instancia existente con su perfil privado, o seguir el [runbook Fedora](../integrations/ogid-mcp/RUNBOOK-FEDORA.md) para instalarlo sin duplicar procesos. Refrescar la conexión OGID en ChatGPT y abrir conversación nueva.

Logs: `tail -F /home/fedora/ogid/backend/data/logs/ogid.log`. Estado SQL: `npm run storage:inspect -- /srv/bitcoin/ogid/db/ogid.sqlite`. Backend y túnel conservan sus configuración y secretos locales; quedan fuera de la entrega Git.
