# Estado del producto y condiciones de entrega final

Corte: **26/10/2026**, después de cerrar la recuperación y las verificaciones definitivas de C. Fuente: [diagnóstico](../../OGID-diagnostico-direccion-y-plan-2026-10-25.md), [PLAN.md](PLAN.md), [ESTADO.md](ESTADO.md) y [RECUPERACION.md](RECUPERACION.md). Este documento describe lo pendiente; no autoriza automáticamente publicación, despliegue ni promoción de IA.

## Estado de la app

La base operativa configurada ya es la reparada, esquema **025**, validada globalmente sin pérdida. El backend está **detenido**; no hay una nueva observación de operación en curso. Su almacenamiento sí se verificó con el escritor y lectores reales de OGID, sin servidor ni proveedores. Los procesos llama.cpp existentes y AGENT_MODE=shadow se conservan.

El cierre C se identifica por [CIERRE-C.md](CIERRE-C.md) y por el commit `feat(news): cerrar entrega C de comparación y afirmaciones`, con base B 9a3aa2f. A/B fueron publicadas en commits separados y la publicación de C está autorizada por conector. El recibo privado C-close/publication.json conserva el SHA y la comprobación de GitHub/CI. El candidato final de código pasó **1071/1071 backend, 32/32 MCP**, build, inventario y dos auditorías sin vulnerabilidades; esa pasada sustituye a la anterior con expectativas antiguas corregidas. No implica despliegue ni backfill persistente.

Las instalaciones operativas continúan desalineadas: **8 discrepancias backend y 1 MCP** frente a sus lockfiles, comprobadas en este corte. Las instalaciones aisladas usadas en las suites estaban alineadas. No se ejecutó npm ci operativo durante esta recuperación.

Las 146.475 noticias históricas están conservadas. Las facetas B y las publicaciones indexadas C contienen **0 filas** en este corte: el esquema y el código están preparados, pero el backfill editorial no ha corrido en operación. Una vista de comparación vacía ahora no acredita ausencia de noticias. B no incluye un dataset político autorizado; «sin evaluar» es el resultado correcto mientras falte.

## Entregas frente al diagnóstico

| Entrega | Código y evidencia actual | Qué falta para su cierre de producto |
|---|---|---|
| **0 · Base operativa** | Identidad/release, mantenimiento determinista, status acotado y trazabilidad implementados. Base recuperada y seleccionada; integridad/FK/recuentos completos y almacenamiento real correctos | Alinear instalaciones; completar reproducciones/mediciones 0.2 sobre datos íntegros; puesta en servicio y nueva cohorte continua. Backup manual según responsabilidad acordada |
| **A · Identidad y clasificación** | Implementada, verificada en aislamiento y publicada: 9cbdef2. EN/ES/FR/DE/PT, publishers exactos, modalidades e IDs/revisiones conservados | Ejecutar backfill reanudable y medir cobertura/error real; aceptación con datos operativos y evaluación ampliada |
| **B · Fuentes y cobertura** | Implementada, verificada y publicada: 9a3aa2f. Evaluaciones temporales, importador, permisos, medidor y cobertura | Completar facetas históricas; incorporar evaluaciones sólo si existe acceso/licencia autorizados, o mantener «sin evaluar» explícito; comprobar uso real |
| **C · Comparación y afirmaciones** | Cierre definitivo de implementación/integración 1071/1071 + 32/32; commit autorizado conector y 025 aplicada; API/MCP/UI y auditoría verificadas | Backfill persistente y muestra editorial real. La extracción v1 es heurística y atribuida; observación operativa/piloto quedan en su puerta global |
| **D · Situaciones y motor 24 h** | Handoff concreto en ENTREGA-D.md; C aporta journal y versiones inmutables | Implementar consumidor transaccional, stream de awareness, dominio incidente/situación, correcciones, emisión idempotente y transición de bandeja. Probar >500, reinicio/ACK perdido y modo IA off |
| **E · Piloto y fuentes** | Matriz inicial en FUENTES.md; ámbitos Ucrania/Mar Negro y mar Rojo definidos | Admitir/verificar fuentes reales y sus accesos; medir cobertura, duplicación, fechas/lugares y latencias; evaluación específica RU/UK y revisión humana |
| **F · Analista e impactos** | Existe runtime IA y módulos analíticos previos; la nueva entrega sobre situaciones no está implementada | Síntesis y cronologías con evidencia elegible, contradicciones y propagación de correcciones; impactos/valores numéricos trazables y evaluación útil por tarea |

