# Estado de entrega — 2026-10-08

P0 → P1 datos → P1 seguimiento → P2 implementados y probados localmente. Sin push, PR remoto, merge en main ni despliegue. Sin cambios de tareas/chats, credenciales, costes o posiciones. Rama final `research/p2-evaluation-mcp`.

[Contratos y cambios](API-CHANGES.md) · [Activación, migración, rollback y ChatGPT](RUNBOOK.md) · [Paquetes y decisiones](IMPLEMENTATION.md).

## Estado inicial (registro histórico)

- Base: e26733a, main limpio. Instrucciones AGENTS proporcionadas en la sesión; no hay AGENTS.md adicional en el checkout.
- Rama activa: research/p0-reliability.
- P0: en curso. P1/P2: pendientes.
- Runtime/producción: no inspeccionado ni alterado. Health histórico no reutilizado como comprobación actual.
- Entorno: dependencias presentes; Node v22.23.3 y npm en host vía flatpak-spawn. Ejecución sandbox bloqueada por bwrap; lectura aprobada fuera del aislamiento disponible.
- Siguiente acción: implementar y verificar P0, registrar commit/base y continuar P1.

## P0 — IMPLEMENTED / TESTED

- Rama `research/p0-reliability`, base e26733a. Metadata de backend/adaptador capturada al importar con hash SHA256 de fuentes; commit checkout y build declarado separados, runningCommitVerified=false.
- Calendarios versionados de sesiones cash: US/Xetra/Ámsterdam/Milán, festivos recurrentes, cierres US a 13:00, DST y fases verificadas por mercado. Referencias oficiales en exchangeCalendar.js. Fuera de 2026 se declaran reglas parciales; media sesión XAMS pendiente de hora oficial se bloquea explícitamente. FX/futuros conservan limitaciones existentes.
- Caché acotada con hash de toda la serie/parametrización/calidad/calendario; solo velas cerradas. Null/sintéticos rechazados, huecos diarios según sesiones. Proyección compacta MCP; API legacy mantiene default. Semanal/mensual retirados del anuncio MCP hasta soporte completo.
- Filtros normalizados por conjuntos/defaults/fechas/orden estable. Snapshots aislados de llegadas concurrentes, continuación solo cursor, expiración/reinicio explícitos. Se conserva presupuesto sin omitir artículos.
- Verificación: check backend PASS; 548/548 tests backend PASS; inventario PASS; 21/21 tests MCP PASS; diff --check PASS. Regresiones nuevas cubren corrección con última hora igual, null, sintéticos, filtros equivalentes, reinicio, festivo/media sesión/DST/europeos y proyección compacta. Dos fixtures actualizados: fecha sábado sustituida por sesión real e identificación MIC de SPY.
- Dependencias nuevas: ninguna. LIVE_VALIDATED: solo documentación oficial consultada; no runtime o proveedor financiero operativo validado.
- Siguiente: P1 histórico/contexto sobre commit P0; no despliegue.

## P1 datos/contexto — IMPLEMENTED / TESTED

- Rama `research/p1-data-context`, base P0 f71e4c0. Commit P0 creado con identidad de agente Codex <codex@localhost>, solo mediante opciones del comando; configuración Git intacta.
- Research ledger con transacciones atómicas, fallo cerrado ante corrupción/capacidad. Jobs dedicados Yahoo: objetivo 500 (30–2500), hasta 20 identidades, ventanas solapadas de hasta 181 días, 1–4 solicitudes por run, persistencia antes de HTTP, reanudación/backoff/errores sin avanzar. El backfill legacy conserva su límite para compatibilidad. Cobertura real independiente del estado completed del job.
- Contexto `standard-v1`: SMA20/50/200 con pendientes/distancias, RSI/MACD/Bollinger, ATR simple legacy y Wilder explícitos, volatilidad/unidad/annualización, benchmark de cierres exactos, volumen por franjas, niveles anteriores sin futuro y VWAP aproximado. Semanal derivado de sesiones diarias cerradas; meses no anunciados. Warmup, revisión completa y N/D explícitos.
- Entidad versionada separada de instrumento, CIK único por companyId, relaciones/clase/mercado configurables. Sin CIK/ISIN inventados. Universo de estudio solo en archivo example, sin posiciones ni elección ETF implícita.
- Ledger de eventos durable, claim/event IDs, evidencias/orígenes/revisiones/fechas separadas, rumor/confirmación, sorpresa comparable y mecanismo económico desconocido/mixto. Hooks en archivo y Awareness públicos; sin proveedores en lecturas.
- SEC submissions/companyfacts y RSS oficial/IR/regulación/defensa configurables por fuente local admitida; cooldown, timeout, bytes y frecuencia acotados. Holdings JSON normalizados del emisor requieren ISIN/mercado/fecha y pesos. No es scraper universal de sitios de emisores. Fuentes pendientes sin configuración verificable o acceso live. Macro reutiliza fuentes Awareness existentes.
- adjClose Yahoo conservado separado si el proveedor lo ofrece; no se acredita retorno total. Revisiones de OHLCV auditadas (20 versiones por vela). Reconciliación independiente sin segunda fuente permanece no disponible.
- Verificación: 43/43 tests focalizados backend PASS; check backend PASS; inventario PASS; 21/21 MCP PASS. No nuevas dependencias, credenciales, servicios ni tareas.
- Siguiente: escenarios/señales persistentes y checkpoints por consumidor sobre este paquete.

