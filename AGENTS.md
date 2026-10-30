Preferencia operativa persistente: OGID se inicia exclusivamente con
`cd backend && npm start`. Broker, OpenCode y worker son procesos hijos,
controlados con on/off en backend/.env. No instalar, utilizar ni recomendar
systemd para OGID o estos componentes. Conservar llama.cpp.

Seguimiento de desarrollo: Jira KAN contiene el estado vigente y los resultados
de implementación y validación, registrados en comentarios de la issue.
Los documentos de cierre existentes son evidencia histórica. No crear nuevos
Markdown de planes o evidencia salvo petición expresa del usuario.

Flujo autorizado para tareas de desarrollo, salvo alcance explícito distinto:

1. Leer la issue de Jira KAN por Atlassian MCP y validar aquí, en este servidor,
   que el cambio está implementado y funciona, con pruebas proporcionales.
2. Si la validación es correcta, crear y publicar el commit en la rama actual
   de trabajo mediante el conector GitHub. Este commit forma parte del flujo
   autorizado; no implica merge ni despliegue.
3. Esperar el CI del SHA publicado y comprobar el contenido y los checks remotos.
   Sólo después de que pasen, actualizar mediante Atlassian MCP el comentario
   y el estado de la tarea, incluyendo SHA, evidencia local y enlace al CI.

Si falla una comprobación, corregirla y repetir lo necesario antes del cierre.
No completar una tarea sólo por pruebas locales ni antes de comprobar su CI.
