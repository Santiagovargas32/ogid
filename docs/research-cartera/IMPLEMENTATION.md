# Evolución de investigación financiera OGID

Fecha de inicio: 2026-10-08 (Europe/Madrid). Base limpia: main, e26733a40eaced541bb4db206b516869610cc3bd. No se publicará, fusionará ni desplegará. No se modificarán tareas, credenciales o posiciones.

## Paquetes y dependencias

1. **P0** `research/p0-reliability`, base main: identidad de proceso capturada al cargar, calidad, calendarios versionados, velas, caché por contenido, cotizaciones compactas compatibles y filtros semánticos.
2. **P1** `research/p1-data-context`, base P0: histórico acotado reanudable, identidades, técnica reproducible y contratos de eventos/fuentes/holdings oficiales configurables.
3. **P1 seguimiento** `research/p1-scenarios`, base P1 datos: escenarios persistentes, detección y cambios por consumidor sin entrega implícita.
4. **P2** `research/p2-evaluation-mcp`, base P1 seguimiento: evaluación temporal, API/MCP completo, compatibilidad, documentación y runbooks.

Cada paquete tendrá commit local, pruebas y actualización de PROGRESS. Las ramas están apiladas: comparar cada una con su base, no con main. No hay dependencias nuevas previstas.

## Verificación

Comandos reales: `npm --prefix backend run check`, `npm --prefix backend test`, `npm --prefix backend run build`, `npm --prefix integrations/ogid-mcp run check`, `npm --prefix integrations/ogid-mcp run inventory:check`, `npm --prefix integrations/ogid-mcp test`. En este IDE Node está en el host: usar `flatpak-spawn --host` con directorio explícito. El sandbox bwrap falla (namespace no permitido); las acciones locales usan ejecución aprobada fuera de ese aislamiento.

Pruebas offline: correcciones con misma última vela, null/sintético/ajustes, festivos/medias sesiones/DST, bytes y cursores, eventos/revisiones, persistencia/checkpoints y cliente MCP real. Fuentes live opt-in; sus fixtures no se insertan en datos operativos.

## Criterios de estado

IMPLEMENTED = código funcional; TESTED = checks ejecutados; LIVE_VALIDATED = evidencia de acceso real a fuente/runtime concreto; BLOCKED = impedimento externo descrito; DEFERRED = actividad prospectiva o fuera de alcance. Metadata local no es atestación criptográfica. Los tests no acreditan rentabilidad ni cobertura live.

## Hallazgos iniciales

Confirmados: caché por última openTime, horario cash único, cotizaciones con market global, filtros con hash de JSON sin normalización, ATR simple. Ya existente: presupuesto paginado sin avance sobre artículos omitidos, cursores caducados/reinicio explícitos, identidades dinámicas verificadas y perfil MCP stored. Se conservarán y probarán.

P0 finalizado y probado. La lista configurable sigue siendo el registro dinámico existente; no se ha convertido el universo de ejemplo en catálogo de producción. El historial de velas existente no se reescribe automáticamente por los nuevos calendarios: se reconciliará mediante adquisición explícita.

P1 datos añade ledger `RESEARCH_LEDGER_FILE` (default backend/data/intel/research-ledger.json), configuraciones locales opcionales `RESEARCH_SOURCES_FILE` y `RESEARCH_SEC_USER_AGENT`. Todos los adaptadores nuevos están desactivados por defecto. Ver sources.example.json y universe.example.json. La adquisición histórica se activa por operación operador explícita, nunca por consultar técnica o velas. `completed` significa ventanas procesadas; `coverage.goalMet` acredita el número de observaciones válidas disponible, no se garantiza 500 por instrumento.


P1 seguimiento y P2 finalizados: MaterialAlertStore v2, journal firmado por consumidor, escenarios y evaluación prospectiva. Políticas opcionales RESEARCH_SIGNAL_POLICY_FILE; benchmarks no elegidos automáticamente. Contrato API 1.1.0 y MCP 0.3.0; operaciones/cambios en API-CHANGES.md, evidencia y commits en PROGRESS.md. RUNBOOK.md cubre instalación real, permisos, flags, backup, migración v1/v2, rollback sin reset, límites de fuentes y refresh posterior de ChatGPT. No se activó ninguna integración externa o tarea.