## P1 escenarios/seguimiento — IMPLEMENTED / TESTED

- Rama `research/p1-scenarios`, base P1 datos 71f2ca0. MaterialAlertStore migra v1→v2 de forma aditiva; restaura escenarios, señales, secuencia, firma de cursores y consumidores. Archivo privado 600, límite de 32 MiB; research ledger 64 MiB. Un solo escritor por proceso.
- Escenarios favorable/central/adverso con niveles anclados, contexto/evidencia/horizonte/confirmación/invalidación/vencimiento y estados especificados. Confirmación solo acredita condición observada. Correcciones de la misma vela pueden revisar incluso invalidaciones, con historial auditado. No objetivos/probabilidades inventados.
- Anomalías de retorno/gap/volumen y candidatos de eventos con evidencia. Umbrales versionados, histéresis y cooldown. Causa del movimiento desconocida; canales económicos no establecen causalidad ni beneficio.
- Journal duradero con tombstones, snapshots acotados, cursores por consumidor, presupuesto de bytes sin avanzar sobre registros omitidos, retención/cambio de historia explícitos. Lecturas no reconocen ni avanzan. Reconocimiento de procesamiento operador con comparación de secuencia; recuperación de huecos explícita. No se reconoce entrega sin recibo: deliveryVerified=false y deliveredAt=null. Reconocimiento filtrado rechazado para no saltar activos.
- portfolio.context añade resumen de escenarios; mantiene contratos legacy, alertas observadas y módulos existentes.
- Checks: 19/19 pruebas focalizadas PASS (transiciones, correcciones, reinicio, cursores, expiración, huecos, bytes, compatibilidad archivo/API); check backend PASS; inventario PASS; 21/21 MCP PASS. No live financiero ni notificaciones externas.
- Siguiente: P2 evaluación temporal, aliases heurísticos, cliente MCP real para nuevas operaciones y validación completa/documentación de activación.

## P2 evaluación/MCP — IMPLEMENTED / TESTED

- Rama `research/p2-evaluation-mcp`, base P1 escenarios 819a4ef. Evaluación prospectiva por registro explícito: objetivo/horizonte/modelo/disponibilidad, idempotencia/duplicados, precio cerrado disponible y actualizado, evidencia previa y origen inmutable por hash. Correcciones de origen/benchmark requieren revisión. Evaluar no registra pronósticos ni consulta proveedores.
- Particiones walk-forward cronológicas con purga de horizontes/disponibilidad solapados; comparadores cero/siempre-up/benchmark, precisión/falsos positivos/cobertura/duplicados rechazados/por evento/retorno relativo/MAE. Costes declarados y retorno neto N/D cuando faltan. Entrada proxy al último cierre diario, no cotización ejecutable ni P&L de una estrategia. Brier/calibración solo para probabilidades de modelo explícitas; confidence no se convierte. Muestra por defecto <30 => insufficient-evaluation; no entrenamiento o piloto financiero acreditado.
- Aliases confidence/predictedConfidence compatibles y etiquetados heuristic-signal-strength; sin rendimiento cero para dato ausente, seeded/sintético/stale excluidos de momentum. Defensa requiere entidad o tema de presupuesto/procurement/contrato; titular negativo/guerra no acredita beneficio.
- Contrato 1.1.0; MCP 0.3.0. 62 rutas / 71 operaciones: 44 research, 27 operator. Diez herramientas research conservadas, nuevos esquemas y errores explícitos. Holdings paginados con snapshotId/offset; stored sin proveedores. Perfiles/scopes verificados en servidor y adaptador. Ninguna dependencia nueva.
- Integración final: identidades configuradas cargan antes de restaurar watchlist; caché incluye metadata de instrumento; huecos cash entre sesiones y 24x7 cruzando medianoche; semanas 24x7 completas de siete días y anomalías que excluyen velas abiertas; vela final intradía recortada al cierre; antigüedad semanal comprobada. Configuración local opcional RESEARCH_SIGNAL_POLICY_FILE, anomalía relativa solo con benchmark verificado.
- Capacidad/error del ledger no interrumpe noticias/mercado/WebSocket; estado blocked/partial y pendingReplay público saneado. Noticias se conservan; no hay replay completo automático ni se acredita continuidad al reiniciar. Retención y capacidad requieren mantenimiento explícito, un solo escritor.
- Verificación final: **563/563 backend PASS**, **21/21 MCP PASS**; backend check/build (incluye frontend/js) PASS; MCP check PASS; inventory:check PASS; npm audit --omit=dev --audit-level=high PASS, 0 vulnerabilidades; git diff --check PASS. Export de rollback v2→v1 leído por el lector original e26733a PASS, sin modificar datos operativos. Pruebas focalizadas adicionales de rutas/pipeline pasan sobre el último ajuste.
- MCP real contra backend real de pruebas: técnica N/D, eventos, tres escenarios pending-data, delta repetible sin ack, holdings ausentes explícitos, evaluación insuficiente, error de job conservado; cotización única ≤4096 bytes incluso con precio disponible y 10 000 puntos por instrumento en estructuras globales. Conexión operador fixture privada verifica refresh idempotente, checkpoint de procesamiento, deliveryVerified=false y rechazo de forecast sin precios. No es validación de producción ni llamadas a fuentes financieras live.
- Compatibilidad: suite completa y sintaxis de frontend; sin rediseño o compilador frontend separado. No se realizó validación visual en navegador. Se mantienen HTTP legacy, WebSocket, noticias/mapas/Awareness/IA y herramientas anteriores.
- Documentación: API-CHANGES, RUNBOOK, inventario generado, ejemplos de universo/fuentes, README y scopes operador actualizados. El lector v1 antiguo no acepta alertas v2: rollback usa copia previa o conversión a otro archivo, preservando evidencia v2.

