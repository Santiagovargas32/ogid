# Entrega C — cierre de implementación e integración

**Corte histórico fechado.** Los recuentos, instalaciones y procesos de este informe pertenecen a su cierre; el estado posterior del punto 2 se consulta en [ESTADO.md](ESTADO.md). No retomar sus pendientes si ya figuran cerrados allí.


Corte: **26/10/2026**. Rama `feat/agentic-intelligence`, base anterior B `9a3aa2fb4e58b7fd1342f835288b843e1b06e2a9`. Este checkpoint identifica el commit `feat(news): cerrar entrega C de comparación y afirmaciones`. Commit publicado **40a027d21bcf5cb7140a16bbf8649d3c7126dbc4**, [CI 40404890887 correcta](https://github.com/Santiagovargas32/ogid/actions/runs/40404890887). Los detalles de publicación/CI se conservan en el recibo privado `.implementation-evidence/2026-10-26/C-close/publication.json` y se verifican por el conector GitHub; en otro checkout se localiza el commit por ese título.

Identidad del código validado: artifactHash **17aaed71a063a740c091b281071c799a6e5b5133b5b01e88a8e980a37796c0e4**, contrato **1.11.0**, esquema **025**. El hash identifica archivos de runtime, no configuración, instalación, datos ni frontend. El manifiesto privado identifica todos los paths/bytes revisados antes de publicar.

## Aceptación implementada

| Requisito | Resultado comprobado |
|---|---|
| Coberturas relacionadas | Reglas comunes EN/ES/FR/DE/PT por tipo, lugar exacto y contexto temporal; seis horas de ancla; contextos insuficientes conservan publicaciones individuales |
| Fechas y diferencias | Titulares distintos pueden relacionarse; fechas explícitas/días separados y otros lugares permanecen separados en los casos de regresión; opiniones/futuro/negación conservan modalidad |
| Sindicación | Cinco copias mantienen un origen conocido; desconocidos no acreditan independencia ni ocurrencia |
| Afirmaciones | Segmentos de titular/extracto permitido, atribuidos a la publicación, con artículo/revisión/hash exactos; correcciones conservan las anteriores como históricas |
| Apoyo/contradicción | Relaciones atribuidas al revisor con motivo y referencias, vigencia de ambas afirmaciones visible; hints automáticos sólo cubren la página devuelta |
| Merge/split/origen | Auditoría append-only, idempotencia y asignaciones revisadas preservadas; el origen mantiene el ID de su prueba original después de merge/split/correcciones |
| Persistencia | 025 aditiva, checksums previos intactos; cursor histórico transaccional y sin reescritura de revisiones congeladas |
| Transporte | API/MCP reales, permisos de operador y lectores query_only; cursores de corte estable; límites de bytes medidos con frames escapados y páginas vacías |
| Producto | Comparaciones enlazadas desde noticias y navegación; editor/origen pendientes, modalidad y alcance visibles; paginación accesible y foco conservado |

Las agrupaciones son candidatas de cobertura. La extracción v1 no sustituye una evaluación general de todas las proposiciones ni confirma incidentes. C no implementa el consumidor, ACK ni la emisión de D por disponer de un registro de cambios.

## Correcciones de la revisión final

- Todas las variantes de política de sólo titular excluyen el extracto: valor directo, contentPolicy, mode y provenance.contentPolicy.
- La referencia de la prueba de origen se resuelve a la revisión de origen, sin confundirla con una posterior unión/separación.
- El presupuesto considera el frame MCP escapado completo y también los metadatos de una página sin elementos. Las pistas opcionales reservan su espacio.
- Los vínculos de una afirmación se paginan por secuencia con los índices existentes de cada extremo; no se ordena todo el historial antes de limitar referencias.
- El enriquecimiento añade menciones multilingües conservando países ya atribuidos, IDs, fechas y contentRevision. Las revisiones congeladas permanecen intactas.
- Se conserva en este commit el diagnóstico renewalId previamente autorizado en 0.2 y su regresión, sin alterar leases ni publicar argumentos/owner.

## Verificación final

| Control | Resultado |
|---|---|
| Backend completo del candidato final | **1071/1071**, cero fallos/skips |
| MCP completo | **32/32**, incluye stdio real |
| Regresiones dirigidas de cierre | **26/26** C/editorial/B, incluyendo nuevos casos de procedencia, permisos y budgets |
| Build/check/inventario | Correctos; **92 rutas / 101 operaciones** |
| Auditorías runtime backend/MCP | **0 vulnerabilidades** en ambos grafos fijados |
| Base operativa reparada | Lote real de enriquecimiento C con rollback completo: **1 publicación verificada**, IDs/fechas/revisiones congeladas/cursor y recuentos preservados, sin alertas ni publicaciones IA nuevas |
| UI | Evidencia Firefox existente de 390/1280 px, sin overflow, HTML como texto y foco de última página correcto; frontend sin cambios posteriores a esa verificación |
| Higiene | git diff --check, paths explícitos y exclusión de .env/credenciales/DB/logs/modelos/node_modules y evidencias privadas |

Suites en la instalación aislada con dependencias coincidentes y Node 24.22.1; prueba de base real con Node 22.23.3. Evidencia privada en `.implementation-evidence/2026-10-26/C-close/`. Esta pasada completa sustituye como cierre de C a la anterior pasada 1064/1067 y sus repeticiones dirigidas, conservadas como histórico.

## Frontera con la puesta en servicio y las siguientes entregas

El enriquecimiento histórico **no se ejecutó de forma persistente** en este cierre: el piloto hizo rollback. En el corte C, las facetas B y el índice C estaban pendientes de poblar y las instalaciones seguían anteriores a sus locks. El punto 2 posterior alinea instalaciones y completa el histórico; consultar ESTADO.md, sin reutilizar este corte como estado vigente. El backend permanece detenido, la base reparada sigue seleccionada y llama.cpp/shadow se preservan.

Esto mantiene separadas la implementación/integración/publicación de C y las puertas operativas finales. Siguiente lote recomendado: alinear instalaciones en una ventana controlada, pilotar y completar el enriquecimiento por páginas, y comenzar D.1 con datos coherentes. Pruebas de D/E/F progresivas; observación formal de 24 h y promoción semántica al final del candidato correspondiente. Detalle y origen de pendientes en [CIERRE-FINAL.md](CIERRE-FINAL.md); entrada D en [ENTREGA-D.md](ENTREGA-D.md).
