# Decisiones vigentes

26/10/2026, aprobación explícita del plan por el usuario:

- D01: primer ciclo 0 + A; B–F continúan la hoja de ruta. Evita mezclar rediseño global con la base necesaria.
- D02: puertas separadas para núcleo y calidad semántica IA; agente permanece shadow. Conectividad y suite verde no acreditan utilidad del analista.
- D03: consolidar EN/ES/FR/DE/PT; idioma desconocido/no soportado explícito. RU/UK se amplían durante piloto con evaluación propia.
- D04: publisher por identidad/aliases exactos/domino verificado y metadata explícita. Transporte, descubrimiento, editor y origen son entidades diferentes.
- D05: preservar identidades y URL originales, revisiones, histórico y snapshots. Enriquecer por páginas reanudables sin reescribir evidencia congelada.
- D06: críticas ordena severidad, analysisScore, publicación e ID; recientes ordena publicación, severidad, analysisScore e ID. El ID sólo desempata al final.
- D07: conservar arquitectura de escritor único, lectores query_only y coordinación durable. Límites/guardias/fences/leases/reparación única intactos.
- D08: evidencia de observador, log y contadores históricos se informa por ventanas y denominadores separados. v19 no cierra puerta formal de 24 h.
- D09: publicación sólo mediante conector GitHub cuando esté autorizada. Preparación local no implica push, merge o despliegue.
- D10: continuidad en MD y nota breve de memoria. Excepciones gitignore concretas; fuentes privadas, .env, bases, logs y modelos excluidos.
- D11: arranque exclusivamente `cd backend && npm start`, control de hijos en `.env`, conservar llama.cpp; sin systemd.

Añadir aquí cambios de decisión con fecha y evidencia; no sobrescribir las razones históricas ni copiar secretos.


Decisiones de implementación del primer ciclo, 26/10/2026:

- D12: alias exactos y registro de dominios para publisher-identity-v1. Un source declarado en un feed ajeno no acredita editor; sólo dominio directo conocido o metadata del descubrimiento Google admitido. Candidatos y conflictos permanecen explícitos. Conservar publisher heredado como etiqueta atribuida; la resolución depende de los campos nuevos.
- D13: news-classification-v2 es una política heurística, no verificación de incidentes. Modalidad separada de severidad; sin soporte no se asigna low. Prioridad legacy-editorial-priority-v1 centralizada, sin medidor político ni probabilidad factual.
- D14: clasificación y normalización comparten reglas con Advanced/alertas; proyección pública compacta y metodología global en capabilities. Mantener presupuesto de bytes, sin truncar evidencias para pasar tests.
- D15: backfill por métodos versionados de identidad/clasificación, watermark rowid, cursor y cambios transaccionales con idempotencia. Preservar contentRevision/publicación/recepción y revisiones congeladas. Los registros que exceden la página se difieren con error visible, sin saltos silenciosos.
- D16: 023 añade sólo dos índices parciales de status medidos; páginas activas/inactivas dentro de una vista transaccional. 001–022 permanecen intactas. El benchmark en memoria no explica la E/S real.
- D17: el entorno presenta montajes ro y el backup real no se pudo verificar; mantener puerta operativa cerrada. Continuar código/fixtures no autoriza tocar volúmenes, sustituir la base o instalar dependencias operativas.
- D18: evidencias de esta ejecución en .implementation-evidence/2026-10-26, ignorado y privado, porque el enlace existente al HDD es ro. Los MD contienen el resumen necesario para reanudar sin /tmp.

- D19: idioma esperado del catálogo y lengua del ítem son datos diferentes; sólo metadata del ítem o reglas explícitas alimentan la clasificación. El esquema efectivo se mantiene separado del esquema esperado y se propaga en health/MCP. El hash MCP incluye los módulos editoriales compartidos que utiliza.
- D20: API-MCP.md es generado; ampliar el generador y regenerar, conservando inventory:check como puerta de coherencia.

- D21 (26/10/2026): usuario autoriza cierre de A en feat/agentic-intelligence mediante commit y continuación de B del mismo modo, con commit separado. Incluye publicar código y documentación revisados mediante conector GitHub; no implica desplegar, arrancar, fusionar ni promover IA. B usa datos reales sólo con autorización de uso declarada; en su ausencia queda sin evaluar y las pruebas usan identidades ficticias.
