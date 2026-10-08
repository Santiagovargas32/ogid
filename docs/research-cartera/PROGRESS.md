# Progreso

## Estado inicial

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
