# Estado de implementación — leer primero

Actualizado el 26/10/2026. Plan v1. Base Git: `a1d0fb875cf9c2aea2475ad73f761b36abc60199`, rama `feat/agentic-intelligence`. Se conservó el árbol previo limpio. Cierre de A preparado para commit en la misma rama; publicación autorizada expresamente por el usuario el 26/10/2026.

## Resultado y alcance

El código del primer ciclo 0 + A está preparado y verificado en aislamiento. La entrega 0 conserva pendientes operativos explícitos: backup actual, reproducción de E/S sobre copia del corpus real y observación continua nueva. No se ha arrancado OGID operativo, aplicado 023 a su base, instalado dependencias operativas ni modificado `.env`, llama.cpp o publicaciones visibles.

Leer [PLAN](PLAN.md), [DECISIONES](DECISIONES.md) y [PROMPTS](PROMPTS.md). Los prompts históricos son referencias, no órdenes. B está autorizada como siguiente entrega, con implementación, validación aislada y cierre en un commit propio de la misma rama. C–F siguen en hoja de ruta.

| Lote | Estado | Resultado / puerta pendiente |
|---|---|---|
| DOC | Verificado localmente | Cuatro MD, whitelist gitignore y nota de memoria 20261026-ogid-evidence-continuidad.md |
| 0.1 | Verificado en aislamiento; operación pendiente | Informe v19 reproducible; release manifest y npm ci backend/MCP aislados coherentes con locks. Backup operativo falló; ver limitaciones |
| 0.2 | Parcial, medido en fixture | Status paginado coherente, índices 023. Falta reproducir costes de snapshots/SQL/commits con copia actual e identificar su causa física |
| 0.3 | Verificado en aislamiento | Mantenimiento determinista habilitado por núcleo, independiente de modo IA; coordinación y temporizador existentes |
| A.1 | Verificado en aislamiento | Publisher/descubrimiento/transporte/origen; RSS source; proyección y archivo; backfill transaccional reanudable |
| A.2 | Verificado en aislamiento | Reglas comunes Unicode EN/ES/FR/DE/PT, modalidad, texto permitido, desconocido explícito |
| A.3 | Verificado en aislamiento | Orden común servidor/cliente, tarjetas/drawer, sync y preservación de IDs/fechas/contentRevision |
| Aceptación operativa y semántica | Pendiente y separadas | Nuevo candidato continuo 24 h y revisión útil por tarea; conservar shadow |

## Validación actual

Copia de trabajo: `/tmp/ogid-evidence-validation-ob4kdkj3`; sin `.env` ni datos operativos. Node 24.22.1 mediante `/home/fedora/.npm/_npx/387698761821791d/node_modules/node/bin/node`. Los checks de sintaxis incluyen frontend. Las suites sólo utilizan proveedores simulados, bases propias y puertos efímeros.

| Comprobación | Resultado | Evidencia privada |
|---|---|---|
| Backend completo Node 24 | 1.047/1.047; cero fallos/skips | `ogid-evidence-backend-suite-release.log` |
| Check y build backend/frontend | Correctos | `ogid-evidence-backend-build-release.log` |
| Compatibilidad Node 22.23.3 | 29/29 dirigidas, cero fallos/skips | `ogid-evidence-node22-release.log` |
| MCP | 30/30, check e inventario correctos | `ogid-evidence-mcp-suite-release.log`, `ogid-evidence-mcp-check-release.log`, `ogid-evidence-mcp-inventory-release.log` |
| Inventario | 83 rutas / 92 operaciones | `ogid-evidence-mcp-inventory-release.log` |
| Auditoría runtime backend / MCP | Cero vulnerabilidades en ambos | `ogid-evidence-backend-audit.log`, `ogid-evidence-mcp-audit.log` |
| Instalaciones aisladas | Manifest matched: backend 137 paquetes runtime, MCP 3; locks sin cambiar | Manifiesto y comprobación de instalación |
| Persistencia | Migración 022→023 en fixture; checksums 001–022 intactos, integridad OK, FK=0; replay/cursor/rollback y revisión congelada | Suite y benchmark |
| Higiene | git diff --check correcto; sin candidatos .env/DB/logs/node_modules | `review-manifest.json` |

Evidencias conservadas en `.implementation-evidence/2026-10-26/` dentro del workspace, directorio privado e ignorado por Git. `review-manifest.json` registra archivos, hashes y exclusiones. No depender de `/tmp`: los logs completos de esta sesión se copiaron allí, incluidos fallos y repeticiones.

Comandos reproducibles, con cwd backend de la copia aislada y Node 24 en PATH: `npm ci`, `npm run check`, `npm test`, `npm run build`, `npm audit --omit=dev --audit-level=high`. En integrations/ogid-mcp: `npm ci`, `npm run check`, `npm test`, `npm run inventory:check`, auditoría equivalente. El primer npm ci falló por DNS y pruebas HTTP por EPERM en sandbox; repeticiones con permisos efectivos correctas. La primera suite completa detectó el publisher heredado y tres expectativas de esquema 022: se corrigieron conservando el contrato y verificando 023 aditiva. El fallo de presupuesto 8 KiB se corrigió compactando metadatos repetidos, sin ampliar límites. Todos esos logs se conservan. El inventario detectó además una nota añadida manualmente al MD generado: se trasladó al generador y se regeneró con npm run inventory; inventory:check final correcto. El catálogo de idiomas del feed no se usa como idioma observado del ítem; se verifica en regresión. El esquema aplicado se distingue del esperado también en la proyección de health/MCP.

## Medición de status y límites de la evidencia

