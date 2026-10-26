# Estado de implementación — leer primero

Actualizado 26/10/2026 22:40 UTC. Plan v4. Rama `feat/agentic-intelligence`.
**Punto 2 cerrado:** instalaciones seguras compatibles y enriquecimiento histórico A/B/C completos. Base anterior: C `40a027d21bcf5cb7140a16bbf8649d3c7126dbc4`, [CI 40404890887 correcta](https://github.com/Santiagovargas32/ogid/actions/runs/40404890887). Este checkpoint se publica en el commit separado `fix(maintenance): cerrar dependencias y enriquecimiento histórico A/B/C`. Su SHA/tree y CI posterior se registran en el recibo privado `point-2/publication.json`; contrastarlos con Git al reanudar. No confundir la base anterior con el HEAD de este lote.

Contrato 1.11.0, esquema efectivo 025; siguiente migración libre 026. Este lote no añadió ni editó migraciones. ArtifactHash de código backend: `34998318783704180eec13370d801551b0b1c9326704303be56ad029e94b2cf0`; instalación/locks/Node se identifican por separado en identity-final.json. No es una declaración de servidor arrancado.

## Resultado del punto 2

- **138 paquetes runtime backend y 3 MCP, 0 discrepancias** con los nuevos locks; auditorías runtime y del grafo completo **0 vulnerabilidades**. Express 5.3.0, Helmet 8.3.0, ws 8.22.0, Yahoo Finance 4.0.5, SDK MCP cliente/servidor 2.4.0; Zod 4.6.7 en ambos y dotenv 16.6.1 conservados. Node operativo 22.23.3. No se adoptó el cambio mayor dotenv 18 ni un downgrade con audit fix --force.
- Las diferencias iniciales 8+1 procedían de los locks a1d0fb8 no instalados durante shadow. Primero se reprodujeron esos locks; después se contrastó el registro y se verificaron las versiones compatibles posteriores en aislamiento. Los locks nuevos sustituyen a los anteriores. Backend se instaló tras cerrar el backfill; MCP se recargó controladamente y pasó 32/32 sobre la instalación efectiva. Configuración/credenciales y llama.cpp preservados.
- **146.475/146.475 noticias enriquecidas**, cursor=upper=processed=146475, complete=true. Facetas B=146475, publicaciones C=146475, afirmaciones atribuidas=179795, cambios durables=146475; cero facetas/publicaciones desactualizadas. Es el texto permitido ya almacenado, sin descarga ni IA.
- Conservación global de IDs/URLs/fechas/contentRevision verificada por hash. Se conservan 410.829 aliases, 356.701 evidencias, 678 snapshots, 42.383 velas y 48.526 revisiones de velas. **147 revisiones originales muestreadas** mantienen su hash; las 295.076 revisiones previas no se reescriben: se añaden 146.475 revisiones de metadatos (total 441.551). Alertas y publicaciones del agente conservan 3.762/141 filas: el backfill no emitió incidentes nuevos.
- Piloto persistente: 12 noticias/3 páginas; reapertura desde 12. Pausa por SIGTERM a 15.453 y reanudación desde ese cursor. Pasada final: 6.702 páginas, cierre limpio sin owner. Una nueva ejecución completa procesa **0 noticias**; la instalación backend final también abre esa base y cierra sin repetir filas.
- Lecturas reales readonly/query_only: cobertura completa de 30 días, grupos/publicaciones/afirmaciones actuales y dos páginas del journal con el mismo corte. Datos elegibles y referencias de cuatro publicaciones/afirmaciones comprobados; no se presentó como evaluación editorial exhaustiva ni ensayo de red.

## Límites de calidad y rendimiento — siguen explícitos

La proyección está completa; **no todas las identidades están resueltas**: 4.516 noticias tienen editor resuelto y 141.959 lo conservan pendiente. La muestra contiene fuentes fuera del registro y noticias Google sin identidad editorial suficiente. No se reconstruye el `<source>` que se perdió históricamente ni se atribuye Google como publisher. Ampliar registro/accesos corresponde a E y requerirá un enriquecimiento versionado posterior si cambia la resolución.

Clasificación: 109.643 evaluated, 34.161 unknown-language, 2.671 unsupported-language. Son estados de clasificación, distintos del recuento de etiquetas lingüísticas. Evaluaciones/perfiles B=0/0: «sin evaluar» correcto, sin licencias ni datos inventados. Origen independiente no acreditado; hay 0 cadenas de origen conocidas.

**0.2 permanece abierto:** pasada cooperativa p95 de ejecución=205,46 ms, máximo=12.012,02 ms; cola p95=1 ms. Se registraron 68 commits ≥1 s, máximo=11.944 ms, y checkpoints hasta 18.331,89 ms. commitMs por comando es null para este método; no equivale a cero ni al tiempo total. La lectura de cobertura de 30 días tardó 1.926,98 ms; las otras 11 consultas de muestra fueron ≤1,42 ms. Cohorte local después del backfill, sin adquisición/inferencia iniciadas ni carga de servidor; no acredita p95 general ni objetivos operativos. No se elevaron guardias ni presupuestos; causa física no demostrada.

## Verificación y evidencia

Candidato final de fuentes/dependencias en aislamiento: **backend 1074/1074**, **MCP 32/32**. MCP instalado final: **32/32**; build/check/inventario 92 rutas/101 operaciones correctos; auditorías 0. Regresiones dirigidas del escritor/C 34/34 y negocio 29/29. La prueba de enrutamiento se corrigió para observar llamadas de lectura, sin contar mantenimiento de fondo como trabajo del lector. La primera copia candidata omitía frontend y se detuvo: se completó el árbol y la pasada final fue íntegra. Los errores y repeticiones se conservan en los logs.

Evidencia privada: `.implementation-evidence/2026-10-26/point-2/`:
`dependencies-final.json`, `identity-final.json`, `latency-summary.json`, `historical-before.json`, `historical-pilot.json`, `historical-final.json`, `product-readonly.json`, `finish-validation.json`, `historical-idempotent.log`, `backend-final-reopen.log`, `backend-candidate-final-tests.log`, `mcp-final-tests.log`, auditorías/build/inventario y recibos de publicación. No hay validadores propios ni backfill pendientes de ejecución. /tmp contiene sólo el candidato de dependencias, no datos operativos ni la única evidencia.

## Base y restricciones

`.env` selecciona `/home/fedora/.local/share/ogid/db/ogid-repaired-20261026-183735.sqlite`; recuperación exacta cerrada, [RECUPERACION.md](RECUPERACION.md). Tamaño después del enriquecimiento: 11,674,550,272 bytes. El original ogid.sqlite está dañado y no es una reversión. No repetir copias/forense/integridad completa sin indicios nuevos; backup manual a cargo del usuario.

Servidor operativo **detenido**. Túnel/adaptador MCP recargado y readyz=200; sin backend, CONNECTION_FAILED es esperado y no acredita conectividad al servicio. No se inició observación 24 h ni se promovió IA; conservar shadow. Arranque únicamente `cd backend && npm start`, hijos gobernados por .env, llama.cpp intacto. Un escritor, lectores readonly/query_only, límites, fences/leases y snapshots se conservan.

## Siguiente acción y entregas

**Siguiente implementación: D.1**, desde [ENTREGA-D.md](ENTREGA-D.md), con el alcance que autorice el usuario. Antes contrastar SHA/diff y recibo de publicación/CI de este lote; si una publicación quedó pendiente, cerrarla antes de iniciar otra entrega. No repetir C, instalaciones, backfill ni suites cerradas sin cambios/fallos. D debe consumir el journal completo (146.475 entradas en este corte), con cursor/efectos/outbox transaccionales y bootstrap histórico que no convierta indexación en incidentes recientes. No saltar el historial inicializando el cursor al máximo.

| Entrega | Estado vigente |
|---|---|
| 0 | Identidad, mantenimiento sin IA y consultas acotadas implementados; recuperación e instalaciones cerradas. Costes 0.2 y aceptación operativa pendientes |
| A | Código 9cbdef2 y enriquecimiento completo bajo métodos vigentes; desconocidos explícitos |
| B | Código 9a3aa2f y facetas completas; sin dataset autorizado se mantiene sin evaluar |
| C | Código 40a027d e índice/afirmaciones históricos completos; no equivalen a incidentes verificados |
| D | Handoff preparado; consumidor/awareness/situaciones/bandeja aún sin implementar |
| E / F | Pendientes de implementación y evaluación |
| Final | Pruebas integradas progresivas y, sobre candidato final, 24 h continuas y evaluación IA separada |

Cortes históricos: diagnóstico 25/10, CIERRE-C, RECUPERACION y [HISTORICO-CONTINUIDAD.md](HISTORICO-CONTINUIDAD.md). El estado vigente es este archivo; PLAN, DECISIONES, PROMPTS y CIERRE-FINAL enlazan la continuación. Reversión: conservar esquema/datos y corregir metadatos con nueva versión/revisión; no borrar proyecciones/journal ni restaurar la base dañada. Las instalaciones anteriores sólo se recuperan mediante locks revisados y recarga controlada.
