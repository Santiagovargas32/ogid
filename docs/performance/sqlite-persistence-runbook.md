# Activación y reversión del fix de persistencia

Esta entrega no despliega ni modifica producción. Aplicar desde una release
revisada; los comandos que detienen el servicio o cambian su base corresponden
al operador. No ejecutar un segundo escritor sobre la base activa.

## Preparación

1. Registrar el commit del proceso **en ejecución**, la ruta real de SQLite, el
   volumen, espacio libre y la configuración efectiva. El commit del checkout
   no identifica por sí solo al proceso. Conservar `.env`, credenciales y unidad
   de servicio fuera de Git. Mantener Node 24 y las versiones del lockfile.
2. Ejecutar `npm ci` en `backend` y `integrations/ogid-mcp`, y las comprobaciones
   de CI descritas en la auditoría. Mantener `STORAGE_ENABLED=1` y
   `STORAGE_BUSINESS_ENABLED=1` únicamente si ya corresponde al despliegue SQL.
   Este fix no migra automáticamente una instalación que todavía usa JSON.
3. Desde `backend`, crear un backup consistente, con un destino **nuevo**:

   ```sh
   npm run storage:backup -- /ruta/activa.sqlite /ruta/backups/pre-fix.sqlite
   npm run storage:status -- verify /ruta/backups/pre-fix.sqlite
   npm run storage:inspect -- /ruta/activa.sqlite
   ```

   El backup usa la API SQLite, incluye el estado confirmado del WAL y comprueba
   integridad y claves foráneas. No copiar solamente el fichero `.sqlite` de una
   base abierta. Probar además una restauración en una ruta aislada, con sus
   propios permisos y sin proveedores ni puertos de producción. Un backup online
   conserva el registro de propietario: para arrancar un escritor sobre la copia,
   esperar a que termine el proceso propietario original. La verificación de
   integridad de la copia es de solo lectura y puede hacerse antes.
4. Ensayar el arranque de la nueva release sobre una copia del backup. La
   migración 009 es aditiva, crea los trabajos/snapshots, las observaciones y los
   descriptores de entrada, además de índices; no cambia migraciones 001–008 ni
   elimina hechos. Medir duración de creación de índices, espacio máximo y
   tiempos con el histórico real. La prueba local de 14.400 artículos no fija
   un límite de tamaño de producción.

## Corte y comprobación

1. Detener la unidad que realmente ejecuta OGID (si es la instalación habitual,
   `systemctl --user stop ogid.service`). Esperar el cierre y confirmar ausencia
   del proceso escritor. Crear otro backup final después del cierre.
2. Instalar la release aprobada con sus dependencias y configuración conservada.
   Arrancar **una** instancia. El escritor aplica 009 antes de abrir el trabajador
   analítico. Este último abre SQLite con `readonly:true` desde el inicio.
   `STORAGE_WRITER_ACTIVE` significa que debe investigarse otro propietario;
   no borrar el registro de propiedad mientras su proceso siga vivo.
3. Comprobar `/api/health`, `/api/capabilities` (contrato `1.4.0`) y diagnósticos
   autenticados existentes. Confirmar estado de escritor listo, análisis de
   solo lectura, `synchronous=FULL`, colas dentro del presupuesto y ausencia
   de errores activos. Los contadores históricos no son un semáforo actual.
4. Consultar `/api/intel/advanced-snapshot?countries=RU&windowHours=24`.
   HTTP 200 con `lifecycle.status=preparing` es válido. Reconsultar con la misma
   selección siguiendo `retryAfterMs`; después debe aparecer `ready`. Con un
   resultado previo, `refreshing` conserva `generatedAt` y los datos previos.
   Verificar 20 clientes equivalentes y un solo trabajo/publicación. Reiniciar
   ordenadamente y comprobar que reaparece el resultado compatible persistido.