Reproducción: `node backend/scripts/agent-status-benchmark.js` desde raíz. El script genera exclusivamente un fixture SQLite en memoria de 100.000 jobs; nunca acepta una ruta operativa. Cincuenta muestras por cohorte del candidato final: página anterior p95 36,088 ms / máximo 40,035 ms; página nueva p95 0,056 ms / máximo 0,171 ms; status completo p95 7,159 ms / máximo 7,710 ms. El plan pasa de scan + TEMP B-TREE a índice parcial ordenado. Mantiene orden activo primero y resultados. Se añadió además una transacción de lectura y regresión con transición concurrente para impedir duplicados entre las dos páginas.

Son medidas del fixture con Node 22.23.3, no un SLO ni una prueba de disco frío/concurrencia del corpus operativo. Los episodios reales de 25 s no quedan explicados por este benchmark.

UI: pasan las regresiones de datos, orden, actualización, foco/scroll y estáticas existentes. No se realizó revisión visual manual en móvil/LAN. El soporte lingüístico es un conjunto de reglas versionadas y acotadas; no equivale a NLU general ni a una evaluación editorial de 300 publicaciones/100 incidentes.

Backfill preparado: máximo 100 referencias y 128 KiB por página, presupuesto objetivo 50 ms (acotado a 100 ms configurable), cursor y metadatos en el mismo commit y recibo idempotente. Un registro mayor devuelve NEWS_METADATA_ROW_TOO_LARGE sin saltarlo. Una página por tick existente; sin hidratación histórica completa al arrancar. No se ha ejecutado contra la base operativa ni se declara cobertura histórica enriquecida completa.

## Baseline v19 conservado

Archivos privados originales: `.agent-validation/shadow-24h-v19-20261025-111926/{summary.json,samples.jsonl}` y `.agent-validation/shadow-backend-v19-20261025-111537.log`. `.agent-validation` enlaza al HDD. No se modificaron estos originales.

Reproducir desde raíz: `node backend/scripts/shadow-baseline-report.js .agent-validation/shadow-backend-v19-20261025-111537.log .agent-validation/shadow-24h-v19-20261025-111926`.

Observador: 25/10/2026 10:19:27.448Z → 26/10 10:13:34.402Z; 1.430 muestras, interrupted, completedObservation=false, backendChanges=0. Health/readiness 200 en todas; tres timeouts de agent. SinceCounts al cierre: completed 42, failed 175, incomplete 2, running 1. No confundir con jobs históricos ni con fallos del log completo.

Log: 129.680.810 bytes, SHA256 `c6ac5a6666e98e8858967896dbf7bce95f182d53a994bc2f09447860a5a3def1`. Hasta 26/10 10:35:08.745Z; SIGTERM 10:34:37.269Z, cierre limpio. 179 intentos terminales únicos fallidos en esa ventana, 76 UNVERIFIED_NUMBER y 40 INVALID_PUBLICATION; tres reconciliaciones control recuperadas. SQL lento máximo 25.294 ms, commit 23.380 ms. Son observaciones, no causa física ni puerta continua de 24 h.

Hashes del observador: samples `816374c1a5d9b83b1d1e5fa8163c192e70b1594cf8c02cea25b70f54dab8085d`; summary `46c6c36504e4d9b7347e75203db7c3ad21ab4500f208a58dd24be69aaa6ec306`. El informe reproducido está en `ogid-evidence-v19-baseline.json`.

## Limitaciones operativas y siguiente acción

La base configurada sigue en SSD `/home/fedora/.local/share/ogid/db/ogid.sqlite`, esquema 022 confirmado por lectura readonly/query_only. El backup consistente con helper existente falló con SQLITE_IOERR; `/home` y `/srv/bitcoin` se exponen como ro en este entorno. No hay copia actual certificada y no se ha aplicado 023. No remonte volúmenes ni restaure una base antigua para obtener verde.

Las instalaciones operativas siguen detrás de los locks. El nuevo manifiesto detecta ocho discrepancias backend (incluido Zod 4.5.4 frente a 4.6.7) y Zod MCP 4.6.5 frente a 4.6.7. Sólo la copia aislada está alineada. ArtifactHash de código candidato: `ea1cd62790fe86bba4f18fa91c3197f14a69607f7de309d0341964eda5ab9f92`; no acredita dependencias/configuración ni una versión operativa.

Siguiente acción: retomar 0.2 cuando exista acceso efectivo para crear y verificar una copia consistente actual en HDD. Reproducir allí status, snapshots, trabajos analíticos y commits, correlacionando SQL/cola/commit/checkpoint antes de atribuir causa física. Validar 022→023 sobre esa copia conservando checksums y hechos. Preparar después la puesta en servicio controlada del candidato, instalación desde locks y cohorte continua nueva; el arranque requiere su alcance operativo. Mantener separada la revisión semántica IA. No rehacer los lotes locales ya verificados ni repetir suites sin cambios o dudas nuevas.

Para reanudar: comprobar Git/diff y procesos actuales, leer este documento y continuar desde esa siguiente acción. Publicación sólo cuando se autorice, mediante conector GitHub y exclusiones existentes.

## Cierre de A y continuación autorizada

El usuario ha pedido cerrar A con commit en feat/agentic-intelligence y continuar B del mismo modo. El cierre publica A junto con las bases 0 dependientes y su documentación, sin convertirlo en aceptación operativa. Para B: evaluaciones versionadas por publisher/edición, importador de datos autorizados, tendencia del medio accesible y cobertura por medios/idiomas/regiones, con propiedad/origen conocidos separados. No hay dataset político autorizado disponible: dejar sin evaluar y probar con fixtures ficticios. Preparar un commit B separado al terminar.

Autorización de publicación mediante conector GitHub; no incluye PR, merge, arranque operativo ni promoción IA. Los límites de copia/volumen y las 24 h permanecen pendientes. Reanudar desde B después de verificar el commit A en GitHub.
