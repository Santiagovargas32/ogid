# Progress: Agentic Intelligence

## Estado de la integración

La implementación pendiente de integración está distribuida en:

- `backend/services/agent/`: broker, worker, runtime gestionado, selección de modelos, cliente OpenCode, configuración y modo shadow.
- `backend/storage/agentRepository.js` y `backend/storage/migrations/010_agent_intelligence.sql`–`017_news_projection_window.sql`: persistencia, trabajos, sesiones, ejecuciones, snapshots e índices.
- `backend/routes/agentRoutes.js`, `backend/server.js` y `backend/scripts/agent-*.js`: exposición HTTP, arranque/control de componentes y operaciones de comprobación.
- `backend/deploy/agent/research-tools.json`: manifiesto de herramientas de investigación.
- `frontend/js/agent*.js`, `frontend/css/agentIntelligence.css`, `frontend/index.html` y `frontend/admin.html`: panel de inteligencia, modelos y operaciones.
- `integrations/ogid-mcp/`: contratos, operaciones, herramientas y pruebas del adaptador MCP.

## Pendiente

- Completar la validación operativa del flujo completo broker → OpenCode → worker con los componentes habilitados en `backend/.env`.
- Ejecutar las comprobaciones preparadas en `backend/scripts/agent-preflight.js`, `agent-migration-check.js`, `agent-snapshot-check.js`, los smoke tests y la observación shadow.
- Verificar el catálogo y la selección de modelos contra la instancia OpenCode disponible.
- Confirmar la aplicación ordenada de las migraciones `010`–`017` y la persistencia de trabajos, ejecuciones y snapshots.
- Validar la integración de las rutas de agente, el panel administrativo y las operaciones MCP en el entorno objetivo.
- Revisar los resultados de las pruebas nuevas de agente y de las regresiones de backend antes de promover el modo shadow o visible.

## Alcance subido

Este archivo acompaña todos los archivos modificados y nuevos que ya estaban presentes en la rama `feat/agentic-intelligence`. El archivo local `backend/.env` no forma parte del alcance.
