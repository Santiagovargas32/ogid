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
C requiere alcance propio; la operación 0 continúa condicionada a copia
consistente actual y autorización de puesta en servicio. Nunca presentar
fixtures, CI o etiquetas sin dataset como cobertura real o aceptación de 24 h.