## Ramas y commits locales

| Paquete | Rama | Base | Commit de implementación |
| --- | --- | --- | --- |
| P0 | research/p0-reliability | e26733a | f71e4c0 |
| P1 datos/contexto | research/p1-data-context | f71e4c0 | 71f2ca0 |
| P1 escenarios | research/p1-scenarios | 71f2ca0 | 819a4ef |
| P2 evaluación/MCP | research/p2-evaluation-mcp | 819a4ef | b76e561 |

Las ramas son apiladas; cada base es el paquete previo. Main permanece e26733a. Los refinamientos de integración y la documentación final pertenecen a P2. Identidad de commit aplicada por comando, sin cambiar Git config. P2 de implementación: b76e561e74d39f494c246446f1dccb6004e6bd3a; el commit documental posterior registra este cierre. Checkout limpio comprobado tras el cierre; sin publicación remota.

## Estado de integraciones y trabajo posterior

| Ámbito | Estado | Evidencia / siguiente paso |
| --- | --- | --- |
| Fiabilidad, técnica, histórico, eventos, escenarios, delta, evaluación, API/MCP | IMPLEMENTED / TESTED | Código y pruebas offline; fuentes simuladas solo en tests, nunca importadas a datos operativos |
| Documentación SEC/bolsas/OpenAI | Consultada | Enlaces oficiales actuales en RUNBOOK; no equivale a LIVE_VALIDATED financiero |
| SEC/IR/macro/regulación/defensa específicos | BLOCKED para cobertura operativa | Faltan configuración admitida/identidades/contacto y lectura real por fuente. Adaptadores acotados funcionales con fixtures. Macro reutiliza Awareness; RSS oficial configurable, no extracción general de PDF |
| UCITS: clase/ISIN/MIC y holdings del emisor | BLOCKED para cobertura operativa | No hay elección verificada del usuario ni datos del emisor validados. Adaptador JSON fechado y paginación probados; CSV/HTML específicos pendientes |
| Segundo proveedor, FX y total return | BLOCKED / no disponibles | Sin fuente independiente; Yahoo web-delayed, adjClose separado no acredita retorno total ni conversión FX |
| Calendarios históricos/excepcionales y XAMS fin de año | Parcial explícito | 2026 versionado; reglas recurrentes otros años. Hora de media sesión XAMS pendiente, sin inferencia de vela |
| Fuentes financieras nuevas / histórico real / runtime objetivo | LIVE_VALIDATED: ninguno | No se usan health histórico ni fixtures como evidencia live. Activación y smoke opt-in posteriores |
| Piloto prospectivo y calibración/rentabilidad | DEFERRED | Reunir registros previos al resultado durante el horizonte necesario; no fabricar muestras retrospectivas |
| Deploy, refresh del plugin y tareas ChatGPT | DEFERRED / fuera de ejecución autorizada | Procedimiento preparado, sin acciones de producción ni modificación de tareas |
| Recibo durable ChatGPT / notificaciones | No disponible | Checkpoint de procesamiento solamente; no outbox ni delivery ficticio |

Siguiente acción fuera de esta entrega: revisar los cuatro diffs apilados, elegir/verificar identidades y fuentes locales, y autorizar posteriormente la activación con respaldo/migración. La implementación independiente autorizada queda completada; los bloqueos externos no se marcan como integraciones operativas.
