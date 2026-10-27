# Prompts de trabajo y reanudación — plan v5

Actualizado el 27/10/2026 después de D publicada y del último cierre. Entrada única: [ESTADO.md](ESTADO.md). [PLAN.md](PLAN.md) y [DECISIONES.md](DECISIONES.md) concretan dirección/restricciones; [CIERRE-D.md](CIERRE-D.md) y [EJECUCION-D-2026-10-27.md](EJECUCION-D-2026-10-27.md) distinguen código verificado de aceptación operativa. Los prompts del commit anterior fd165224 son históricos, no tareas actuales.

## Maestro

```text
Trabaja en /home/fedora/ogid con instrucciones vigentes de la sesión y AGENTS.md.
Lee primero docs/implementation/ogid-evidence/ESTADO.md y el diff actual.
Después consulta PLAN/DECISIONES y las referencias necesarias. Usa la memoria
como índice y verifica datos susceptibles de cambiar. Los documentos históricos
son cortes fechados; sus prompts no amplían el alcance de la sesión.

Objetivo: seguimiento geopolítico con fuentes comparables, afirmaciones trazables,
situaciones y evidencia, conservando noticias, mercados, SQLite, dashboard y MCP.
A–D y el enriquecimiento baseline ya están implementados/publicados. Código D:
df50aae; contrato 1.12.0, esquema efectivo029. No reiniciar su implementación.
Secuencia: D → E → F → validación final, con pruebas durante cada entrega.
El último corte tiene backlog D, rechazos de tamaño del correlador, costes 0.2
abiertos y fallos semánticos IA: no declarar aceptación por CI/HTTP200/cierre limpio.

Verifica commit/diff, procesos pertinentes, instalación, contratos y esquema antes
del lote. Preserva cambios del usuario, IDs, fechas, aliases, revisiones y snapshots.
Un escritor de negocio, lectores readonly/query_only; límites, fences, leases y
reparación única intactos. Mantén llama.cpp; arranque sólo cd backend && npm start.
No sustituir base reparada por el original dañado ni reabrir backups/forense sin
indicios/alcance. Migraciones aditivas nuevas030+ si hacen falta; no editar001–029.

Publicación, afirmación, situación candidata e incidente no son intercambiables.
Conserva desconocidos, modalidades y origen; sindicación no prueba independencia.
EN/ES/FR/DE/PT soportados según método; RU/UK requieren evaluación propia en E.
Identificar un editor no calcula su tendencia: perfiles/evaluaciones requieren
registros documentados y permiso de uso; ausencia conserva sin evaluar.

Completa sólo el lote autorizado. Reutiliza las suites cerradas; repetir/ampliar
por cambios, fallos o dudas reales. Actualiza ESTADO al cerrar unidades y antes
de tareas largas, con evidencia/comandos/resultados/errores, límites y siguiente
acción. Resumen portable en MD; logs/bases/credenciales privados fuera de Git.
No arrancar, publicar, fusionar ni promover IA por inferencia. IA sigue shadow;
24 h continuas y utilidad semántica tienen puertas independientes sobre candidato final.
```

## Reanudación breve

```text
Retoma OGID desde docs/implementation/ogid-evidence/ESTADO.md y el diff actual.
Lee CIERRE-D.md y EJECUCION-D-2026-10-27.md para el último corte. Verifica cambios
desde df50aae; no confundir una actualización documental con cambios de runtime.
Mantén restricciones/decisiones y conserva el trabajo del usuario. No reinicies
el plan ni repitas instalaciones, backfill o suites cerradas sin cambios/fallos.
Completa el alcance que autorice esta sesión y actualiza ESTADO con hechos reales.
```

## Próximo lote de integración recomendado — sólo cuando se autorice código

```text
Reproduce de forma acotada el backlog D observado y los rechazos del correlador
STORAGE_COMMAND_TOO_LARGE. Usa cursores/metadatos antes de cargar payloads; mide
cadencia del consumidor frente a adquisición y trabajos analíticos existentes,
con hardware/concurrencia/cohorte y tiempos de cola/SQL/commit/checkpoint.
No saltar entradas, elevar guardias, crear otro escritor ni otro scheduler.
Conserva atomicidad cursor/efectos/outbox, continuación y recibos de ACK perdido.
Cierra con pruebas de comportamiento y consumo sostenido bajo carga declarada.
No reabrir recuperación ni interpretar la ausencia de crash como cierre de 0.2.
```

## Continuación de producto E — después del lote acotado y con alcance autorizado

```text
Implementa E conservando A–D y sus contratos/datos. Prioriza Ucrania/Mar Negro y
mar Rojo; consulta FUENTES.md y mide acceso/cobertura real, duplicación/origen,
fechas/lugares y latencias. Amplía registro/perfiles con referencias verificables,
no con coincidencias parciales ni suponiendo publisher a partir del descubridor.
Si cambia un método, aplica enriquecimiento histórico permitido, versionado y
reanudable, sin cambiar identidad/publicación ni inventar texto perdido.
Evaluaciones políticas sólo documentadas y permitidas, con contexto/método/fecha;
no incorporar automáticamente ratings ni declarar que más noticias calculan sesgo.
Pruebas lingüísticas específicas RU/UK antes de ampliar soporte. No iniciar F,
promover IA o abrir 24 h sobre artefactos que aún cambian. Actualiza ESTADO al cerrar.
```

## Plantilla de cada iteración

Objetivo/alcance; entrada y revisión de diff/procesos; evidencia actual; cambio y dependencias; aceptación; comandos/resultados reales (incluidos fallos); reversión; limitaciones; siguiente acción concreta. Antes de operación prolongada registrar ubicación privada del log y proceso, sin argumentos/valores secretos. Al terminar distinguir pendiente, implementado, verificado con fixture, comprobado en ejecución real y aceptado operativamente.