5. Confirmar ingestión y procedencias en los tres caminos RSS, catálogo intacto,
   fechas de adquisición por fuente, recuentos analíticos y selección visual.
   Revisar límites de contenido, Awareness `off/shadow/visible`, mercado,
   WebSocket y cambio de filtros en un navegador real del operador.
6. Probar `signals.delta` y `signals.change` mediante MCP. Si el cambio es una
   referencia, acumular los fragmentos base64 por `nextOffset`, verificar
   `totalBytes` y SHA-256 y reconstruir el JSON histórico. Sólo entonces el
   consumidor puede solicitar un checkpoint explícito. Leer no reconoce entrega.
7. Observar al menos 30 minutos con proveedores reales: p95 de lecturas de
   snapshots disponibles y estado <1 s como objetivo, no como SLA del cálculo.
   Registrar RSS, retraso del event loop, WAL, disco, colas, duración de commit,
   errores activos, trabajos interrumpidos y continuidad de adquisición.

## Recuperación y mantenimiento

- Los trabajos `running` se recuperan como `queued` al arrancar; al alcanzar
  tres intentos quedan `failed`. Un resultado cuyo commit tuvo éxito no se
  degrada si se perdió su respuesta. Un fallo explícito conserva el snapshot
  previo y su código; no se presenta como dato fresco. `force` comparte el
  trabajo activo y la identidad del intervalo de 30 s; no crea reintentos
  ilimitados del mismo trabajo ni implica adquisición de RSS en modo SQL.
- Si el proceso muere, una nueva instancia recupera la propiedad cuando el PID
  anterior ya no existe. La reutilización de un PID puede exigir comprobación
  manual: confirmar que no hay un escritor real antes de cualquier reparación.
  No se ofrece un comando que borre a ciegas el bloqueo.
- `storage:inspect` y `storage:status -- verify` son lecturas y pueden ejecutarse
  contra la base activa. Un escaneo completo consume I/O: usar una ventana de
  mantenimiento. `storage:status -- status|checkpoint` abre un escritor de
  mantenimiento y requiere detener primero el servidor. `checkpoint` usa
  `PASSIVE`; nunca forzar truncado del WAL con lectores o escritores activos.
- No se podan artículos, revisiones, procedencias, señales, outbox, análisis ni
  identidades de reintento para mejorar latencia. Vigilar crecimiento y reservar
  capacidad/backup. Los cursores de búsqueda caducan en memoria; las cachés
  también. Caducar estos estados no elimina hechos. No ejecutar `VACUUM` como
  parte de una petición HTTP; programar mantenimiento explícito y con backup.
- Ante `SQLITE_FULL` o `SQLITE_BUSY`, resolver espacio/propietario y reconciliar
  la identidad de la operación antes de reintentar. No incrementar todos los
  presupuestos ni borrar históricos. Un rechazo de representación MCP se
  diagnostica por separado de un fallo de commit.

## Rollback

El código anterior rechaza la migración 009 con `STORAGE_SCHEMA_AHEAD`.
Volver al commit anterior **no revierte la base**.

1. Detener la nueva instancia y conservar un backup verificado de su base y
   configuración. Registrar hasta qué instante llegó la ingestión.
2. Si se revierte el código, restaurar el backup **anterior a 009** en una ruta
   nueva; verificar integridad, claves foráneas y recuentos. Conservar la base
   nueva para reconciliar lo adquirido después del corte. No sobrescribirla.
3. Configurar la release anterior para esa base restaurada y arrancar una sola
   instancia. La restauración retrocede el estado al instante del backup:
   decidir y documentar la reconciliación/reingestión de los hechos posteriores
   antes de dar por completo el rollback. No existe migración descendente
   automática ni se presume que una fuente RSS siga ofreciendo los artículos.
4. Comprobar salud, cobertura y checkpoints. Mantener ambas copias hasta cerrar
   la reconciliación. Preferir un fix hacia delante si evitaría perder estado
   posterior al backup.
