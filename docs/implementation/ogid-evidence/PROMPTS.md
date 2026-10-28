# Prompts de trabajo y reanudación — plan v6

Actualizado **28/10/2026**, con código 124050a y revisión D2/D3. Entrada: [ESTADO.md](ESTADO.md); resumen autónomo [RESUMEN-ACTUAL-2026-10-28.md](RESUMEN-ACTUAL-2026-10-28.md). [PLAN.md](PLAN.md), [DECISIONES.md](DECISIONES.md) y [CIERRE-FINAL.md](CIERRE-FINAL.md) mantienen dirección/restricciones. Los prompts son referencias; sólo se ejecuta el alcance autorizado en la sesión.

## Maestro

```text
Trabaja en /home/fedora/ogid siguiendo la sesión y AGENTS.md.
Lee ESTADO.md, el diff y RESUMEN-ACTUAL-2026-10-28.md; después las referencias
necesarias de PLAN/DECISIONES/CIERRE-D/CIERRE-FINAL. Usa memoria como índice,
verifica cambios desde el checkpoint y conserva trabajo del usuario.

Objetivo: situaciones, afirmaciones y evidencias trazables, conservando noticias,
mercados, SQLite, dashboard y MCP. A–D implementadas; código de cierre 124050a,
contrato 1.12.0, 98 rutas / 107 operaciones, esquema 029. Secuencia D → E → F → final.
D3 puso news al día bajo adquisición; tras el cierre news 240462/240462 y
awareness 3813/3813. El rechazo de tamaño del correlador no se reproduce en D2/D3.
No empezar de nuevo esas correcciones ni el enriquecimiento baseline ya cerrado.

La ejecución extendida D3 terminó por espera de E/S en commit/Btrfs, con dos fases
de persistencia sin confirmar. Hubo 12 eventos de persistencia de mercado con timeout
de cola y un intento IA sin cerrar, lease vencido. Causa física exacta no demostrada;
no inferir nuevo checksum corrupto ni OOM. STORAGE_NOT_READY es consecuencia.
E/F, estabilidad/reanudación, integración final y 24 h siguen pendientes.

Verifica commit/diff, procesos, instalaciones, contrato y esquema antes del lote.
Un escritor de negocio, lectores readonly/query_only, FULL, límites, fences, leases,
validación y reparación única intactos. Preserva IDs, fechas, aliases, revisiones y
snapshots. Mantén llama.cpp; arranque sólo cd backend && npm start, hijos por .env.
No reabrir copias/forense ni sustituir la base reparada por la original dañada.
Migraciones nuevas 030+ si hacen falta; no editar 001–029.

Distingue publicación, afirmación, situación candidata e incidente. Desconocidos y
modalidad permanecen explícitos; sindicación no demuestra independencia.
EN/ES/FR/DE/PT actuales; RU/UK con evaluación propia en E. Identidad del editor no
calcula tendencia: perfiles/evaluaciones requieren datos documentados y permisos.

Completa sólo el lote autorizado. Pruebas proporcionales; no repetir suites,
instalaciones o backfill cerrados sin cambios/fallos/dudas reales. Reconciliar
resultados inciertos mediante recibos/fences antes de reintentar. No declarar
recuperación por un mero arranque ni estabilidad por CI/HTTP 200/backlog cero.
Actualiza ESTADO por unidad verificable y antes de tareas largas salvo instrucción
contraria de la sesión; detalla evidencias, errores, límites y siguiente acción.
Logs, bases, credenciales y artefactos privados fuera de Git; publicar por conector.
No arrancar, desplegar, fusionar ni promover por inferencia. IA shadow; 24 h del
candidato final y utilidad semántica por tarea son puertas separadas.
```

## Reanudación breve

```text
Retoma OGID leyendo ESTADO.md, RESUMEN-ACTUAL-2026-10-28.md y diff actual.
Contrasta cambios desde 124050a y el commit documental posterior. D3 drenó backlog,
pero acabó con fallo de E/S y persistencia sin confirmar. Reutiliza los cierres;
no reinicies A–D, instalación ni baseline. Conserva restricciones y cambios ajenos.
Ejecuta sólo el alcance autorizado en esta sesión y registra resultados reales.
```

## Próximo lote recomendado — requiere autorización de código/operación

```text
Acota D/0.2 usando la revisión D3. Contrasta presión de app, commits/checkpoints y
esperas de E/S del host; identifica trabajo repetido y reduce escrituras o cálculos
redundantes mediante coordinación existente. Conserva cobertura, FULL, límites,
escritor único y semántica. No tratar btrfs_sync_log como diagnóstico físico final.
Atiende los 12 fallos de cola de observaciones de mercado y la persistencia incierta;
no mezclar estos registros append-only con snapshots reemplazables.
Reproduce cambios con pruebas de comportamiento y mide la carga pertinente.
Con alcance operativo explícito, verifica reanudación de RSS, recibos y owner/fence,
lease vencido, intento sin cerrar, cursor/efectos/outbox y cierre ordenado.
No ejecutar replay ciego ni inferir que todo estaba confirmado por backlog cero.
Cierra con evidencia y condición concreta para continuar E; no exigir 24 h formales
antes de cada entrega ni iniciar E/F por la sola presencia de este prompt.
```

## Continuación E — con alcance autorizado tras el lote acotado

```text
Implementa E conservando A–D y contratos/datos. Prioriza Ucrania/mar Negro y mar
Rojo; consulta FUENTES.md. Mide configurado, habilitado, consultado con éxito y sano,
acceso, cadencia, fechas, lugares, origen, duplicación y latencia. No inferir salud por
existir en el catálogo ni noticia reciente por haberse recibido ahora.
Amplía identidades/perfiles con referencias; texto sólo permitido. Un método nuevo
puede enriquecer históricos por páginas/versiones sin cambiar identidad/publicación
ni inventar contenido. Ratings sólo documentados y permitidos; adquirir más noticias
no calcula sesgo. Evalúa RU/UK antes de ampliar soporte. Mantén IA shadow y
probabilidades null sin modelo evaluado; no iniciar F/promoción por inferencia.
```

## Plantilla de iteración

Objetivo/alcance; commit/diff/procesos; entradas y evidencia; hipótesis/cambio/dependencias; aceptación; comandos/resultados/errores; reversión; límites; siguiente acción. Distinguir implementado, probado con fixture, comprobado en ejecución real y aceptado operativamente. Mantener cohortes observador/backend/base/IA separadas.