## Origen de dependencias e históricos pendientes

Las **8+1 discrepancias no son dependencias nuevas de C**. Los lockfiles se actualizaron en `a1d0fb8` como parte de la corrección de dependencias/auditoría, mientras node_modules operativos se mantuvieron sin cambiar para preservar el shadow activo. Se contrastaron los locks anterior/posterior de ese commit y las instalaciones presentes:

| Instalación | Paquete | Instalado | Lock esperado |
|---|---|---|---|
| Backend | body-parser | 2.3.0 | 2.4.0 |
| Backend | body-parser / content-type anidado | 2.0.0 | 2.1.0 |
| Backend | fast-uri | 3.1.8 | 3.1.9 |
| Backend | iconv-lite | 0.7.2 | 0.7.3 |
| Backend | ip-address | 10.7.3 | 10.7.5 |
| Backend | qs | 6.16.0 | 6.16.1 |
| Backend | undici | 7.30.0 | 7.30.1 |
| Backend | zod | 4.5.4 | 4.6.7 |
| MCP | zod | 4.6.5 | 4.6.7 |

CI y la instalación aislada usan npm ci y sí coinciden con los locks. El objetivo operativo es reproducir ese grafo fijado, sin cambiar versiones arbitrariamente ni volver a introducir features. La observación anterior ya terminó y el backend está detenido, pero existe un adaptador MCP activo: coordinar su reconexión antes de sustituir su instalación. Conservar .env, base y llama.cpp. Verificar manifiestos matched, auditorías y pruebas dirigidas en el runtime elegido tras instalar.

El **enriquecimiento histórico** procede de migraciones aditivas que crearon proyecciones vacías sin escanear el archivo durante DDL: A aporta identidad/clasificación, B facetas editoriales y C grupos/afirmaciones/registro de cambios. No consiste en descargar otra vez las noticias ni en usar IA. Recorre las publicaciones ya guardadas y su texto permitido mediante `SqlNewsArchive.enrichEditorialPage`: hasta 100 referencias y 128 KiB por página, objetivo 50 ms, cursor durable y commit atómico. Conserva IDs, publicación, recepción, contentRevision y revisiones congeladas; los metadatos visibles pueden añadir una nueva revisión.

Actualmente están conservadas 146.475 noticias, pero el piloto C sólo confirmó una dentro de una transacción revertida. Por eso las facetas y publicaciones C persistidas siguen en cero. El cursor permite continuar sin empezar desde cero después de una interrupción. No reconstruye texto perdido ni inventa publisher/origen/idioma. Tampoco crea evaluaciones políticas: B necesita datos de uso autorizado o conserva «sin evaluar».

## Orden recomendado de ejecución

**No completar 2→3→4 enteros antes de nuevas entregas.** El punto 2 prepara datos/runtime; el 3 acompaña cada cambio y el 4 acepta un candidato identificado.

