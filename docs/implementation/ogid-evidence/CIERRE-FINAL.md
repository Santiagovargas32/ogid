# Estado del producto y condiciones de entrega final

Actualización vigente: 26/10/2026, lote del punto 2 posterior a C. Leer primero [ESTADO.md](ESTADO.md). El [diagnóstico](../../OGID-diagnostico-direccion-y-plan-2026-10-25.md), [CIERRE-C.md](CIERRE-C.md) y [RECUPERACION.md](RECUPERACION.md) son cortes fechados; sus recuentos y pendientes anteriores no son el estado actual.

## Estado actual

C está publicada: **40a027d**, [CI 40404890887 correcta](https://github.com/Santiagovargas32/ogid/actions/runs/40404890887). Código de cierre validado con 1071/1071 backend y 32/32 MCP. Base reparada seleccionada, esquema 025, recuperación sin pérdida cerrada. Backend detenido; llama.cpp y controles .env conservados; IA shadow.

El usuario autorizó cerrar **punto 2 antes de D/E/F**. Las instalaciones backend y MCP ya coinciden con los locks: **0 discrepancias y 0 vulnerabilidades runtime** en ambos. El túnel/adaptador MCP se recargó conservando configuración. La conectividad al backend sigue separada: sin servidor, CONNECTION_FAILED es el resultado esperado.

**Punto 2 cerrado:** 146.475/146.475 noticias enriquecidas; facetas y publicaciones C completas, 179.795 afirmaciones atribuidas y 146.475 cambios del journal. Cursor complete=true, cero proyecciones actuales pendientes. Identidad/fechas/contentRevision globales y 147 revisiones muestreadas conservadas; aliases, evidencias, snapshots, velas y alertas sin pérdidas. Reapertura idempotente: 0 noticias procesadas. Véanse cifras y límites en ESTADO.md.

El candidato actualizado pasó 1074/1074 backend y 32/32 MCP; la instalación MCP final pasó 32/32. Se instalaron Express 5.3.0, Helmet 8.3.0, ws 8.22.0, Yahoo Finance 4.0.5 y SDK MCP cliente/servidor 2.4.0; Zod 4.6.7 y dotenv 16.6.1 conservados. 138 paquetes runtime backend/3 MCP matched y auditorías 0. Los locks nuevos fueron probados antes de instalarlos; no se modificaron dependencias del backfill activo.


## Entregas frente al diagnóstico

| Entrega | Código y evidencia actual | Qué falta para su cierre de producto |
|---|---|---|
| **0 · Base operativa** | Identidad/release, mantenimiento determinista, status acotado y trazabilidad implementados. Base recuperada y seleccionada; integridad/FK/recuentos completos y almacenamiento real correctos | Instalaciones alineadas; completar reproducciones/mediciones 0.2 sobre datos íntegros; puesta en servicio y nueva cohorte continua. Backup manual según responsabilidad acordada |
| **A · Identidad y clasificación** | Implementada, verificada en aislamiento y publicada: 9cbdef2. EN/ES/FR/DE/PT, publishers exactos, modalidades e IDs/revisiones conservados | Backfill completo; evaluación editorial ampliada y aceptación operativa pendientes |
| **B · Fuentes y cobertura** | Implementada, verificada y publicada: 9a3aa2f. Evaluaciones temporales, importador, permisos, medidor y cobertura | Facetas históricas completas; incorporar evaluaciones sólo si existe acceso/licencia autorizados, o mantener «sin evaluar» explícito; comprobar uso real |
| **C · Comparación y afirmaciones** | Cierre definitivo de implementación/integración 1071/1071 + 32/32; commit 40a027d publicado por conector y 025 aplicada; API/MCP/UI y auditoría verificadas | Backfill persistente completo y lecturas reales verificadas. La extracción v1 es heurística y atribuida; evaluación editorial ampliada y observación operativa siguen en su puerta global |
| **D · Situaciones y motor 24 h** | Handoff concreto en ENTREGA-D.md; C aporta journal y versiones inmutables | Implementar consumidor transaccional, stream de awareness, dominio incidente/situación, correcciones, emisión idempotente y transición de bandeja. Probar >500, reinicio/ACK perdido y modo IA off |
| **E · Piloto y fuentes** | Matriz inicial en FUENTES.md; ámbitos Ucrania/Mar Negro y mar Rojo definidos | Admitir/verificar fuentes reales y sus accesos; medir cobertura, duplicación, fechas/lugares y latencias; evaluación específica RU/UK y revisión humana |
| **F · Analista e impactos** | Existe runtime IA y módulos analíticos previos; la nueva entrega sobre situaciones no está implementada | Síntesis y cronologías con evidencia elegible, contradicciones y propagación de correcciones; impactos/valores numéricos trazables y evaluación útil por tarea |

## Origen de las discrepancias — resueltas

Los locks se actualizaron en a1d0fb8 para corregir dependencias, manteniendo las instalaciones anteriores durante el shadow. No eran nueve dependencias nuevas de C. Este lote aplicó npm ci primero reproduciendo el grafo de C. Después se verificaron e instalaron actualizaciones compatibles publicadas: los nuevos locks sustituyen a los anteriores. La actualización transitiva content-disposition 2.0.1 y content-type 2.1.0 procede de Express 5.3.0, cuyo contrato integrado pasó la suite. No se impuso un cambio mayor de dotenv ni un downgrade forzado.

| Instalación | Paquete | Anterior (corte C) | Instalado y fijado ahora |
|---|---|---|---|
| Backend | body-parser | 2.3.0 | 2.4.0 |
| Backend | body-parser/content-type | 2.0.0 | 2.1.0 |
| Backend | fast-uri | 3.1.8 | 3.1.9 |
| Backend | iconv-lite | 0.7.2 | 0.7.3 |
| Backend | ip-address | 10.7.3 | 10.7.5 |
| Backend | qs | 6.16.0 | 6.16.1 |
| Backend | undici | 7.30.0 | 7.30.1 |
| Backend | zod | 4.5.4 | 4.6.7 |
| MCP | zod | 4.6.5 | 4.6.7 |

138 paquetes runtime backend y 3 MCP verificados frente a sus locks; Yahoo Finance se fija en 4.0.5 tras verificarlo. «0 vulnerabilidades» describe las auditorías actuales del grafo runtime, no una garantía permanente ni una razón para forzar downgrades o cambios mayores. Node operativo 22.23.3, compatible con engines; CI C utilizó Node 24; el recibo del nuevo commit identifica su CI.

## Enriquecimiento A/B/C

Sí: aplica a las noticias existentes la identidad/clasificación A, facetas B y comparación/afirmaciones C usando texto ya permitido. No descarga nuevamente contenido ni llama al modelo. El paso único comparte cursor y transacción, con hasta 100 referencias/128 KiB y objetivo 50 ms de procesamiento por página. El tiempo de commit puede superar ese objetivo; las mediciones y episodios largos deben quedar explícitos.

`cd backend && npm run news:enrich` consulta sin escribir; `npm run news:enrich -- --apply --max-pages=3` ejecuta un piloto persistente y pausa; sin max-pages continúa hasta completar. La herramienta respeta el owner y usa StorageManager sin configurar proveedores ni recuperación de trabajos ajenos. Cada página y recibo se confirman junto al cursor. SIGINT/SIGTERM pausan tras la operación en curso. Si una fila/error impide avanzar, se detiene y se resuelve; no se salta para declarar completo.

Se conservan IDs, URLs, aliases, publicación/recepción, contentRevision y revisiones congeladas. Los metadatos pueden añadir una revisión sin rejuvenecer el contenido ni emitir un incidente nuevo. Desconocido sigue desconocido; la cobertura no implica calidad editorial verificada. B conserva «sin evaluar» cuando no hay dataset autorizado, con independencia de terminar el histórico.

## Orden hasta la entrega final

1. Punto 2 cerrado: instalaciones, histórico y conservación comprobados. Permanecen 141.959 editores pendientes, 34.161 clasificaciones unknown-language y 2.671 unsupported-language; «sin evaluar» sin dataset autorizado. El usuario mantiene el backup manual. La próxima implementación es D.1.
2. D.1/D.2/D.3 desde ENTREGA-D.md: consumidor durable y outbox, awareness, incidentes/situaciones y transición de bandeja/ACK. Las entradas históricas del journal no son incidentes recientes.
3. E: accesos y cobertura reales de Ucrania/Mar Negro y mar Rojo; evaluación lingüística RU/UK y muestras anotadas. F: síntesis/cronologías/impactos con evidencia elegible, correcciones y puerta semántica por tarea.
4. Punto 3 progresivo: comportamiento, persistencia, contratos/UI/permisos/budgets, >500, reinicios, ACK perdido y correcciones cuando existan sus consumidores. Repetir suites cerradas sólo por cambios/fallos o dudas justificadas. El journal C no sustituye a D.
5. Punto 4 al final: candidato identificado sin cambios de artefactos durante 24 h continuas; evaluación IA separada, manteniendo shadow hasta su aceptación. v19 (23 h 54 min) no acredita la puerta formal.

## Puertas que siguen abiertas

- 0.2: reproducir y explicar costes actuales de lectura/SQL/commit/checkpoint. El lote histórico ya vuelve a registrar commits de varios segundos; no atribuirlos a una causa física sin evidencia. Objetivos del diagnóstico son objetivos, no resultados alcanzados.
- D/E/F y su evaluación de producto; contratos/UI y durabilidad integrados sobre cada candidato.
- Núcleo sin IA/navegador con adquisición real, recuperación controlada y observación continua final; la ejecución de mantenimiento no lo acredita.
- Calidad semántica IA con denominadores, evidencia/citas/números válidos y correcciones; conectividad y suites no acreditan utilidad.
- Importación de evaluaciones sólo con datos/autorización disponibles; en su ausencia la app debe mantener «sin evaluar», sin bloquear el desarrollo de D.

La recuperación, los recuentos históricos de C y los resultados anteriores se conservan fechados en sus informes y HISTORICO-CONTINUIDAD.md. El estado actual y siguiente acción tienen una sola entrada: ESTADO.md.

## Decisión de versiones y evidencia actual

La tabla anterior muestra los nueve desfases iniciales y su primera corrección, no el total de cambios del candidato posterior. Las versiones directas finales son las del párrafo de cierre y package.json/package-lock.json; las actualizaciones transitivas están identificadas en dependency-upgrade-review.json privado. Selección contrastada con el registro npm y notas oficiales de [Express 5.3.0](https://github.com/expressjs/express/releases/tag/v5.3.0), [Helmet](https://github.com/helmetjs/helmet/blob/main/CHANGELOG.md), [SDK MCP 2.4.0](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/2.4.0) y [Yahoo Finance](https://www.npmjs.com/package/yahoo-finance2?activeTab=versions). La prueba funcional decide la instalación; la etiqueta latest no la sustituye.

El objetivo 0.2 sigue abierto: p95 de ejecución por página 205,46 ms pero máximo 12.012,02 ms; commits lentos hasta 11.944 ms y checkpoints hasta 18.331,89 ms. Cobertura de 30 días: 1.926,98 ms en la muestra; otras 11 lecturas ≤1,42 ms. No son un p95 general de API ni explicación física. El enriquecimiento está completo sin certificar rendimiento operativo o calidad semántica.
