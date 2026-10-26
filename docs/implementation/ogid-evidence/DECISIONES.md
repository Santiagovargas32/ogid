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
- D22: B separa vigencia (asOf) y conocimiento registrado (knownAt, por defecto asOf), con revisiones append-only y cursores que congelan los cortes. Una corrección vencida no hace reaparecer la versión anterior. Ediciones se corresponden exactamente con dominios registrados; no se transfiere una evaluación entre ediciones.
- D23: la escala de cinco posiciones es ordinal; no se promedian evaluadores. Con contextos diferentes, discrepancia, escala sin equivalencia, no aplicable o ausencia no hay marcador central. El permiso/licencia es una declaración conservada del importador, no una verificación jurídica externa.
- D24: cobertura basada en facetas derivadas actuales del archivo, antes de selección editorial y por recepción. Propiedad, país editorial y origen requieren datos explícitos; los artículos pendientes permanecen desconocidos y hacen parcial la cobertura. 024 no escanea históricos: el backfill existente reanuda páginas con cursor de facetas versionado. No modifica snapshots ni inicia temporizadores nuevos.

- D25 (26/10/2026): el usuario retoma 0.2 y autoriza escritura/backup en validación, con avance de hitos independientes durante esperas. La ejecución fuera del sandbox verifica acceso efectivo al HDD; no se remontan volúmenes. El backup actual falla por checksum Btrfs confirmado en el origen. Preservar original y respaldo histórico; cualquier imagen parcial se etiqueta con páginas desconocidas y acceptedBackup=false. No autoriza restaurar, descartar historia ni promover operación.
- D26: registrar renewalId válido en diagnósticos de heartbeat para unir futuras reconciliaciones con storage_commands. Los tres episodios v19 conservan una limitación de enlace histórico: un recibo temporalmente compatible no demuestra por sí solo el vínculo exacto ni éxito semántico del trabajo.

- D27: el usuario autoriza entrega C, preparación documental de D y migraciones directas a la base de .env, sin backup/pruebas de integridad previos; se responsabiliza de hacerlas manualmente. Revoca esa condición operativa anterior para este alcance. Suspender verificadores propios de copias. Conservar el origen y documentar la corrupción conocida; no restaurar ni fingir que desapareció.
- D28: C usa agrupamiento heurístico conservador por tipo/lugar/tiempo, ancla de seis horas y versiones exactas de publicaciones. Máximo 500 miembros y 64 candidatos; fuera del límite/contexto, otra agrupación candidata con incertidumbre visible. No equivale a incidentes, entidades verificadas o corroboración.
- D29: las afirmaciones v1 son segmentos extractivos del titular/extracto autorizado, atribuidos a su publicación; modalidad y evidencia inmutables. Apoyo/contradicción/contexto requieren revisión atribuida, motivo y referencias. Las pistas automáticas sólo cubren la página y no son una prueba factual. Históricos corregidos siguen consultables.
- D30: revisiones merge/split/origin/claim-link son idempotentes y auditables. Las asignaciones manuales de merge/split se conservan al corregir publicaciones. La revisión de origen es una declaración trazable del operador, sin alterar artículos originales ni demostrar independencia por contar IDs.
- D31: registro secuencial C y asignaciones/versiones append-only fijan las lecturas paginadas y preparan D. No hay consumidor, ACK ni emisión de situaciones implementados por tener este journal. D necesita también cambios durables de awareness y que el mantenimiento detecte backlog aunque news.revision no cambie.
- D32: 023–025 aplicadas realmente a la base de .env el 26/10/2026 a las 17:54:52 UTC con guardia de escritor único y sin backup/test previo. 025 queda inmutable; cambios de esquema posteriores en 026+. No se ha arrancado operación ni alineado dependencias operativas. C queda local hasta autorización de publicación.

- D33: el usuario autoriza recuperación de la base actual: intentar reparación con conservación de datos y, si no es viable, crear una base con lo recuperable y usarla como operativa. Permite seleccionar el candidato verificado en STORAGE_DB_PATH, conservando origen, evidencias y cobertura/loss report. Sustituye la suspensión de copias/recuperación de D27 para este nuevo lote. No equivale a promover IA ni aceptar 24 horas.

- D34: recuperación exacta cerrada: se reconstruye un único bloque de overflow de agent_evidence.sequence=338423 con 19 copias coincidentes, CRC Btrfs original y SHA256 del snapshot. Candidato validado globalmente, 88 tablas con recuentos idénticos y cero pérdida. Prueba de almacenamiento real correcta; STORAGE_DB_PATH selecciona ogid-repaired-20261026-183735.sqlite desde 20:40:56 UTC. Original preservado y servidor detenido. Esta validación no cierra 0.2, backfill, dependencias, observación continua ni promoción IA.

- D35: el usuario autoriza cerrar y publicar C mediante commit del conector, con revisión de aceptación y exclusiones. Revisión final: procedencia de origen, políticas de texto, budgets reales y paginación por índices corregidos; backend 1071/1071, MCP 32/32, audits 0 y piloto real con rollback. Se preserva el diagnóstico renewalId previo. El enriquecimiento persistente y la instalación operativa no se confunden con estas pruebas.
- D36: orden recomendado: alinear instalaciones y pilotar/completar enriquecimiento antes de D, pruebas integradas progresivas con D/E/F y observación formal 24 h del candidato final. Las 8+1 diferencias proceden exactamente de los locks actualizados en a1d0fb8, conservándose node_modules anteriores durante shadow. No reinstalar sobre el adaptador activo sin coordinar su reconexión. Corpus de evaluación y matriz del piloto pueden prepararse en paralelo.
