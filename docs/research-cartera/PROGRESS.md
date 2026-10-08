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
