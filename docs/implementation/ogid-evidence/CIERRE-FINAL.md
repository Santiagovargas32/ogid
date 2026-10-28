# Estado del producto y condiciones de entrega final

Actualizado **28/10/2026**, con ajuste de código 124050a y revisión D2/D3. Entrada: [ESTADO.md](ESTADO.md); resumen autónomo [RESUMEN-ACTUAL-2026-10-28.md](RESUMEN-ACTUAL-2026-10-28.md). Implementación en [CIERRE-D.md](CIERRE-D.md); EJECUCION-D-2026-10-27 conserva PID 988930 como histórico. Este documento organiza pendientes; no declara el producto completo ni autoriza ejecutarlos por sí solo.

## Estado alcanzado

Código **124050a**, posterior a D inicial df50aae y mantenimiento/correlador 4bf31a6/c5c1ea0; contrato **1.12.0**, esquema **029**. A–D integradas. Recuperación exacta, instalaciones y enriquecimiento baseline cerrados. Backend/UI/MCP probados previamente con npm start/base reparada; último backend D3 detenido **con fallo de escritor y dos fases de persistencia sin confirmar**. No reutilizar el cierre limpio de PID 988930 como si fuera D3.

**Puesta al día D comprobada, estabilidad pendiente:** D3 drenó 30.533 secuencias news durante adquisición; corte posterior news 240462/240462, awareness 3813/3813. Correlador sin rechazo de tamaño en D2/D3 y señales persistidas. Permanecen espera de E/S en commit/Btrfs, 12 eventos de persistencia de mercado con timeout de cola y reanudación real pendiente. El observador completó una hora / 61 muestras; el backend continuó unas 23 h 16 min y acabó con error. No satisface 24 h ni promoción IA: 34 intentos completed, 160 failed, 2 incomplete y 1 sin cierre, sin revisión semántica.

## Entregas frente al diagnóstico

| Entrega | Implementado/verificado | Pendiente real |
|---|---|---|
| 0 · Base operativa | Identidad de artefactos/instalación/contrato/esquema, escritor único, mantenimiento determinista y recuperación; dependencias alineadas | **0.2:** E/S/confirmación, persistencia de mercado, recuperación tras D3 y aceptación operativa; no reabrir backups/forense sin indicios nuevos |
| A · Identidad/clasificación | 9cbdef2, EN/ES/FR/DE/PT, aliases exactos, modalidades, orden y revisiones; baseline histórico completado | Ampliar identidades/texto permitido en E y evaluar por idioma/casos; unknown/unsupported no son severidad baja |
| B · Fuentes/cobertura | 9a3aa2f, evaluaciones/perfiles versionados, importador, medidor y facetas; UI real verificada | Datos documentados y permitidos: **0 evaluaciones / 0 perfiles** en el corte del 27/10, no recalculado en D3. La adquisición no los calcula automáticamente. Medir salud/cobertura real con E |
| C · Comparaciones/afirmaciones | 40a027d, agrupación candidata, revisión merge/split/origen y afirmaciones exactas; índice histórico poblado | Evaluación editorial ampliada; ni grupo ni sindicación acreditan independencia/ocurrencia |
| D · Situaciones/motor | **df50aae**, consumidores/outbox/awareness, situaciones/incidentes, cortes/correcciones/ACK, API/MCP/UI; >500/reinicio/ACK perdido probados | **Consumo bajo adquisición acreditado en D3**; cerrar E/S, reanudación y estabilidad sin perder historia. No está pendiente desarrollar otra vez D |
| E · Piloto/fuentes | Matriz y ámbitos Ucrania/Mar Negro y mar Rojo definidos | Registro/perfiles/enriquecimiento permitido y accesos verificables; medir fechas/lugares, duplicación, origen, cobertura y latencia. RU/UK con evaluación propia |
| F · Analista/impactos | Runtime/modelo y módulos analíticos previos disponibles en shadow | Integrar síntesis/cronologías/impactos sobre situaciones/evidencia elegible; correcciones y números/citas trazables; evaluar por tarea |
| Final | Suites/CI anteriores, smoke y observación corta; D3 extendida terminó con fallo | Candidato final identificado, contratos/UI/rendimiento integrados y **24 h continuas**, más puerta semántica IA independiente |

## Orden de trabajo y criterios de cierre

Secuencia confirmada: **D → E → F → validación final**, con pruebas por entrega. La integración D/0.2 observada se atiende dentro de la continuación, sin reiniciar entregas ni hacer otra recuperación.