1. **Ahora, cerrar el punto 2 acotado:** npm ci backend y MCP en ventana controlada con reconexión del adaptador, sin tocar .env/llama.cpp. Manifiestos matched, auditorías y pruebas dirigidas; no arrancar una observación de 24 h mientras aún cambian sus artefactos.
2. **Piloto y backfill:** medir páginas reales, commit/cola y cobertura; comprobar reanudación, IDs/fechas y snapshots. Después completar A/B/C por páginas con progreso visible, sin hidratar el histórico completo en el escritor. Una fila grande/error se registra y se resuelve; no se salta para declarar completo. Hacer smoke operativo corto y mediciones 0.2 disponibles, sin confundirlos con la aceptación continua.
3. **D.1 y D.2:** consumir todas las revisiones con cursor/efectos/outbox en el mismo commit; añadir stream awareness y dominio de incidentes/situaciones. El histórico preparado aporta datos reales para probar backlog, correcciones y noticias antiguas. No convertir grupos C en hechos confirmados. Próxima migración: 026.
4. **D.3:** integrar bandeja, ventanas «cambió/ocurrió», compatibilidad de ACK/IDs y correcciones propagadas; probar >500, reinicio, ACK perdido e IA off. Estas pruebas del consumidor requieren que D exista; no las reemplaza la lectura de 513 cambios de C.
5. **E y F:** evaluar los pilotos Ucrania/Mar Negro y mar Rojo y sus accesos/idiomas; después síntesis, cronologías e impactos con evidencia elegible y correcciones. Mantener probability=null sin modelo probabilístico evaluado.
6. **Punto 3 durante toda la secuencia:** regresiones de comportamiento/persistencia/contratos/UI/permisos/budgets y medidas de rendimiento por entrega. Reutilizar resultados cerrados sin cambios, salvo la verificación integrada que justifique el candidato final. C ya tiene sus suites y transporte real cerrados.
7. **Punto 4 al final:** fijar código, locks, instalación, configuración y esquema; observar 24 h continuas del candidato final y evaluar por separado la utilidad semántica IA. Cambiar artefactos inicia otra cohorte. Publicación por conector con su alcance; promoción visible no se infiere de CI o conectividad.

Se pueden preparar **ya**, de forma independiente de D.1, el corpus anotado/guía de evaluación y la matriz verificable de fuentes del piloto E. El diagnóstico propone unas 300 publicaciones/100 incidentes como referencia inicial, no como conjunto ya evaluado. Las evaluaciones políticas sin licencia/dataset no bloquean D si su ausencia sigue explícita.

## Validaciones de entrega final

| Puerta | Evidencia necesaria | Estado en este corte |
|---|---|---|
| Conservación y recuperación | Datos, IDs, revisiones y snapshots íntegros; esquema/checksums correctos; lectura/escritura del almacenamiento | Recuperación exacta cerrada; backup independiente/restauración manual aún no acreditados por este lote |
| Comportamiento editorial | Publisher/descubrimiento, idiomas, ataque/huelga, modalidades, sindicación, afirmaciones y correcciones sobre corpus representativo | Regresiones A/B/C correctas; evaluación ampliada y piloto pendientes |
| Durabilidad D | Ráfagas >500, todas las páginas, reinicio, ACK perdido, idempotencia, concurrencia y cambios históricos sin ataque nuevo | Pendiente. La prueba del journal C no sustituye al consumidor/emisión de D |
| Contratos y producto | API/MCP real, permisos, budgets, paginación/sync, rutas heredadas y accesibilidad/foco/scroll | C verificada; repetir sólo superficies modificadas por D/E/F y el cierre integrado necesario |
| Dependencias y CI | Instalación desde locks, inventario coherente, checks/build/suites/auditorías pertinentes del candidato final | C con verificaciones definitivas y publicación autorizada por conector; instalaciones operativas y CI/identidad del futuro candidato D/E/F pendientes |
| Rendimiento | Hardware/concurrencia/cohortes declarados; consultas y commits sin recurrencias largas no explicadas | Pendiente sobre operación. Objetivos del diagnóstico: lectura caliente p95≤500 ms, persistencia→alerta p95≤60 s y páginas de escritura orientadas a 250 ms; no son resultados alcanzados |
| Núcleo continuo | Adquisición/mantenimiento sin IA ni navegador, recuperación controlada y observación continua de 24 h del candidato final | Pendiente. v19 tuvo 23 h 54 min y no cierra esta puerta |
| IA semántica | Calidad útil por tarea, evidencia realmente consultada, citas/números válidos, correcciones propagadas y denominadores claros | Pendiente y separada del núcleo. Conservar shadow hasta aceptación específica |

El producto completo no se considera terminado por tener una base sana, suites verdes o un modelo conectado. Su cierre exige D/E/F implementadas, cobertura evaluada y las puertas de núcleo/IA cerradas con evidencia independiente. El estado diario y la siguiente acción permanecen concentrados en ESTADO.md.
