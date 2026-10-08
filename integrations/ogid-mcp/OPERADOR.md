# Perfil operador

Contrato 1.2.0 / adaptador 0.4.0: [operaciones y runbook financiero](../../docs/research-cartera/RUNBOOK.md) y [histórico/CSV/relectura de eventos](../../docs/research-cartera/HISTORICO-E-IDENTIDADES.md).

Investigación usa diez herramientas sin credenciales operador. Una conexión separada con OGID_PROFILE=operator añade ogid_operator; únicamente anuncia las operaciones que permiten sus scopes. No cambiar el perfil de las tareas de cartera para resolver errores de datos.

| Scope | Operaciones autorizadas |
| --- | --- |
| admin:read | API limits, pipeline, news raw y AI, proyectados a métricas |
| provider:query | Búsqueda de identidades y variantes de consulta externa enumeradas |
| intel:refresh | Refresh intel |
| watchlist:write | Sustituir selección de instrumentos verificados |
| candles:backfill | Backfill legacy y jobs históricos acotados create/run |
| sources:ingest | Ingesta acotada de fuentes locales verificadas |
| signals:generate | Refrescar escenarios locales o borrar con tombstone |
| signals:ack | Checkpoint CAS de procesamiento y recuperación explícita; sin recibo de entrega |
| forecasts:write | Registrar pronósticos antes del resultado con disponibilidad/costes |
| media:refresh | Actualizar/resolver streams |
| alerts:ack | Reconocer candidatos después de su entrega real |

Credenciales de ejemplo: los tokens son marcadores, no secretos operativos. Generar un valor aleatorio de al menos 32 caracteres y compartirlo únicamente entre ambos archivos privados, fuera del repositorio. El backend valida el scope aunque el adaptador anuncie otro. Reiniciar ambos para cargar cambios de permisos.

Backend, MCP_OPERATOR_CREDENTIALS_FILE:

```json
{"credentials":[{"token":"REEMPLAZAR_CON_UN_SECRETO_ALEATORIO_DE_32_O_MAS_CARACTERES","scopes":["admin:read","alerts:ack"]}]}
```

Adaptador, OGID_OPERATOR_CREDENTIAL_FILE:

```json
{"token":"REEMPLAZAR_CON_UN_SECRETO_ALEATORIO_DE_32_O_MAS_CARACTERES","scopes":["admin:read","alerts:ack"]}
```

Carpeta privada 700, ambos archivos 600. Token solo en archivos, nunca en argumentos, Git, chat o logs. El backend mantiene la autenticación sensible anterior y admite además esta autorización scoped. Un Bearer sin x-ogid-mcp-operation válido no concede este bypass. Método, ruta, parámetros fijos y cuerpo deben coincidir con el contrato compartido.

Ejemplo de comando del hijo MCP en el perfil separado, con rutas absolutas reales:

```text
/usr/bin/env -i PATH=/usr/bin:/bin OGID_BASE_URL=http://127.0.0.1:3000 OGID_PROFILE=operator OGID_INSTRUMENT_AUTH=runtime OGID_OPERATOR_CREDENTIAL_FILE=/ABSOLUTE/PATH/private/operator-adapter.json /usr/bin/node /ABSOLUTE/PATH/ogid/integrations/ogid-mcp/src/index.js
```

Cada conexión usa su propio túnel; no ejecutar dos clientes para el mismo tunnel_id. Estas credenciales son de OGID, diferentes de la runtime API key del túnel OpenAI. No se ha creado una conexión operador ni un secreto real como parte de esta implementación.

Ejemplo de reconocimiento, exclusivamente tras entregar el aviso al destinatario previsto:

```json
{"operationId":"portfolio.alerts.ack","body":{"candidateIds":["ID_DEVUELTO_POR_UN_CANDIDATO_OBSERVADO"],"deliveredAt":"2026-10-06T12:00:00Z"}}
```

La lectura material persiste candidatos observados; no afirma que se hayan enviado. Reconocer un candidato desconocido o una entrega futura se rechaza. Sin un ejecutor autorizado que reconozca entregas, la deduplicación persistente identifica hechos/correcciones pero puede volver a ofrecer candidatos pendientes. No habilitar un scope de escritura en investigación ni simular un reconocimiento con texto del modelo.