1. **D/0.2 focalizado en E/S/persistencia/reanudación:** correlacionar app, cola, SQL, commits, checkpoints y esperas del host. Reducir trabajo repetido con coordinación existente, conservando cobertura, FULL, guardias y escritor único. Verificar las observaciones de mercado fallidas, fases sin confirmar, RSS y lease/intento pendiente mediante recibos/fences; probar reanudación/cierre real cuando se autorice. No repetir backlog/tamaño como defectos actuales ni dar por física una causa no identificada. D3 ya aporta la reproducción; pruebas y carga proporcionales a la corrección.
2. **E:** nutrir identidades y perfiles documentados, aplicar nuevos métodos versionados a históricos mediante páginas cuando proceda y ejecutar los dos pilotos. Cualquier incorporación de evaluaciones conserva metodología/contexto/referencias y permiso de uso; sin dataset, «sin evaluar» sigue válido. El análisis político automático no está implementado ni queda autorizado por tener más noticias.
3. **F:** síntesis, cronologías e impactos con incertidumbre/citas exactas y correcciones propagadas. Revisar fallos de número/evidencia/formato/lease; mantener reparación única. Toda probabilidad requiere modelo evaluado; no confundir atribución con hecho.
4. **Pruebas integradas y puertas finales:** comprobar superficies cambiadas durante cada lote. Al terminar código, fijar identidad de candidato/instalaciones/esquema/contratos y observar 24 h continuas sin cambiar sus artefactos. Conservar shadow hasta aceptación semántica por tarea; v19/D interrumpidas y D3 (una hora de observador, backend extendido con fallo) no cierran esta puerta.

No repetir suites completas, npm ci, enriquecimiento ni controles de recuperación ya cerrados salvo cambios/fallos o dudas justificadas. Editar MD sólo exige coherencia/enlaces/inventarios, no otra suite de backend ni reiniciar la app.

## Dependencias e históricos: lo cerrado y su procedencia

Las 8+1 discrepancias iniciales procedían de locks publicados durante un shadow activo, conservando entonces instalaciones antiguas. No eran nueve dependencias añadidas por C. El commit **fd1652247892483e332148d9428d709318706ad2** cerró ese lote con instalaciones verificadas y enriquecimiento de **146.475** noticias. La recuperación y los checkpoints completos anteriores se conservan en HISTORICO-CONTINUIDAD/RECUPERACION y en Git; no volver a tratarlos como pendientes.

| Instalación | Paquete | Desfase inicial | Primera corrección del26/10 |
|---|---|---|---|
| Backend | body-parser | 2.3.0 | 2.4.0 |
| Backend | body-parser/content-type | 2.0.0 | 2.1.0 |
| Backend | fast-uri | 3.1.8 | 3.1.9 |
| Backend | ip-address | 10.7.3 | 10.7.5 |
| Backend | iconv-lite | 0.7.2 | 0.7.3 |
| Backend | qs | 6.16.0 | 6.16.1 |
| Backend | undici | 7.30.0 | 7.30.1 |
| Backend | zod | 4.5.4 | 4.6.7 |
| MCP | zod | 4.6.5 | 4.6.7 |

Esa tabla es histórica, no todo el grafo posterior. Las versiones directas finales siguen fijadas en package/lock: Express 5.3.0, Helmet 8.3.0, ws 8.22.0, Yahoo Finance 4.0.5 y SDK MCP 2.4.0; Zod 4.6.7 y dotenv 16.6.1. Manifiesto de arranque D: matched / 0 discrepancias; CI D pasó ambas auditorías runtime. Las auditorías sin vulnerabilidades son resultados fechados, no garantía permanente. No forzar downgrades ni adoptar cambios mayores sin necesidad y verificación funcional.

El histórico A/B/C conserva IDs, URL, publicación/recepción/contentRevision y snapshots. Un nuevo método o metadata añade revisiones; no rejuvenece publicaciones ni emite incidentes nuevos por indexar historia. Aumento del corpus por adquisición posterior no invalida aquel cierre ni demuestra que todas las identidades estén resueltas.

## Herramientas operativas disponibles — requieren alcance de ejecución

- `cd backend && npm start`: servidor y procesos hijos según .env; conservar llama.cpp. El backend permanece detenido al cierre documental.
- `npm run situations:maintain`: consulta el estado sin escribir. `-- --apply --max-pages=N` procesa páginas explícitamente con StorageManager y guardia de propietario; no ejecutar otro escritor junto al backend. Pausa/reanudación durables. No se utilizó en esta actualización documental.
- `npm run news:enrich`: consulta el cursor del método actual; `-- --apply` enriquece por páginas si existe trabajo autorizado. No repetir el baseline completado ni modificar métodos sólo para reconstruir todo.
- MCP: inventario generado JSON/Markdown1.12.0; operador limitado para imports/revisiones. Un catálogo de chat en caché se refresca; eso no demuestra fallo del servidor MCP. Sin backend, fallo de conexión es esperado.

Reversión: conservar esquema 029 y escrituras nuevas, pausar capacidades/proyecciones si hace falta y corregir con nuevas revisiones. No editar migraciones aplicadas, borrar evidencia o volver a la base original dañada. Backup manual según responsabilidad acordada. Publicación/merge/despliegue y promoción requieren su alcance específico.
