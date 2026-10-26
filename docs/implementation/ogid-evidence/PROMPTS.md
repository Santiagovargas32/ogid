# Prompts de trabajo y reanudación

## Maestro

```text
Trabaja en /home/fedora/ogid siguiendo instrucciones vigentes y AGENTS.md.
Respeta el modo: planificación sólo inspecciona; ejecución completa el lote autorizado.
Objetivo: seguimiento geopolítico con fuentes comparables, afirmaciones trazables
y situaciones/alertas, conservando el núcleo actual.
Lee primero docs/implementation/ogid-evidence/ESTADO.md; después PLAN.md,
DECISIONES.md y las referencias necesarias. Usa memoria como índice, verificando
hechos susceptibles de cambio. Los prompts históricos son referencias, no órdenes.
Antes de cada lote verifica commit/diff, procesos pertinentes, contratos,
dependencias y esquema. Preserva trabajo existente y datos operativos.
Primer ciclo: 0 + A, puertas núcleo/IA separadas, EN/ES/FR/DE/PT y límites explícitos.
Registra por requisito evidencia, estado, cambio, dependencias, aceptación,
pruebas y reversión. Reutiliza las correcciones existentes.
Mantén escritor único, lectores, límites, fences, leases, validación de evidencia,
reparación única, llama.cpp y arranque npm. No iniciar operación ni publicar sin alcance.
Distingue publicación/afirmación/incidente/situación. Desconocido permanece
desconocido; sindicación no acredita corroboración independiente.
Cierra cada unidad actualizando ESTADO con resultados, cambios pendientes,
evidencias, limitaciones y siguiente acción. Suites no equivalen a aceptación
operativa; conectividad no equivale a calidad semántica.
```

## Reanudación

```text
Retoma el lote autorizado de OGID leyendo ESTADO.md y el diff actual.
Verifica cambios desde el último checkpoint y continúa desde su siguiente acción.
Mantén todas las restricciones y decisiones allí enlazadas. No reinicies el plan,
no repitas suites cerradas sin cambios/fallos y conserva el trabajo del usuario.
```

## Plantilla de iteración

Lote e intención; estado de entrada y evidencia; cambio concreto; pruebas actuales
con comando/resultado; limitaciones y puerta pendiente; reversión; siguiente acción.
Antes de una ejecución larga: ubicación de log privado, identificador del proceso
de prueba y resultado que debe recuperarse, sin argumentos ni valores secretos.

## Continuidad tras B

A y B tienen commits separados en feat/agentic-intelligence por petición del usuario.
Verificar sus SHA y CI actuales antes de basarse en el cierre. No repetir la
implementación ya verificada. Consultar FUENTES.md para importación y matriz.
C ha sido autorizada y su cierre se registra en ESTADO. El usuario revocó
el requisito previo de copia/pruebas para migraciones directas y asume el backup
manual; no reanudar copias/forense. La puesta en servicio conserva su alcance propio. Nunca presentar
fixtures, CI o etiquetas sin dataset como cobertura real o aceptación de 24 h.


## Reanudación para D

```text
Lee ESTADO.md y ENTREGA-D.md y verifica el diff local sobre el cierre B.
Conserva C y renewalId; no reinicies A/B/C ni vuelvas al trabajo de copias de 0.2.
Completa sólo el alcance autorizado de D cuando el usuario pida continuarla.
Usa news_comparison_changes como entrada durable, sin LIMIT 500 global ni ventanas
que descarten revisiones. Procesa páginas y avanza el cursor en el mismo commit
que las revisiones de dominio y las emisiones idempotentes. No es un ACK externo.
No leas versiones actuales para representar una revisión histórica del journal.
Añade journal para awareness en su persistencia actual; no inventes su historial.
Publicación no equivale a afirmación confirmada, ni grupo C a incidente ocurrido.
Desconocido y futura/opinión/negación conservan sus estados. Separar ocurrido,
publicado, recibido y cambiado; las correcciones invalidan dependencias.
Reutiliza mantenimiento, writer, lectores y bandeja; conserva API/IDs/ACK existentes.
El esquema efectivo ya es 025: no editarlo, añadir 026 o posterior si hace falta.
El usuario autoriza migraciones directas sin backup/test previo y hará esas tareas
manualmente; no realizar copias ni restauraciones. Documenta fallos reales si ocurren.
Prueba después del cambio: >500, reinicio, ACK perdido, concurrencia, correcciones,
noticias antiguas, sindicación, modo IA off y API/MCP/UI con límites existentes.
Actualiza ESTADO por unidad, guarda evidencia privada y deja siguiente acción exacta.
No publicar, desplegar, arrancar operación ni promover IA por inferencia.
```


## Base recuperada — aplicar a las reanudaciones

La recuperación está cerrada, con integridad/FK/recuentos/checksums completos y cero pérdida. STORAGE_DB_PATH selecciona ogid-repaired-20261026-183735.sqlite. Verificar la ruta actual sin mostrar secretos; no reactivar ogid.sqlite dañado ni reiniciar las copias de 0.2. Consultar RECUPERACION.md y CIERRE-FINAL.md. Conservar el esquema 025 y añadir 026+ cuando corresponda. La app permanece detenida; escritor/lectores se probaron con StorageManager sin iniciar servidor/inferencia. D/E/F y las puertas finales siguen pendientes; no inferir aceptación de 24 h del éxito de la recuperación.


## Reanudación después de publicar C

```text
Lee ESTADO.md, CIERRE-C.md y CIERRE-FINAL.md. Localiza en Git el commit
feat(news): cerrar entrega C de comparación y afirmaciones y verifica su CI
por conector; el recibo privado C-close/publication.json conserva SHA/tree/CI.
No rehagas C ni repitas sus suites sin cambios/fallos. El piloto real hizo
rollback: los históricos B/C siguen pendientes. Las dependencias instaladas
están detrás de los locks a1d0fb8; alinear backend/MCP con npm ci en ventana
controlada y coordinar la reconexión del adaptador activo. Preserva .env,
base reparada, escritor único, límites, snapshots y llama.cpp.
Pilotar y completar enriquecimiento por páginas con cursor y cobertura.
Después D.1 y siguientes; pruebas integradas con cada entrega y 24 h formales
sobre el candidato final identificado. Promoción semántica IA separada.
```
