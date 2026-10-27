# Estado del producto y condiciones de entrega final

Actualizado **27/10/2026**, después de publicar D y cerrar PID 988930. Entrada única: [ESTADO.md](ESTADO.md). Evidencia de implementación: [CIERRE-D.md](CIERRE-D.md); última ejecución: [EJECUCION-D-2026-10-27.md](EJECUCION-D-2026-10-27.md). Este documento organiza pendientes; no declara el producto completo ni autoriza ejecutarlos por sí solo.

## Estado alcanzado

Código **df50aae**, [CI 40499019337 correcta](https://github.com/Santiagovargas32/ogid/actions/runs/40499019337), contrato **1.12.0**, esquema efectivo **029**. A–D implementadas y publicadas; recuperación exacta y alineación de instalaciones cerradas. Backend/UI/MCP probados con npm start y base recuperada; el último backend está detenido limpiamente. Datos y desconocidos actuales en ESTADO, no en cifras antiguas del punto 2.

**Cierre técnico de D separado de aceptación operativa:** el último corte tiene **distancia de secuencias news pendiente 16.337**, 68 rechazos del correlador por tamaño y commits/checkpoints de varios segundos. No se han solucionado por redactar estos MD. El backend estuvo disponible en las 71 muestras del observador, pero éste acabó interrumpido tras ~1 h 10 min 40 s; faltan 24 h y evaluación semántica IA. Cinco intentos completados no bastan para aprobar utilidad.

## Entregas frente al diagnóstico

| Entrega | Implementado/verificado | Pendiente real |
|---|---|---|
| 0 · Base operativa | Identidad de artefactos/instalación/contrato/esquema, escritor único, mantenimiento determinista y recuperación; dependencias alineadas | **0.2:** costes y coordinación bajo carga, rechazos de tamaño y aceptación operativa; no reabrir backups/forense sin indicios nuevos |
| A · Identidad/clasificación | 9cbdef2, EN/ES/FR/DE/PT, aliases exactos, modalidades, orden y revisiones; baseline histórico completado | Ampliar identidades/texto permitido en E y evaluar por idioma/casos; unknown/unsupported no son severidad baja |
| B · Fuentes/cobertura | 9a3aa2f, evaluaciones/perfiles versionados, importador, medidor y facetas; UI real verificada | Datos documentados y permitidos: **0 evaluaciones / 0 perfiles** en el corte actual. La adquisición no los calcula automáticamente. Medir salud/cobertura real con E |
| C · Comparaciones/afirmaciones | 40a027d, agrupación candidata, revisión merge/split/origen y afirmaciones exactas; índice histórico poblado | Evaluación editorial ampliada; ni grupo ni sindicación acreditan independencia/ocurrencia |
| D · Situaciones/motor | **df50aae**, consumidores/outbox/awareness, situaciones/incidentes, cortes/correcciones/ACK, API/MCP/UI; >500/reinicio/ACK perdido probados | **Mantener consumo bajo adquisición concurrente y medir latencia/backlog**; cerrar pendientes de integración sin perder historia. No está pendiente desarrollar otra vez D |
| E · Piloto/fuentes | Matriz y ámbitos Ucrania/Mar Negro y mar Rojo definidos | Registro/perfiles/enriquecimiento permitido y accesos verificables; medir fechas/lugares, duplicación, origen, cobertura y latencia. RU/UK con evaluación propia |
| F · Analista/impactos | Runtime/modelo y módulos analíticos previos disponibles en shadow | Integrar síntesis/cronologías/impactos sobre situaciones/evidencia elegible; correcciones y números/citas trazables; evaluar por tarea |
| Final | Suites y CI progresivas, smoke y observación corta con cierre limpio | Candidato final identificado, contratos/UI/rendimiento integrados y **24 h continuas**, más puerta semántica IA independiente |

## Orden de trabajo y criterios de cierre

Secuencia confirmada: **D → E → F → validación final**, con pruebas por entrega. La integración D/0.2 observada se atiende dentro de la continuación, sin reiniciar entregas ni hacer otra recuperación.

1. **Lote acotado operativo D/0.2:** reproducir backlog y registro del correlador con datos/referencias acotados. Separar cola, SQL, commit y checkpoint y declarar hardware/carga/cohortes. Revisar la cadencia del consumidor junto a snapshots/analítica y el tamaño enviado al escritor. Cerrar con consumo sostenido medido, correcciones/reinicio/ACK preservados y persistencia del correlador dentro de su contrato. No cambiar guardias ni saltar cursores para obtener verde.
2. **E:** nutrir identidades y perfiles documentados, aplicar nuevos métodos versionados a históricos mediante páginas cuando proceda y ejecutar los dos pilotos. Cualquier incorporación de evaluaciones conserva metodología/contexto/referencias y permiso de uso; sin dataset, «sin evaluar» sigue válido. El análisis político automático no está implementado ni queda autorizado por tener más noticias.
3. **F:** síntesis, cronologías e impactos con incertidumbre/citas exactas y correcciones propagadas. Revisar fallos de número/evidencia/formato/lease; mantener reparación única. Toda probabilidad requiere modelo evaluado; no confundir atribución con hecho.
4. **Pruebas integradas y puertas finales:** comprobar superficies cambiadas durante cada lote. Al terminar código, fijar identidad de candidato/instalaciones/esquema/contratos y observar24h continuas sin cambiar sus artefactos. Conservar shadow hasta aceptación semántica por tarea; v19 y la observación D interrumpidas no cierran esta puerta.

No repetir suites completas, npm ci, enriquecimiento ni controles de recuperación ya cerrados salvo cambios/fallos o dudas justificadas. Editar MD sólo exige coherencia/enlaces/inventarios, no otra suite de backend ni reiniciar la app.

## Dependencias e históricos: lo cerrado y su procedencia

Las8+1 discrepancias iniciales procedían de locks publicados durante un shadow activo, conservando entonces instalaciones antiguas. No eran nueve dependencias añadidas por C. El commit **fd1652247892483e332148d9428d709318706ad2** cerró ese lote con instalaciones verificadas y enriquecimiento de **146.475** noticias. La recuperación y los checkpoints completos anteriores se conservan en HISTORICO-CONTINUIDAD/RECUPERACION y en Git; no volver a tratarlos como pendientes.

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
